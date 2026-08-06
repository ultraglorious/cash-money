import type { Ulid } from "./ids.js";
import type { Cents } from "./money.js";
import { epochDay, type ISODate } from "./time.js";
import type { Transaction } from "./model/types.js";

/**
 * Credit-card invoice deduction: which card transactions has a payment
 * actually SETTLED? Appearing on the card's statement only proves a swipe
 * exists — payment happens later, when a transfer from a cash account pays
 * the previous billing period's invoice. The payment amount equals the sum
 * of the period's transactions exactly, which makes the period deducible:
 *
 *  - Payments are the budget's transfer legs INTO the card (positive amount).
 *  - For the newest payment, find a date-contiguous run of card activity
 *    ending shortly before the payment whose sum is exactly the payment.
 *  - Billing periods cut by BOOKING date while the budget stores true
 *    transaction dates, so rows within a few days of either boundary may be
 *    swapped in or out ("boundary permutation") to reach the exact sum.
 *  - On the owner's rule that no balance is ever carried, everything OLDER
 *    than a matched window was settled by earlier invoices — so one matched
 *    payment settles the window plus all prior activity. Rows newer than the
 *    window (and boundary rows pushed to the NEXT invoice) stay unsettled.
 *
 * Exact sum or nothing: if no window works for any payment, return null and
 * change no statuses. Newest payment is tried first; older ones are only
 * fallbacks (their coverage is a subset of what a newer match settles).
 */

/** Latest invoice cutoff: at most this many days before the payment date. */
const CUTOFF_MAX_DAYS = 45;
/** One billing period spans at most this many days of transaction dates. */
const PERIOD_MAX_DAYS = 70;
/** Boundary skew tolerance (true date vs booking date) in days. */
const EDGE_DAYS = 5;
/** Cap on boundary rows considered per attempt (subset-sum stays tiny). */
const MAX_EDGE_ITEMS = 12;

export interface InvoiceCoverage {
  paymentTxId: Ulid;
  paymentDate: ISODate;
  paymentAmount: Cents;
  /** Transaction-date span of the deduced billing window. */
  windowFrom: ISODate;
  windowTo: ISODate;
  /** Everything settled: the window, all earlier activity, earlier payments, and the payment itself. */
  covered: Ulid[];
}

export function deduceInvoiceCoverage(
  transactions: readonly Transaction[],
  accountId: Ulid,
): InvoiceCoverage | null {
  const rows = transactions
    .filter((t) => t.accountId === accountId && t.approved)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const isPayment = (t: Transaction): boolean => !!t.transfer && t.amount > 0;
  const spends = rows.filter((t) => !isPayment(t));
  const payments = rows.filter(isPayment);

  for (let p = payments.length - 1; p >= 0; p--) {
    const payment = payments[p]!;
    const window = matchWindow(spends, payment);
    if (!window) continue;

    const windowIdx = [...window].sort((a, b) => a - b);
    const maxIdx = windowIdx[windowIdx.length - 1]!;
    const endEpoch = epochDay(spends[maxIdx]!.date);
    const covered: Ulid[] = [];
    for (let k = 0; k <= maxIdx; k++) {
      // Rows inside the span but permuted OUT at the END edge belong to the
      // NEXT invoice — everything else up to the window's end is settled
      // (start-edge exclusions were settled by earlier invoices).
      if (!window.has(k) && endEpoch - epochDay(spends[k]!.date) <= EDGE_DAYS) continue;
      covered.push(spends[k]!.id);
    }
    for (const pay of payments) if (pay.date <= payment.date) covered.push(pay.id);

    return {
      paymentTxId: payment.id,
      paymentDate: payment.date,
      paymentAmount: payment.amount,
      windowFrom: spends[windowIdx[0]!]!.date,
      windowTo: spends[maxIdx]!.date,
      covered,
    };
  }
  return null;
}

/** Find a contiguous-by-date run (with boundary permutation) summing to the payment. */
function matchWindow(spends: readonly Transaction[], payment: Transaction): Set<number> | null {
  const target = -payment.amount;
  const pEpoch = epochDay(payment.date);

  for (let j = spends.length - 1; j >= 0; j--) {
    const jEpoch = epochDay(spends[j]!.date);
    if (jEpoch > pEpoch) continue; // newer than the payment: next invoice
    if (pEpoch - jEpoch > CUTOFF_MAX_DAYS) break;

    let core = 0;
    for (let i = j; i >= 0; i--) {
      if (jEpoch - epochDay(spends[i]!.date) > PERIOD_MAX_DAYS) break;
      core += spends[i]!.amount;
      if (core === target) return contiguous(i, j);
      const permuted = permuteBoundaries(spends, i, j, pEpoch, target - core);
      if (permuted) return permuted;
    }
  }
  return null;
}

function contiguous(i: number, j: number): Set<number> {
  const s = new Set<number>();
  for (let k = i; k <= j; k++) s.add(k);
  return s;
}

/**
 * Try to close the gap `residual` by toggling rows near the window's edges:
 * exclude in-window rows (their booking date fell in a neighbouring period)
 * or include just-outside rows (booked inside this one).
 */
function permuteBoundaries(
  spends: readonly Transaction[],
  i: number,
  j: number,
  paymentEpoch: number,
  residual: number,
): Set<number> | null {
  if (residual === 0) return contiguous(i, j);
  const startEpoch = epochDay(spends[i]!.date);
  const endEpoch = epochDay(spends[j]!.date);

  // Each candidate toggle: { idx, delta } where delta is the sum change.
  const candidates: Array<{ idx: number; delta: number }> = [];
  const nearEdge = (k: number): boolean => {
    const e = epochDay(spends[k]!.date);
    return Math.abs(e - startEpoch) <= EDGE_DAYS || Math.abs(e - endEpoch) <= EDGE_DAYS;
  };
  for (let k = i; k <= j && candidates.length < MAX_EDGE_ITEMS; k++) {
    if (nearEdge(k)) candidates.push({ idx: k, delta: -spends[k]!.amount });
  }
  for (let k = i - 1; k >= 0 && candidates.length < MAX_EDGE_ITEMS; k--) {
    if (startEpoch - epochDay(spends[k]!.date) > EDGE_DAYS) break;
    candidates.push({ idx: k, delta: spends[k]!.amount });
  }
  for (let k = j + 1; k < spends.length && candidates.length < MAX_EDGE_ITEMS; k++) {
    const e = epochDay(spends[k]!.date);
    if (e - endEpoch > EDGE_DAYS || e > paymentEpoch) break;
    candidates.push({ idx: k, delta: spends[k]!.amount });
  }
  if (candidates.length === 0) return null;

  for (let mask = 1; mask < 1 << candidates.length; mask++) {
    let sum = 0;
    for (let b = 0; b < candidates.length; b++) if (mask & (1 << b)) sum += candidates[b]!.delta;
    if (sum !== residual) continue;
    const window = contiguous(i, j);
    for (let b = 0; b < candidates.length; b++) {
      if (!(mask & (1 << b))) continue;
      const { idx } = candidates[b]!;
      window.has(idx) ? window.delete(idx) : window.add(idx);
    }
    return window;
  }
  return null;
}
