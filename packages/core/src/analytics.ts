import type { Ulid } from "./ids.js";
import type { Cents } from "./money.js";
import { compareMonth, epochDay, monthKeyOf, monthRange, type MonthKey } from "./time.js";
import type { LoadedBudget, Transaction } from "./model/types.js";

/**
 * Read-only aggregations behind the Analytics view. All of them share the same
 * ground rules:
 *  - approved transactions only (scheduled rows are plans, not history);
 *  - months come from `effectiveDate` (the month the money counts toward);
 *  - split parents contribute their LINES, so category math matches envelopes;
 *  - within-budget transfers are excluded from category/section/payee math
 *    (they cancel across accounts) but INCLUDED in per-account and net-worth
 *    math, where moving money genuinely changes the account.
 */

interface Line {
  categoryId?: Ulid;
  amount: number;
}

function linesOf(t: Transaction): Line[] {
  return t.splits ?? [{ categoryId: t.categoryId, amount: t.amount }];
}

/** Group labels, disambiguated: two households routinely share section names. */
function groupLabels(b: LoadedBudget): Map<Ulid, string> {
  const count = new Map<string, number>();
  for (const g of b.groups) count.set(g.name, (count.get(g.name) ?? 0) + 1);
  return new Map(
    b.groups.map((g) => [g.id, (count.get(g.name) ?? 0) > 1 && g.household ? `${g.name} (${g.household})` : g.name]),
  );
}

// ---- Household-to-household transfers ----------------------------------------

/** Days the two legs of a household contribution may sit apart. */
const HOUSEHOLD_TRANSFER_WINDOW = 10;

/**
 * Money moved BETWEEN households is deliberately recorded as income on the
 * receiving side and a categorised expense on the sending side — that's what
 * makes each household's Ready-to-Assign correct. But globally it never
 * entered or left the budget, and when the two legs straddle a month
 * boundary it fabricates a loss one month and a windfall the next. Detect
 * the pairs: an income-to-inflow row in one household matching an
 * equal-and-opposite categorised row in a DIFFERENT household within a few
 * days. Greedy nearest-date matching; each row pairs once.
 */
export function householdTransferIds(b: LoadedBudget): Set<Ulid> {
  const householdOf = new Map(b.accounts.filter((a) => a.onBudget).map((a) => [a.id, a.household]));
  const incomeGroups = new Set(b.groups.filter((g) => g.kind === "income").map((g) => g.id));
  const incomeCats = new Set(b.categories.filter((c) => incomeGroups.has(c.groupId)).map((c) => c.id));

  const eligible = (t: Transaction): boolean =>
    t.approved && !t.transfer && !t.splits && householdOf.has(t.accountId) && !!householdOf.get(t.accountId);
  const incomes = b.transactions.filter(
    (t) => eligible(t) && t.amount > 0 && !!t.categoryId && incomeCats.has(t.categoryId),
  );
  const expenses = b.transactions.filter(
    (t) => eligible(t) && t.amount < 0 && !!t.categoryId && !incomeCats.has(t.categoryId),
  );

  const paired = new Set<Ulid>();
  const usedExpense = new Set<Ulid>();
  for (const inc of incomes) {
    const incEpoch = epochDay(inc.date);
    const incHousehold = householdOf.get(inc.accountId);
    let best: Transaction | undefined;
    let bestDelta = Infinity;
    for (const exp of expenses) {
      if (usedExpense.has(exp.id) || exp.amount !== -inc.amount) continue;
      if (householdOf.get(exp.accountId) === incHousehold) continue; // must CROSS households
      const delta = Math.abs(epochDay(exp.date) - incEpoch);
      if (delta <= HOUSEHOLD_TRANSFER_WINDOW && delta < bestDelta) {
        best = exp;
        bestDelta = delta;
      }
    }
    if (best) {
      usedExpense.add(best.id);
      paired.add(inc.id);
      paired.add(best.id);
    }
  }
  return paired;
}

// ---- Cashflow (income vs spending per month) --------------------------------

export interface MonthlyCashflow {
  month: MonthKey;
  income: Cents;
  /** Positive number: money that left envelopes this month. */
  spending: Cents;
  net: Cents;
}

/**
 * Income vs spending per month across all on-budget accounts, gaps filled.
 * Global perspective: household-to-household transfers are netted out.
 */
export function monthlyCashflow(b: LoadedBudget): MonthlyCashflow[] {
  const onBudget = new Set(b.accounts.filter((a) => a.onBudget).map((a) => a.id));
  const incomeGroups = new Set(b.groups.filter((g) => g.kind === "income").map((g) => g.id));
  const incomeCats = new Set(b.categories.filter((c) => incomeGroups.has(c.groupId)).map((c) => c.id));
  const internal = householdTransferIds(b);

  const perMonth = new Map<MonthKey, { income: number; spending: number }>();
  for (const t of b.transactions) {
    if (!t.approved || !onBudget.has(t.accountId) || t.transfer || internal.has(t.id)) continue;
    const m = monthKeyOf(t.effectiveDate);
    const slot = perMonth.get(m) ?? { income: 0, spending: 0 };
    for (const line of linesOf(t)) {
      if (line.categoryId && incomeCats.has(line.categoryId)) slot.income += line.amount;
      else slot.spending -= line.amount; // outflows are negative
    }
    perMonth.set(m, slot);
  }
  const months = [...perMonth.keys()].sort(compareMonth);
  if (months.length === 0) return [];
  return monthRange(months[0]!, months[months.length - 1]!).map((month) => {
    const s = perMonth.get(month) ?? { income: 0, spending: 0 };
    return { month, income: s.income as Cents, spending: s.spending as Cents, net: (s.income - s.spending) as Cents };
  });
}

// ---- Net worth over time -----------------------------------------------------

export interface NetWorthPoint {
  month: MonthKey;
  total: Cents;
  cash: Cents;
  credit: Cents;
  tracking: Cents;
}

/** Cumulative end-of-month balances across ALL accounts, split by account type. */
export function netWorthSeries(b: LoadedBudget): NetWorthPoint[] {
  const typeOf = new Map(b.accounts.map((a) => [a.id, a.type]));
  const deltas = new Map<MonthKey, { cash: number; credit: number; tracking: number }>();
  for (const t of b.transactions) {
    if (!t.approved) continue;
    const m = monthKeyOf(t.effectiveDate);
    const slot = deltas.get(m) ?? { cash: 0, credit: 0, tracking: 0 };
    const type = typeOf.get(t.accountId);
    if (type === "creditCard") slot.credit += t.amount;
    else if (type === "tracking") slot.tracking += t.amount;
    else slot.cash += t.amount;
    deltas.set(m, slot);
  }
  const months = [...deltas.keys()].sort(compareMonth);
  if (months.length === 0) return [];
  let cash = 0;
  let credit = 0;
  let tracking = 0;
  return monthRange(months[0]!, months[months.length - 1]!).map((month) => {
    const d = deltas.get(month) ?? { cash: 0, credit: 0, tracking: 0 };
    cash += d.cash;
    credit += d.credit;
    tracking += d.tracking;
    return {
      month,
      total: (cash + credit + tracking) as Cents,
      cash: cash as Cents,
      credit: credit as Cents,
      tracking: tracking as Cents,
    };
  });
}

// ---- Grouped flows (waterfall + drill-down) ----------------------------------

export type FlowDimension = "account" | "section" | "category" | "payee";

export interface FlowFilter {
  from: MonthKey;
  to: MonthKey;
  accountId?: Ulid;
  groupId?: Ulid;
  categoryId?: Ulid;
}

export interface FlowNode {
  /** Dimension value id: account/group/category id, or the payee text. */
  key: string;
  label: string;
  amount: Cents;
}

export const UNCATEGORIZED = "__uncategorized__";
export const TRANSFERS = "__transfers__";

/**
 * Net flow in the month range grouped along one dimension, honouring narrower
 * filters from previous drill levels. Grouping by account keeps transfers
 * (money genuinely moved); the category-ish dimensions exclude them.
 */
export function flows(b: LoadedBudget, by: FlowDimension, f: FlowFilter): FlowNode[] {
  const groupOf = new Map(b.categories.map((c) => [c.id, c.groupId]));
  const accName = new Map(b.accounts.map((a) => [a.id, a.name]));
  const groupName = groupLabels(b);
  const catName = new Map(b.categories.map((c) => [c.id, c.name]));
  const onBudget = new Set(b.accounts.filter((a) => a.onBudget).map((a) => a.id));
  // Global category views net out household-to-household transfers; inside
  // one account (and in per-account totals) the money genuinely moved.
  const internal = by !== "account" && !f.accountId ? householdTransferIds(b) : new Set<Ulid>();

  const out = new Map<string, { label: string; amount: number }>();
  const add = (key: string, label: string, amount: number) => {
    const slot = out.get(key) ?? { label, amount: 0 };
    slot.amount += amount;
    out.set(key, slot);
  };

  for (const t of b.transactions) {
    if (!t.approved || internal.has(t.id)) continue;
    const m = monthKeyOf(t.effectiveDate);
    if (compareMonth(m, f.from) < 0 || compareMonth(m, f.to) > 0) continue;
    if (f.accountId && t.accountId !== f.accountId) continue;

    if (by === "account") {
      add(t.accountId, accName.get(t.accountId) ?? "—", t.amount);
      continue;
    }
    // Envelope-ish dimensions cover on-budget money unless the drill has
    // explicitly entered one account (which may be off-budget).
    if (!f.accountId && !onBudget.has(t.accountId)) continue;
    if (t.transfer) {
      // Transfers only surface when drilling INSIDE one account, where they
      // genuinely move that account's balance. A categorized outflow leg
      // (cross-household funding) falls through to its envelope instead.
      if (!t.categoryId) {
        if (f.accountId && by === "section" && !f.groupId) add(TRANSFERS, "(transfers)", t.amount);
        continue;
      }
      if (!f.accountId) continue; // globally the pair cancels either way
    }
    for (const line of linesOf(t)) {
      const groupId = line.categoryId ? groupOf.get(line.categoryId) : undefined;
      if (f.groupId && groupId !== f.groupId) continue;
      if (f.categoryId && line.categoryId !== f.categoryId) continue;
      if (by === "section") {
        if (groupId) add(groupId, groupName.get(groupId) ?? "—", line.amount);
        else add(UNCATEGORIZED, "(uncategorized)", line.amount);
      } else if (by === "category") {
        if (line.categoryId) add(line.categoryId, catName.get(line.categoryId) ?? "—", line.amount);
        else add(UNCATEGORIZED, "(uncategorized)", line.amount);
      } else {
        add(t.payee || "(no payee)", t.payee || "(no payee)", line.amount);
      }
    }
  }

  return [...out.entries()]
    .map(([key, v]) => ({ key, label: v.label, amount: v.amount as Cents }))
    .sort((a, b2) => b2.amount - a.amount);
}

// ---- Detail tree (account → section → category → payee) ----------------------

export interface DetailNode {
  key: string;
  label: string;
  total: Cents;
  monthly: Record<MonthKey, Cents>;
  children?: DetailNode[];
}

interface MutNode {
  label: string;
  total: number;
  monthly: Map<MonthKey, number>;
  children: Map<string, MutNode>;
}

/** Drillable net-flow tree over a month range: account → section → category → payee. */
export function detailTree(b: LoadedBudget, from: MonthKey, to: MonthKey): DetailNode[] {
  const groupOf = new Map(b.categories.map((c) => [c.id, c.groupId]));
  const accName = new Map(b.accounts.map((a) => [a.id, a.name]));
  const groupName = groupLabels(b);
  const catName = new Map(b.categories.map((c) => [c.id, c.name]));

  const roots = new Map<string, MutNode>();
  const descend = (parent: Map<string, MutNode>, key: string, label: string): MutNode => {
    let node = parent.get(key);
    if (!node) {
      node = { label, total: 0, monthly: new Map(), children: new Map() };
      parent.set(key, node);
    }
    return node;
  };

  for (const t of b.transactions) {
    if (!t.approved) continue;
    const m = monthKeyOf(t.effectiveDate);
    if (compareMonth(m, from) < 0 || compareMonth(m, to) > 0) continue;

    for (const line of linesOf(t)) {
      // A categorized transfer leg (cross-household funding) files under its
      // envelope; only bare transfer legs land in "(transfers)".
      const bareTransfer = !!t.transfer && !line.categoryId;
      const groupId = !bareTransfer && line.categoryId ? groupOf.get(line.categoryId) : undefined;
      const path: Array<[string, string]> = [
        [t.accountId, accName.get(t.accountId) ?? "—"],
        bareTransfer
          ? [TRANSFERS, "(transfers)"]
          : groupId
            ? [groupId, groupName.get(groupId) ?? "—"]
            : [UNCATEGORIZED, "(uncategorized)"],
        bareTransfer
          ? [TRANSFERS, "(transfers)"]
          : line.categoryId
            ? [line.categoryId, catName.get(line.categoryId) ?? "—"]
            : [UNCATEGORIZED, "(uncategorized)"],
        [t.payee || "(no payee)", t.payee || "(no payee)"],
      ];
      let level = roots;
      for (const [key, label] of path) {
        const node = descend(level, key, label);
        node.total += line.amount;
        const cur = node.monthly.get(m) ?? 0;
        node.monthly.set(m, cur + line.amount);
        level = node.children;
      }
    }
  }

  const freeze = (map: Map<string, MutNode>, depth: number): DetailNode[] =>
    [...map.entries()]
      .map(([key, n]) => ({
        key,
        label: n.label,
        total: n.total as Cents,
        monthly: Object.fromEntries([...n.monthly.entries()].map(([k, v]) => [k, v as Cents])),
        ...(depth < 3 ? { children: freeze(n.children, depth + 1) } : {}),
      }))
      .sort((a, b2) => Math.abs(b2.total) - Math.abs(a.total));
  return freeze(roots, 0);
}
