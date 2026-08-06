import type { Ulid } from "./ids.js";
import type { Cents } from "./money.js";
import { epochDay, type ISODate } from "./time.js";
import type { Transaction } from "./model/types.js";

/**
 * Credit-card invoice deduction: which card transactions has a payment
 * actually SETTLED? Appearing on the card's statement only proves a swipe
 * exists — payment happens later, when a transfer from a cash account pays
 * the previous billing period's invoice, and the payment amount equals the
 * sum of the period's transactions exactly.
 *
 * A single exact-sum window is NOT proof: with boundary permutation there
 * can be a coincidental alternative subset that also sums to the payment
 * (observed in practice — a window shifted a week late still hit the amount).
 * What kills coincidences is that invoices TILE: each billing period starts
 * exactly where the previous one ended. So coverage is only accepted when a
 * CHAIN of consecutive payments matches, every window consuming exactly the
 * rows left over by the one before it — one coincidence cannot survive the
 * next payment's equation.
 *
 *  - Payments are the budget's transfer legs INTO the card (positive amount).
 *  - The first window of a chain may start anywhere (history begins
 *    mid-stream); every later window must consume the unused-row prefix.
 *  - Billing periods cut by BOOKING date while the budget stores true
 *    transaction dates, so rows within a few days of a window's end may be
 *    swapped in or out ("boundary permutation") to reach the exact sum;
 *    rows permuted out belong to the NEXT window and must be consumed by it.
 *  - On the owner's rule that no balance is ever carried, everything OLDER
 *    than the chain's first window was settled by earlier invoices.
 *  - Longest chain ending at the newest matchable payment wins; a chain
 *    shorter than MIN_CHAIN is rejected (unless history has a single
 *    payment, where tiling has nothing to check against).
 *
 * Exact sums or nothing: if no acceptable chain exists, return null and
 * change no statuses.
 */

/** A window must end at most this many days before its payment. */
const CUTOFF_MAX_DAYS = 45;
/** One billing period spans at most this many days of transaction dates. */
const PERIOD_MAX_DAYS = 70;
/** Boundary skew tolerance (true date vs booking date) in days. */
const EDGE_DAYS = 5;
/** Cap on boundary rows per permutation attempt (subset-sum stays tiny). */
const MAX_EDGE_ITEMS = 12;
/** Consecutive payments that must agree before coverage is believed. */
const MIN_CHAIN = 2;
/** Longest chain worth building (older history is settled by rule anyway). */
const MAX_CHAIN = 6;
/** Alternative windows explored per chain step. */
const MAX_CANDIDATES_PER_STEP = 8;
/** Hard search budget for one deduce call: DFS steps and permutation masks. */
const MAX_DFS_NODES = 2000;
const MAX_WORK = 5_000_000;

export interface InvoiceCoverage {
  /** Newest payment of the matched chain. */
  paymentTxId: Ulid;
  paymentDate: ISODate;
  paymentAmount: Cents;
  /** Transaction-date span of the newest payment's billing window. */
  windowFrom: ISODate;
  windowTo: ISODate;
  /** How many consecutive payments tiled exactly (confidence). */
  chainLength: number;
  /** Everything settled: chain windows, all earlier activity, and payments up to the newest matched one. */
  covered: Ulid[];
}

interface Candidate {
  members: number[];
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
  if (payments.length === 0 || spends.length === 0) return null;

  const minChain = Math.min(MIN_CHAIN, payments.length);
  const work = { left: MAX_WORK };
  for (let e = payments.length - 1; e >= 0 && work.left > 0; e--) {
    for (let s = Math.max(0, e - MAX_CHAIN + 1); s <= e - minChain + 1 && work.left > 0; s++) {
      const chain = tryChain(spends, payments, s, e, work);
      if (!chain) continue;

      const usedIdx = [...chain.used].sort((a, b) => a - b);
      const first = usedIdx[0]!;
      const covered: Ulid[] = [];
      for (let k = 0; k < first; k++) covered.push(spends[k]!.id); // settled by earlier invoices
      for (const k of usedIdx) covered.push(spends[k]!.id);
      for (const pay of payments) if (pay.date <= payments[e]!.date) covered.push(pay.id);

      return {
        paymentTxId: payments[e]!.id,
        paymentDate: payments[e]!.date,
        paymentAmount: payments[e]!.amount,
        windowFrom: chain.lastWindowFrom,
        windowTo: chain.lastWindowTo,
        chainLength: e - s + 1,
        covered,
      };
    }
  }
  return null;
}

/** Tile windows for payments s..e; every window after the first consumes the unused prefix. */
function tryChain(
  spends: readonly Transaction[],
  payments: readonly Transaction[],
  s: number,
  e: number,
  work: { left: number },
): { used: Set<number>; lastWindowFrom: ISODate; lastWindowTo: ISODate } | null {
  let nodes = 0;
  const step = (
    used: Set<number>,
    p: number,
  ): { used: Set<number>; lastWindowFrom: ISODate; lastWindowTo: ISODate } | null => {
    if (++nodes > MAX_DFS_NODES || work.left <= 0) return null;
    const cands = windowCandidates(spends, used, payments[p]!, p === s, work);
    for (const c of cands) {
      const nextUsed = new Set(used);
      for (const k of c.members) nextUsed.add(k);
      // The chain's first window starts mid-history: everything OLDER was
      // settled by pre-chain invoices, so it leaves the pool here — later
      // windows must tile from this point, not from the dawn of the account.
      if (p === s) {
        const firstMember = Math.min(...c.members);
        for (let k = 0; k < firstMember; k++) nextUsed.add(k);
      }
      if (p === e) {
        const sorted = [...c.members].sort((a, b) => a - b);
        return {
          used: nextUsed,
          lastWindowFrom: spends[sorted[0]!]!.date,
          lastWindowTo: spends[sorted[sorted.length - 1]!]!.date,
        };
      }
      const res = step(nextUsed, p + 1);
      if (res) return res;
    }
    return null;
  };
  return step(new Set<number>(), s);
}

/** Candidate windows for one payment given already-consumed rows. */
function windowCandidates(
  spends: readonly Transaction[],
  used: Set<number>,
  payment: Transaction,
  freeStart: boolean,
  work: { left: number },
): Candidate[] {
  const target = -payment.amount;
  const pEpoch = epochDay(payment.date);
  const pool: number[] = [];
  for (let k = 0; k < spends.length; k++) if (!used.has(k)) pool.push(k);
  if (pool.length === 0) return [];

  const out: Candidate[] = [];
  const starts = freeStart ? poolStartCandidates(spends, pool, pEpoch) : [0];
  for (const startPos of starts) {
    if (work.left <= 0) break;
    const startEpoch = epochDay(spends[pool[startPos]!]!.date);
    let core = 0;
    for (let m = startPos; m < pool.length && out.length < MAX_CANDIDATES_PER_STEP; m++) {
      const idx = pool[m]!;
      const dEpoch = epochDay(spends[idx]!.date);
      if (dEpoch > pEpoch || dEpoch - startEpoch > PERIOD_MAX_DAYS) break;
      core += spends[idx]!.amount;
      if (pEpoch - dEpoch > CUTOFF_MAX_DAYS) continue; // window may not END this far from the payment

      if (core === target) {
        out.push({ members: pool.slice(startPos, m + 1) });
        continue;
      }
      const permuted = permuteEdges(spends, pool, startPos, m, pEpoch, target - core, freeStart, work);
      if (permuted) out.push(permuted);
    }
    if (out.length >= MAX_CANDIDATES_PER_STEP) break;
  }
  return out;
}

/**
 * Free-start positions: pool rows that could begin a period ending near the
 * payment, most plausible first (a period is roughly cutoff-gap + one month
 * before the payment; try starts closest to that).
 */
function poolStartCandidates(spends: readonly Transaction[], pool: number[], pEpoch: number): number[] {
  const starts: number[] = [];
  for (let pos = 0; pos < pool.length; pos++) {
    const d = epochDay(spends[pool[pos]!]!.date);
    if (d > pEpoch) break;
    if (pEpoch - d <= CUTOFF_MAX_DAYS + PERIOD_MAX_DAYS) starts.push(pos);
  }
  const expected = pEpoch - 40;
  return starts.sort(
    (a, b) =>
      Math.abs(epochDay(spends[pool[a]!]!.date) - expected) - Math.abs(epochDay(spends[pool[b]!]!.date) - expected),
  );
}

/**
 * Close the gap `residual` by toggling rows near the window's edges. The end
 * edge is always permutable (booking-date skew pushes rows to the next
 * invoice); the start edge only for free-start windows — tiled windows MUST
 * consume the prefix they were handed.
 */
function permuteEdges(
  spends: readonly Transaction[],
  pool: number[],
  startPos: number,
  endPos: number,
  paymentEpoch: number,
  residual: number,
  freeStart: boolean,
  work: { left: number },
): Candidate | null {
  if (work.left <= 0) return null;
  const startEpoch = epochDay(spends[pool[startPos]!]!.date);
  const endEpoch = epochDay(spends[pool[endPos]!]!.date);

  const candidates: Array<{ pos: number; delta: number }> = [];
  for (let q = startPos; q <= endPos && candidates.length < MAX_EDGE_ITEMS; q++) {
    const d = epochDay(spends[pool[q]!]!.date);
    const nearEnd = Math.abs(d - endEpoch) <= EDGE_DAYS;
    const nearStart = freeStart && Math.abs(d - startEpoch) <= EDGE_DAYS;
    if (nearEnd || nearStart) candidates.push({ pos: q, delta: -spends[pool[q]!]!.amount });
  }
  for (let q = endPos + 1; q < pool.length && candidates.length < MAX_EDGE_ITEMS; q++) {
    const d = epochDay(spends[pool[q]!]!.date);
    if (d - endEpoch > EDGE_DAYS || d > paymentEpoch) break;
    candidates.push({ pos: q, delta: spends[pool[q]!]!.amount });
  }
  if (freeStart) {
    for (let q = startPos - 1; q >= 0 && candidates.length < MAX_EDGE_ITEMS; q--) {
      const d = epochDay(spends[pool[q]!]!.date);
      if (startEpoch - d > EDGE_DAYS) break;
      candidates.push({ pos: q, delta: spends[pool[q]!]!.amount });
    }
  }
  if (candidates.length === 0) return null;
  // Cheap bound: even toggling everything one way can't bridge the gap.
  let reach = 0;
  for (const c of candidates) reach += Math.abs(c.delta);
  if (Math.abs(residual) > reach) return null;

  const masks = 1 << candidates.length;
  work.left -= masks;
  for (let mask = 1; mask < masks; mask++) {
    let sum = 0;
    for (let b = 0; b < candidates.length; b++) if (mask & (1 << b)) sum += candidates[b]!.delta;
    if (sum !== residual) continue;
    const members = new Set<number>();
    for (let q = startPos; q <= endPos; q++) members.add(pool[q]!);
    for (let b = 0; b < candidates.length; b++) {
      if (!(mask & (1 << b))) continue;
      const idx = pool[candidates[b]!.pos]!;
      members.has(idx) ? members.delete(idx) : members.add(idx);
    }
    return { members: [...members] };
  }
  return null;
}
