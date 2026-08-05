import type { Cents } from "../money.js";
import type { Ulid } from "../ids.js";
import type { MonthKey } from "../time.js";
import { compareMonth, monthKeyOf, monthRange } from "../time.js";
import type { Category, LoadedBudget } from "../model/types.js";
import {
  categoriesByGroup,
  groupKindByCategory,
  mapCreditCards,
} from "./creditCards.js";
import type { CategoryMonthView, GroupMonthView, MonthView } from "./types.js";

/**
 * Pure envelope-budget engine.
 *
 * Recurrence (per category, per month, in month order):
 *   activity(c,m)  = Σ signed amounts of c's lines whose effectiveDate is in m
 *   available(c,m) = available(c,m-1) + assigned(c,m) + activity(c,m)
 *   readyToAssign(m) = Σ_{k≤m} income(k) − Σ_{k≤m, all budgetable c} assigned(c,k)
 *
 * Credit cards (full envelope-style auto-move): a credit-card purchase categorized to
 * a spending category reduces that category (normal activity) AND moves the same
 * amount into the card's payment category — so the money you budgeted is set aside
 * to pay the card. Paying the card (a transfer into the card account) draws the
 * payment category back down. Net effect on total available is zero for a purchase
 * (money moves category→category) and negative for a payment (money leaves to
 * retire debt). See `paymentActivity` below.
 *
 * v1 carryover simplification: `available` carries forward in full, including
 * negatives (money is conserved exactly). The classic extra rule — cash overspend
 * resets to 0 and reduces next month's Ready-to-Assign, while only credit
 * overspend rolls negative — is deferred; overspent cells are still flagged in the
 * UI. This keeps the recurrence a single clean line and is validated against the
 * exported plan numbers.
 */

type Series = Map<MonthKey, number>;

const GENERAL_HH = "General";

function bump<K>(map: Map<K, Series>, key: K, month: MonthKey, delta: number): void {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Map()));
  s.set(month, (s.get(month) ?? 0) + delta);
}

function bumpMonth(s: Series, month: MonthKey, delta: number): void {
  s.set(month, (s.get(month) ?? 0) + delta);
}

export interface Projection {
  months: MonthKey[];
  monthView(month: MonthKey): MonthView;
  /** All-time signed balance per account. */
  accountBalances(): Map<Ulid, Cents>;
  /** Low-level accessors (used by tests/oracle). */
  assignedOf(categoryId: Ulid, month: MonthKey): Cents;
  activityOf(categoryId: Ulid, month: MonthKey): Cents;
  availableOf(categoryId: Ulid, month: MonthKey): Cents;
  readyToAssignOf(month: MonthKey): Cents;
  /** Ready-to-Assign split by household (sums to readyToAssignOf). */
  readyToAssignByHousehold(month: MonthKey): Map<string, Cents>;
  /** Households present, in stable order. */
  households: string[];
}

export function computeProjection(budget: LoadedBudget): Projection {
  const kind = groupKindByCategory(budget);
  const cc = mapCreditCards(budget);
  const catsByGroup = categoriesByGroup(budget);

  const isIncome = (categoryId: Ulid): boolean => kind.get(categoryId) === "income";
  const isPayment = (categoryId: Ulid): boolean => cc.paymentCategoryIds.has(categoryId);

  // --- Gather raw sums --------------------------------------------------------
  const activity = new Map<Ulid, Series>(); // spending + payment categories
  const cardActivityByCat = new Map<Ulid, Series>(); // of `activity`, the part spent on cards
  const income: Series = new Map();
  const cardSpend = new Map<Ulid, Series>(); // signed categorized spend on each card
  const cardTransfer = new Map<Ulid, Series>(); // signed transfer legs on each card
  const balances = new Map<Ulid, number>();

  const monthsSeen = new Set<MonthKey>();
  const onBudget = new Set<Ulid>();
  for (const a of budget.accounts) if (a.onBudget) onBudget.add(a.id);

  // Household attribution: income + cross-household transfers by the account's
  // household; assigned by the category's (group's) household.
  const incomeByHh = new Map<string, Series>();
  const crossTransferByHh = new Map<string, Series>();
  const accountById = new Map(budget.accounts.map((a) => [a.id, a]));
  const hhOfAccount = (id: Ulid): string => accountById.get(id)?.household ?? GENERAL_HH;
  const hhOfCategory = new Map<Ulid, string>();
  {
    const groupHh = new Map<Ulid, string>(budget.groups.map((g) => [g.id, g.household ?? GENERAL_HH]));
    for (const c of budget.categories) hhOfCategory.set(c.id, groupHh.get(c.groupId) ?? GENERAL_HH);
  }

  for (const t of budget.transactions) {
    // Unapproved (scheduled/future) transactions are pending: they affect nothing
    // until approved.
    if (!t.approved) continue;

    balances.set(t.accountId, (balances.get(t.accountId) ?? 0) + t.amount);

    // Off-budget (tracking) accounts never touch envelopes, income, or card math.
    if (!onBudget.has(t.accountId)) continue;

    const m = monthKeyOf(t.effectiveDate);
    monthsSeen.add(m);

    if (t.transfer) {
      // Transfer leg: no category activity. Relevant only if it hits a card,
      // or if it crosses households — then it moves assignable money between the
      // two household pools (out of the sender, into the receiver). Both legs are
      // counted so the movement nets to zero globally and money is conserved.
      if (cc.cardAccountIds.has(t.accountId)) bump(cardTransfer, t.accountId, m, t.amount);
      const counter = accountById.get(t.transfer.counterAccountId);
      if (counter && counter.onBudget && (counter.household ?? GENERAL_HH) !== hhOfAccount(t.accountId)) {
        bump(crossTransferByHh, hhOfAccount(t.accountId), m, t.amount);
      }
      continue;
    }

    const lines = t.splits ?? [{ categoryId: t.categoryId, amount: t.amount }];
    for (const line of lines) {
      if (!line.categoryId) {
        // Uncategorized money on a cash account — a starting balance or a stray
        // uncategorized deposit — is Ready-to-Assign income. Cards are skipped:
        // their opening balance is debt, not assignable income.
        if (!cc.cardAccountIds.has(t.accountId)) {
          bumpMonth(income, m, line.amount);
          bump(incomeByHh, hhOfAccount(t.accountId), m, line.amount);
        }
        continue;
      }
      if (isIncome(line.categoryId)) {
        bumpMonth(income, m, line.amount);
        bump(incomeByHh, hhOfAccount(t.accountId), m, line.amount);
        continue;
      }
      // Normal spending or (unusually) a directly-categorized payment line.
      bump(activity, line.categoryId, m, line.amount);
      if (cc.cardAccountIds.has(t.accountId) && !isPayment(line.categoryId)) {
        bump(cardSpend, t.accountId, m, line.amount);
        bump(cardActivityByCat, line.categoryId, m, line.amount);
      }
    }
  }

  // Payment-category activity is derived from card flows, not transactions.
  for (const [cardId, paymentCatId] of cc.paymentCategoryByCard) {
    const spend = cardSpend.get(cardId);
    const xfer = cardTransfer.get(cardId);
    const months = new Set<MonthKey>([...(spend?.keys() ?? []), ...(xfer?.keys() ?? [])]);
    for (const m of months) {
      // moved-in = −spend (a purchase is negative → positive reserve);
      // payment = −transferIntoCard (an inflow to the card draws the reserve down).
      const delta = -(spend?.get(m) ?? 0) - (xfer?.get(m) ?? 0);
      bump(activity, paymentCatId, m, delta);
      monthsSeen.add(m);
    }
  }

  // --- Assignments ------------------------------------------------------------
  const assigned = new Map<Ulid, Series>();
  const assignedByHh = new Map<string, Series>();
  for (const a of budget.assignments) {
    bump(assigned, a.categoryId, a.month, a.assigned);
    bump(assignedByHh, hhOfCategory.get(a.categoryId) ?? GENERAL_HH, a.month, a.assigned);
    monthsSeen.add(a.month);
  }

  // --- Global month range -----------------------------------------------------
  const sortedMonths = [...monthsSeen].sort(compareMonth);
  const months =
    sortedMonths.length === 0
      ? []
      : monthRange(sortedMonths[0]!, sortedMonths[sortedMonths.length - 1]!);

  // --- Available carryover per budgetable category ---------------------------
  // Overspend rule (matches the source budgeting app): a spending envelope that
  // ends a month negative splits its shortfall by HOW it was overspent.
  //   • Cash overspend — cash/checking spending beyond the envelope — cannot roll
  //     forward: it is covered from Ready-to-Assign (recorded per household and
  //     applied to the FOLLOWING month) and the envelope restarts at zero.
  //   • Credit overspend — the part driven by card spending — is debt: it rolls
  //     forward as a negative envelope (mirrored by the card's payment reserve)
  //     and never touches Ready-to-Assign.
  // Credit-card PAYMENT envelopes themselves are exempt; a negative there is the
  // card debt itself and always carries.
  const budgetable = budget.categories.filter((c) => !isIncome(c.id));
  const available = new Map<Ulid, Series>();
  const overspendByHh = new Map<string, Series>();
  for (const c of budgetable) {
    const s: Series = new Map();
    const exempt = isPayment(c.id);
    const hh = hhOfCategory.get(c.id) ?? GENERAL_HH;
    let prev = 0;
    for (const m of months) {
      const cardAct = cardActivityByCat.get(c.id)?.get(m) ?? 0;
      const cashAct = (activity.get(c.id)?.get(m) ?? 0) - cardAct;
      const afterAssign = prev + (assigned.get(c.id)?.get(m) ?? 0);
      const afterCash = afterAssign + cashAct;
      const val = afterCash + cardAct;
      s.set(m, val);
      if (val < 0 && !exempt) {
        // Cash overspend = the ADDITIONAL shortfall this month's cash spending
        // creates, beyond any negative already carried in (that carried negative
        // is prior credit debt, not fresh cash overspend). Everything else — old
        // debt plus this month's uncovered card spend — carries forward.
        const cashOverspend = Math.min(-val, Math.max(0, -afterCash) - Math.max(0, -afterAssign));
        if (cashOverspend > 0) bump(overspendByHh, hh, m, -cashOverspend);
        prev = val + cashOverspend; // remove cash overspend, carry the rest as debt
      } else {
        prev = val;
      }
    }
    available.set(c.id, s);
  }

  // --- Ready to Assign per household ------------------------------------------
  // Each household is its own money pool. RTA(m) = cumulative(income + funding
  // received from another household) − cumulative(assigned). The two source
  // budgets accounted for cross-household funding differently (the receiver as
  // income, the sender as an assigned funding category), so we honour both: the
  // receiver's inflow leg funds it here, and the sender's assignment already
  // reduced the sender above. The global banner is the sum across households.
  const presentHouseholds = new Set<string>([
    ...budget.groups.map((g) => g.household ?? GENERAL_HH),
    ...budget.accounts.map((a) => a.household ?? GENERAL_HH),
  ]);
  const pref = budget.budget.householdOrder ?? [];
  const households = [
    ...pref.filter((h) => presentHouseholds.has(h)),
    ...[...presentHouseholds].filter((h) => !pref.includes(h)).sort(),
  ];
  const rtaByHh = new Map<string, Series>();
  for (const h of households) {
    const s: Series = new Map();
    let cumIn = 0;
    let cumAssigned = 0;
    let cumOverspend = 0; // cash overspend from PRIOR months (it lags a month)
    const inc = incomeByHh.get(h);
    const xfer = crossTransferByHh.get(h);
    const asg = assignedByHh.get(h);
    const over = overspendByHh.get(h);
    for (const m of months) {
      cumIn += (inc?.get(m) ?? 0) + (xfer?.get(m) ?? 0);
      cumAssigned += asg?.get(m) ?? 0;
      s.set(m, cumIn - cumAssigned + cumOverspend);
      cumOverspend += over?.get(m) ?? 0; // this month's overspend hits next month
    }
    rtaByHh.set(h, s);
  }

  // --- Global Ready to Assign (sum across household pools) --------------------
  const rta: Series = new Map();
  for (const m of months) {
    let sum = 0;
    for (const h of households) sum += rtaByHh.get(h)?.get(m) ?? 0;
    rta.set(m, sum);
  }

  // --- Accessors --------------------------------------------------------------
  const assignedOf = (categoryId: Ulid, month: MonthKey): Cents =>
    (assigned.get(categoryId)?.get(month) ?? 0) as Cents;
  const activityOf = (categoryId: Ulid, month: MonthKey): Cents =>
    (activity.get(categoryId)?.get(month) ?? 0) as Cents;
  const availableOf = (categoryId: Ulid, month: MonthKey): Cents =>
    (available.get(categoryId)?.get(month) ?? 0) as Cents;
  const readyToAssignOf = (month: MonthKey): Cents => (rta.get(month) ?? 0) as Cents;
  const readyToAssignByHousehold = (month: MonthKey): Map<string, Cents> => {
    const out = new Map<string, Cents>();
    for (const h of households) out.set(h, (rtaByHh.get(h)?.get(month) ?? 0) as Cents);
    return out;
  };

  const catMonthView = (c: Category, month: MonthKey): CategoryMonthView => ({
    categoryId: c.id,
    assigned: assignedOf(c.id, month),
    activity: activityOf(c.id, month),
    available: availableOf(c.id, month),
  });

  const monthView = (month: MonthKey): MonthView => {
    const groups: GroupMonthView[] = [];
    const flat: CategoryMonthView[] = [];
    const sortedGroups = [...budget.groups]
      .filter((g) => g.kind !== "income")
      .sort((a, b) => a.sortOrder - b.sortOrder);

    for (const g of sortedGroups) {
      const cats = (catsByGroup.get(g.id) ?? []).map((c) => catMonthView(c, month));
      let ga = 0;
      let gact = 0;
      let gav = 0;
      for (const cv of cats) {
        ga += cv.assigned;
        gact += cv.activity;
        gav += cv.available;
        flat.push(cv);
      }
      groups.push({
        group: g,
        categories: cats,
        assigned: ga as Cents,
        activity: gact as Cents,
        available: gav as Cents,
      });
    }

    return { month, readyToAssign: readyToAssignOf(month), groups, flat };
  };

  const accountBalances = (): Map<Ulid, Cents> => {
    const out = new Map<Ulid, Cents>();
    for (const a of budget.accounts) out.set(a.id, (balances.get(a.id) ?? 0) as Cents);
    return out;
  };

  return {
    months,
    monthView,
    accountBalances,
    assignedOf,
    activityOf,
    availableOf,
    readyToAssignOf,
    readyToAssignByHousehold,
    households,
  };
}
