import type { Cents } from "../money.js";
import type { Ulid } from "../ids.js";
import type { MonthKey } from "../time.js";
import { compareMonth, monthKeyOf, monthRange } from "../time.js";
import type { Category, LoadedBudget } from "../model/types.js";
import {
  categoriesByGroup,
  groupKindByCategory,
  mapCreditCards,
  type CreditCardMap,
} from "./creditCards.js";
import type { CategoryMonthView, GroupMonthView, MonthView } from "./types.js";

/**
 * Pure envelope-budget engine.
 *
 * Recurrence (per category, per month, in month order):
 *   activity(c,m)  = Σ signed amounts of c's lines whose effectiveDate is in m
 *   available(c,m) = carryover(c,m-1) + assigned(c,m) + activity(c,m)
 *
 * Ready-to-Assign is derived by CONSERVATION per household: a household's
 * assignable money is the cash in its non-card accounts (cumulative cash-account
 * movement) minus everything already sitting in its envelopes:
 *   readyToAssign(hh,m) = Σ cash-account movement(hh, ≤m) − Σ available(hh categories, m)
 * The global banner is the sum across households. Card debt and its payment reserve
 * net out, so this is exactly "what's left to assign".
 *
 * Credit cards (full envelope-style auto-move): a credit-card purchase moves the
 * COVERED amount (what the envelope could afford by month end) into the card's
 * payment envelope; the uncovered rest is debt on the card. Paying the card (a
 * transfer into it) draws the payment envelope back down.
 *
 * Overspend: an envelope that ends a month negative restarts at zero next month
 * (it never carries a red balance). A cash overspend then shows up as reduced
 * Ready-to-Assign automatically (the cash left the account but nothing holds it);
 * a credit overspend is simply left as card debt. Validated to the cent against
 * the exported plan numbers (activity and available match 100%).
 *
 * `computeProjection` orchestrates the phases below — each phase is a plain
 * function with an explicit signature so it can be reasoned about (and tested)
 * in isolation: gather → assignments → month range → available → Ready-to-Assign.
 */

type Series = Map<MonthKey, number>;

const GENERAL_HH = "General";

function bump<K>(map: Map<K, Series>, key: K, month: MonthKey, delta: number): void {
  let s = map.get(key);
  if (!s) map.set(key, (s = new Map()));
  s.set(month, (s.get(month) ?? 0) + delta);
}

/** One spend/refund line, for the credit-card + overspend walk. */
interface SpendEvent {
  amount: number;
  /** Set when the spend was made on a credit card. */
  cardId: Ulid | undefined;
  date: string;
}

interface CategoryPredicates {
  isIncome(categoryId: Ulid): boolean;
  isPayment(categoryId: Ulid): boolean;
}

// ---- Phase 0: household attribution -----------------------------------------

interface HouseholdIndex {
  hhOfAccount(id: Ulid): string;
  hhOfCategory: Map<Ulid, string>;
  /** Households present, ordered by budget.householdOrder then alphabetically. */
  households: string[];
}

function buildHouseholdIndex(budget: LoadedBudget): HouseholdIndex {
  const accountById = new Map(budget.accounts.map((a) => [a.id, a]));
  const hhOfAccount = (id: Ulid): string => accountById.get(id)?.household ?? GENERAL_HH;

  const groupHh = new Map<Ulid, string>(budget.groups.map((g) => [g.id, g.household ?? GENERAL_HH]));
  const hhOfCategory = new Map<Ulid, string>();
  for (const c of budget.categories) hhOfCategory.set(c.id, groupHh.get(c.groupId) ?? GENERAL_HH);

  const present = new Set<string>([
    ...budget.groups.map((g) => g.household ?? GENERAL_HH),
    ...budget.accounts.map((a) => a.household ?? GENERAL_HH),
  ]);
  const pref = budget.budget.householdOrder ?? [];
  const households = [
    ...pref.filter((h) => present.has(h)),
    ...[...present].filter((h) => !pref.includes(h)).sort(),
  ];

  return { hhOfAccount, hhOfCategory, households };
}

// ---- Phase 1: gather raw sums from transactions ------------------------------

interface RawSums {
  /** Categorized spend per (category, month); payment activity is added later. */
  activity: Map<Ulid, Series>;
  /** Signed transfer legs on each card (payments into it). */
  cardTransfer: Map<Ulid, Series>;
  /** All-time signed balance per account (by transaction date). */
  balances: Map<Ulid, number>;
  /** Per (category, month) spend/refund events for the credit-card walk. */
  events: Map<Ulid, Map<MonthKey, SpendEvent[]>>;
  /**
   * Per household, net cash-account movement each month (by effectiveDate).
   * Ready-to-Assign is derived from this by conservation: a household's
   * assignable money is the cash in its non-card accounts that isn't already
   * sitting in an envelope.
   */
  cashDeltaByHh: Map<string, Series>;
  monthsSeen: Set<MonthKey>;
}

function gatherTransactions(
  budget: LoadedBudget,
  cc: CreditCardMap,
  { isIncome, isPayment }: CategoryPredicates,
  hh: HouseholdIndex,
): RawSums {
  const activity = new Map<Ulid, Series>();
  const cardTransfer = new Map<Ulid, Series>();
  const balances = new Map<Ulid, number>();
  const events = new Map<Ulid, Map<MonthKey, SpendEvent[]>>();
  const cashDeltaByHh = new Map<string, Series>();
  const monthsSeen = new Set<MonthKey>();

  const addEvent = (categoryId: Ulid, month: MonthKey, e: SpendEvent): void => {
    let byMonth = events.get(categoryId);
    if (!byMonth) events.set(categoryId, (byMonth = new Map()));
    const arr = byMonth.get(month);
    if (arr) arr.push(e);
    else byMonth.set(month, [e]);
  };

  const onBudget = new Set<Ulid>();
  for (const a of budget.accounts) if (a.onBudget) onBudget.add(a.id);

  for (const t of budget.transactions) {
    // Unapproved (scheduled/future) transactions are pending: they affect nothing.
    if (!t.approved) continue;

    balances.set(t.accountId, (balances.get(t.accountId) ?? 0) + t.amount);

    // Off-budget (tracking) accounts never touch envelopes or the cash pool.
    if (!onBudget.has(t.accountId)) continue;

    const m = monthKeyOf(t.effectiveDate);
    monthsSeen.add(m);

    const onCard = cc.cardAccountIds.has(t.accountId);
    // Every cash-account movement (income, spending, transfers) feeds the
    // household's assignable-money pool. Card accounts are excluded: a card is
    // debt, tracked by its payment envelope, not assignable cash.
    if (!onCard) bump(cashDeltaByHh, hh.hhOfAccount(t.accountId), m, t.amount);

    if (t.transfer) {
      if (onCard) bump(cardTransfer, t.accountId, m, t.amount); // a payment into the card
      continue;
    }

    const lines = t.splits ?? [{ categoryId: t.categoryId, amount: t.amount }];
    for (const line of lines) {
      // Income / uncategorized lines matter only through the cash pool above.
      if (!line.categoryId || isIncome(line.categoryId)) continue;
      bump(activity, line.categoryId, m, line.amount);
      if (!isPayment(line.categoryId)) {
        addEvent(line.categoryId, m, {
          amount: line.amount,
          cardId: onCard ? t.accountId : undefined,
          date: t.effectiveDate,
        });
      }
    }
  }

  return { activity, cardTransfer, balances, events, cashDeltaByHh, monthsSeen };
}

// ---- Phase 2: assignments ----------------------------------------------------

/** Assigned per (category, month); adds assignment months to `monthsSeen`. */
function gatherAssignments(budget: LoadedBudget, monthsSeen: Set<MonthKey>): Map<Ulid, Series> {
  const assigned = new Map<Ulid, Series>();
  for (const a of budget.assignments) {
    bump(assigned, a.categoryId, a.month, a.assigned);
    monthsSeen.add(a.month);
  }
  return assigned;
}

/** The contiguous month range spanning everything seen. */
function monthRangeOf(monthsSeen: ReadonlySet<MonthKey>): MonthKey[] {
  const sorted = [...monthsSeen].sort(compareMonth);
  return sorted.length === 0 ? [] : monthRange(sorted[0]!, sorted[sorted.length - 1]!);
}

// ---- Phase 3: available per category (credit-card + overspend model) ---------

/**
 * Computes each category's available series. Spending envelopes walk their
 * spend events (phase 3a); the covered part of card purchases accumulates into
 * each card's payment reserve, whose derived activity is ADDED to
 * `raw.activity` (the payment envelopes' activity is derived, not transactional)
 * before the payment envelopes themselves are rolled forward (phase 3b).
 */
function computeAvailable(
  budget: LoadedBudget,
  months: readonly MonthKey[],
  assigned: Map<Ulid, Series>,
  raw: RawSums,
  cc: CreditCardMap,
  { isIncome, isPayment }: CategoryPredicates,
): Map<Ulid, Series> {
  // Phase 3a — spending envelopes. Walk each category's spends in date order. A
  // card purchase moves only the COVERED amount (what the envelope could afford at
  // that moment) into the card's payment envelope; the uncovered rest becomes debt
  // on the card itself. At month end an envelope that is negative — whether from
  // cash or card spending — restarts at zero (it never carries a red balance
  // forward). The conservation-based Ready-to-Assign then reflects a cash
  // overspend automatically, while a credit overspend is simply left as card debt.
  const available = new Map<Ulid, Series>();
  const coveredByCard = new Map<Ulid, Series>(); // amount each card purchase set aside to pay
  for (const c of budget.categories) {
    if (isIncome(c.id) || isPayment(c.id)) continue; // payment envelopes: phase 3b
    const s: Series = new Map();
    const eventsByMonth = raw.events.get(c.id);
    let prev = 0; // ≥ 0: overspend never carries a negative here
    for (const m of months) {
      const assignedV = assigned.get(c.id)?.get(m) ?? 0;
      const evs = eventsByMonth?.get(m) ?? [];
      let running = prev + assignedV;
      let funds = prev + assignedV; // envelope money available to cover spending this month
      const spends: SpendEvent[] = [];
      for (const e of evs) {
        running += e.amount;
        if (e.amount >= 0) funds += e.amount; // refund/inflow raises what can be covered
        else spends.push(e);
        // Card activity moves to/from the card's payment reserve: a purchase sets
        // its amount aside to pay, a refund draws the reserve back down.
        if (e.cardId) bump(coveredByCard, e.cardId, m, -e.amount);
      }
      s.set(m, running); // displayed available (may be negative within the month)
      // Whatever the envelope still couldn't fund at month end is CREDIT overspend
      // (judged month-end, so money assigned later in the month still counts). Undo
      // that part of the card reserve — it's unfunded debt on the card, not set aside.
      if (running < 0) {
        spends.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        let r = funds;
        for (const sp of spends) {
          const before = r;
          r += sp.amount;
          if (r < 0 && sp.cardId) {
            const uncovered = before > 0 ? -r : -sp.amount;
            bump(coveredByCard, sp.cardId, m, -uncovered);
          }
        }
      }
      prev = running < 0 ? 0 : running; // overspend resets to zero next month
    }
    available.set(c.id, s);
  }

  // Payment-envelope activity: the covered amounts moved in, less payments made.
  for (const [cardId, paymentCatId] of cc.paymentCategoryByCard) {
    const covered = coveredByCard.get(cardId);
    const xfer = raw.cardTransfer.get(cardId);
    const ms = new Set<MonthKey>([...(covered?.keys() ?? []), ...(xfer?.keys() ?? [])]);
    for (const m of ms) bump(raw.activity, paymentCatId, m, (covered?.get(m) ?? 0) - (xfer?.get(m) ?? 0));
  }

  // Phase 3b — payment envelopes carry their balance (money set aside to pay the card).
  for (const c of budget.categories) {
    if (!isPayment(c.id)) continue;
    const s: Series = new Map();
    let prev = 0;
    for (const m of months) {
      const val = prev + (assigned.get(c.id)?.get(m) ?? 0) + (raw.activity.get(c.id)?.get(m) ?? 0);
      s.set(m, val);
      prev = val;
    }
    available.set(c.id, s);
  }

  return available;
}

// ---- Phase 4: Ready-to-Assign by conservation ---------------------------------

interface RtaResult {
  rta: Series;
  rtaByHh: Map<string, Series>;
}

/**
 * Each household is its own money pool: its assignable money is the cash it
 * holds (cumulative cash-account movement) minus everything already sitting in
 * its envelopes. Card debt and its payment reserve net out, so the number is
 * exactly "what's left to assign". The global banner is the sum across
 * households.
 */
function computeReadyToAssign(
  budget: LoadedBudget,
  months: readonly MonthKey[],
  hh: HouseholdIndex,
  cashDeltaByHh: Map<string, Series>,
  available: Map<Ulid, Series>,
): RtaResult {
  // Σ available per (household, month).
  const availByHh = new Map<string, Series>();
  for (const c of budget.categories) {
    const s = available.get(c.id);
    if (!s) continue;
    const h = hh.hhOfCategory.get(c.id) ?? GENERAL_HH;
    for (const [m, v] of s) bump(availByHh, h, m, v);
  }

  const rtaByHh = new Map<string, Series>();
  for (const h of hh.households) {
    const s: Series = new Map();
    const cash = cashDeltaByHh.get(h);
    const avail = availByHh.get(h);
    let cumCash = 0;
    for (const m of months) {
      cumCash += cash?.get(m) ?? 0;
      s.set(m, cumCash - (avail?.get(m) ?? 0));
    }
    rtaByHh.set(h, s);
  }

  const rta: Series = new Map();
  for (const m of months) {
    let sum = 0;
    for (const h of hh.households) sum += rtaByHh.get(h)?.get(m) ?? 0;
    rta.set(m, sum);
  }

  return { rta, rtaByHh };
}

// ---- Orchestrator -------------------------------------------------------------

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
  const predicates: CategoryPredicates = {
    isIncome: (categoryId) => kind.get(categoryId) === "income",
    isPayment: (categoryId) => cc.paymentCategoryIds.has(categoryId),
  };

  const hh = buildHouseholdIndex(budget);
  const raw = gatherTransactions(budget, cc, predicates, hh);
  const assigned = gatherAssignments(budget, raw.monthsSeen);
  const months = monthRangeOf(raw.monthsSeen);
  const available = computeAvailable(budget, months, assigned, raw, cc, predicates);
  const { rta, rtaByHh } = computeReadyToAssign(budget, months, hh, raw.cashDeltaByHh, available);

  // --- Accessors --------------------------------------------------------------
  const assignedOf = (categoryId: Ulid, month: MonthKey): Cents =>
    (assigned.get(categoryId)?.get(month) ?? 0) as Cents;
  const activityOf = (categoryId: Ulid, month: MonthKey): Cents =>
    (raw.activity.get(categoryId)?.get(month) ?? 0) as Cents;
  const availableOf = (categoryId: Ulid, month: MonthKey): Cents =>
    (available.get(categoryId)?.get(month) ?? 0) as Cents;
  const readyToAssignOf = (month: MonthKey): Cents => (rta.get(month) ?? 0) as Cents;
  const readyToAssignByHousehold = (month: MonthKey): Map<string, Cents> => {
    const out = new Map<string, Cents>();
    for (const h of hh.households) out.set(h, (rtaByHh.get(h)?.get(month) ?? 0) as Cents);
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
    for (const a of budget.accounts) out.set(a.id, (raw.balances.get(a.id) ?? 0) as Cents);
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
    households: hh.households,
  };
}
