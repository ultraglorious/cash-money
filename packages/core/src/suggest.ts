import type { Projection } from "./engine/compute.js";
import type { Ulid } from "./ids.js";
import type { Cents } from "./money.js";
import type { MonthKey } from "./time.js";
import { addMonths } from "./time.js";

/**
 * What to put in an envelope this month, proposed from what you already did.
 *
 * Filling a budget is mostly answering "the same as usual?", so the answers
 * worth offering are the ones history already knows: what you assigned last
 * month, what you actually spent, the recent averages, and the amount that
 * lands this envelope exactly on zero (which covers an overspend, or hands a
 * surplus back to Ready-to-Assign).
 *
 * Amounts are what `assigned` would BECOME, not deltas — the caller can pass
 * one straight to `ops.setAssigned`. Only months the budget actually covers are
 * averaged, so a three-month average in a two-month-old budget says two.
 */
export type AssignSuggestionKey =
  | "lastMonth"
  | "spentLastMonth"
  | "averageAssigned"
  | "averageSpent"
  /** Take back this month's assignment: assigned → 0. */
  | "resetAssigned"
  /** Land the envelope on empty: assigned → assigned − available. */
  | "resetAvailable";

export interface AssignSuggestion {
  key: AssignSuggestionKey;
  /** The value `assigned` would take. */
  amount: Cents;
  /** For the averages: how many months of real history went into it. */
  months?: number;
}

const AVERAGE_MONTHS = 3;

/** Spending is negative activity; inflows (refunds) don't count as spending. */
const spentIn = (p: Projection, categoryId: Ulid, month: MonthKey): number =>
  Math.max(0, -p.activityOf(categoryId, month));

export function assignSuggestions(
  p: Projection,
  categoryId: Ulid,
  month: MonthKey,
  opts: { averageMonths?: number } = {},
): AssignSuggestion[] {
  const window = opts.averageMonths ?? AVERAGE_MONTHS;
  const known = new Set(p.months);
  const history: MonthKey[] = [];
  for (let i = 1; i <= window; i++) {
    const m = addMonths(month, -i);
    if (known.has(m)) history.push(m);
  }

  const out: AssignSuggestion[] = [];
  const push = (key: AssignSuggestionKey, amount: number, months?: number) => {
    if (amount !== 0) out.push({ key, amount: amount as Cents, ...(months === undefined ? {} : { months }) });
  };

  const prev = history[0];
  if (prev === addMonths(month, -1)) {
    push("lastMonth", p.assignedOf(categoryId, prev));
    push("spentLastMonth", spentIn(p, categoryId, prev));
  }

  if (history.length > 1) {
    const mean = (f: (m: MonthKey) => number) => Math.round(history.reduce((s, m) => s + f(m), 0) / history.length);
    push("averageAssigned", mean((m) => p.assignedOf(categoryId, m)), history.length);
    push("averageSpent", mean((m) => spentIn(p, categoryId, m)), history.length);
  }

  // The two resets. Both stay useful at an amount of 0 — that IS the point of
  // them — so they're offered whenever they would actually move something.
  //
  //  - resetAssigned takes back what you put in this month, leaving whatever
  //    carried in from last month alone.
  //  - resetAvailable empties the envelope: it covers an overspend, or claws a
  //    surplus back to Ready-to-Assign, which needs a NEGATIVE assignment when
  //    the surplus came from an earlier month.
  //
  // When nothing has carried in and nothing has been spent they are the same
  // action, so only one of them is worth showing.
  const assigned = p.assignedOf(categoryId, month);
  const available = p.availableOf(categoryId, month);
  if (assigned !== 0) out.push({ key: "resetAssigned", amount: 0 as Cents });
  if (available !== 0 && available !== assigned) {
    out.push({ key: "resetAvailable", amount: (assigned - available) as Cents });
  }

  return out;
}
