import { newId, type Fingerprint, type Ulid } from "../ids.js";
import type { Cents, CurrencyConfig } from "../money.js";
import { epochDay, type ISODate } from "../time.js";
import type { LoadedBudget, Transaction } from "../model/types.js";
import type { RegisterFormat } from "./format.js";
import { identifyStaged } from "./identity.js";
import { mapRegisterRows, parseCsv } from "./register.js";
import { fold } from "./text.js";
import { buildStagedTransactions } from "./transactions.js";

/**
 * Statement reconciliation: match a single-account CSV (a bank's own export)
 * against what the budget already holds, instead of blindly importing. The
 * budget's rows may carry the TRUE transaction date (banks book days later),
 * renamed payees, and several same-visit swipes squashed into one row — all of
 * which defeat naive content matching. Validated against real data, the passes
 * below explain ~100% of a real statement:
 *
 *   0. identity   — rows added by a previous reconcile of this source.
 *   1. exact      — 1:1 on exact amount, date within ±1 day (true date first;
 *                    formats can extract it from the description via
 *                    `format.trueDate`). Ties are interchangeable and flagged.
 *   2. combo      — one budget row = the sum of 2..4 statement rows from the
 *                    same ±1-day window (same-visit squashes; single-merchant
 *                    combos preferred).
 *   3. wide       — exact amount within ±5 days, accepted only when the amount
 *                    is unique on BOTH sides in that span (e.g. an order placed
 *                    days before the card was charged).
 *   4. churn      — a charge and its equal-and-opposite refund from the same
 *                    payee within ±5 days, both unmatched: net zero, typically
 *                    never recorded in the budget on purpose.
 *
 * Whatever remains is `toAdd` — rows the budget genuinely lacks. Nothing is
 * merged automatically: the caller shows the buckets and commits only the rows
 * the user confirms (see `buildStatementTransactions`). Matched budget rows are
 * NOT rewritten (their provenance may belong to a snapshot source; overwriting
 * it would break snapshot re-imports) — re-running the same statement simply
 * re-derives the same matches, and committed `toAdd` rows identity-match via
 * pass 0.
 */

export interface StatementRow {
  /** True transaction date when extractable, else the booking date. */
  date: ISODate;
  /** The booking date, when it differs from `date`. */
  bookDate?: ISODate;
  amount: Cents;
  payee: string;
  memo: string;
  sourceRow: number;
  naturalKey: Fingerprint;
  occurrenceIndex: number;
  identity: Fingerprint;
}

export type MatchKind = "identity" | "exact" | "combo" | "wide";

export interface StatementMatch {
  kind: MatchKind;
  /** The budget transaction these statement rows explain. */
  txId: Ulid;
  rows: StatementRow[];
  /** |days| between the statement row's date and the budget row's. */
  deltaDays: number;
  /** exact only: several identical candidates tied — the pairing is arbitrary but harmless. */
  interchangeable?: boolean;
  /** combo only: every row in the combo is from the same merchant. */
  sameMerchant?: boolean;
}

export interface ChurnPair {
  charge: StatementRow;
  refund: StatementRow;
}

export interface StatementReconcile {
  matches: StatementMatch[];
  churn: ChurnPair[];
  /** Statement rows the budget has no counterpart for — candidates to add. */
  toAdd: StatementRow[];
  /** Budget rows in the window no statement row claimed (informational). */
  unclaimedBudget: Ulid[];
  /** Net-change integrity check over the statement's window. */
  check: { statementNet: Cents; budgetNet: Cents; from: ISODate; to: ISODate };
  parsedRows: number;
  /** Per-row parse problems; these rows were skipped. */
  errors: string[];
}

export interface StatementOptions {
  /** Stable per-account source key (persisted by the app; keeps identities stable). */
  sourceKey: string;
  accountId: Ulid;
  currency: CurrencyConfig;
}

const EXACT_WINDOW = 1;
const WIDE_WINDOW = 5;
const CHURN_WINDOW = 5;
const MAX_COMBO = 4;

export function reconcileStatement(
  budget: LoadedBudget,
  csvText: string,
  format: RegisterFormat,
  opts: StatementOptions,
): StatementReconcile {
  const account = budget.accounts.find((a) => a.id === opts.accountId);
  if (!account) throw new Error(`No such account: ${opts.accountId}`);

  const mapped = mapRegisterRows(parseCsv(csvText), format, {
    sourceKey: opts.sourceKey,
    currency: opts.currency,
    fixedAccount: account.name,
  });
  const staged = buildStagedTransactions(mapped.rows);
  const rows: StatementRow[] = identifyStaged(staged).map(({ t, naturalKey, occurrenceIndex, identity }) => ({
    date: t.date,
    bookDate: t.bookDate,
    amount: t.amount as Cents,
    payee: t.payee,
    memo: t.memo,
    sourceRow: t.sourceRows[0]!,
    naturalKey,
    occurrenceIndex,
    identity,
  }));

  if (rows.length === 0) {
    return {
      matches: [],
      churn: [],
      toAdd: [],
      unclaimedBudget: [],
      check: { statementNet: 0 as Cents, budgetNet: 0 as Cents, from: "", to: "" },
      parsedRows: 0,
      errors: mapped.errors,
    };
  }

  const dates = rows.map((r) => r.date).sort();
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  // Candidates: the account's actuals in the statement's window, padded by the
  // wide-match distance — a purchase ordered days before the statement starts
  // can still be its first row's counterpart. Scheduled rows are plans, not
  // statement material. The net check covers this same padded window.
  const fromEpoch = epochDay(from) - WIDE_WINDOW;
  const toEpoch = epochDay(to) + WIDE_WINDOW;
  const candidates = budget.transactions.filter((t) => {
    if (t.accountId !== opts.accountId || !t.approved) return false;
    const e = epochDay(t.date);
    return e >= fromEpoch && e <= toEpoch;
  });

  const claimed = new Set<Ulid>();
  const matchedRows = new Set<StatementRow>();
  const matches: StatementMatch[] = [];

  // ---- Pass 0: identity (rows a previous reconcile committed) ----------------
  const byIdentity = new Map<string, Transaction>();
  for (const t of candidates) if (t.source?.identity) byIdentity.set(t.source.identity, t);
  for (const r of rows) {
    const t = byIdentity.get(r.identity);
    if (t && !claimed.has(t.id)) {
      claimed.add(t.id);
      matchedRows.add(r);
      matches.push({ kind: "identity", txId: t.id, rows: [r], deltaDays: 0 });
    }
  }

  // ---- Pass 1: 1:1 exact amount, ±1 day --------------------------------------
  for (const r of rows) {
    if (matchedRows.has(r)) continue;
    const rEpoch = epochDay(r.date);
    const cands = candidates
      .filter((t) => !claimed.has(t.id) && t.amount === r.amount)
      .map((t) => ({ t, delta: Math.abs(epochDay(t.date) - rEpoch) }))
      .filter((c) => c.delta <= EXACT_WINDOW)
      .sort((a, b) => a.delta - b.delta);
    if (cands.length === 0) continue;
    const best = cands[0]!;
    const tied = cands.filter((c) => c.delta === best.delta).length > 1;
    claimed.add(best.t.id);
    matchedRows.add(r);
    matches.push({ kind: "exact", txId: best.t.id, rows: [r], deltaDays: best.delta, interchangeable: tied });
  }

  // ---- Pass 2: same-visit combos (2..4 rows → one budget row) -----------------
  const unmatchedAfter1 = (): StatementRow[] => rows.filter((r) => !matchedRows.has(r));
  for (const t of candidates) {
    if (claimed.has(t.id)) continue;
    const tEpoch = epochDay(t.date);
    const pool = unmatchedAfter1().filter((r) => Math.abs(epochDay(r.date) - tEpoch) <= EXACT_WINDOW);
    if (pool.length < 2 || pool.length > 12) continue;
    let best: StatementRow[] | null = null;
    for (let mask = 1; mask < 1 << pool.length; mask++) {
      const subset: StatementRow[] = [];
      for (let i = 0; i < pool.length; i++) if (mask & (1 << i)) subset.push(pool[i]!);
      if (subset.length < 2 || subset.length > MAX_COMBO) continue;
      if (subset.reduce((a, r) => a + r.amount, 0) !== t.amount) continue;
      const oneMerchant = new Set(subset.map((r) => fold(r.payee))).size === 1;
      if (!best || (oneMerchant && new Set(best.map((r) => fold(r.payee))).size > 1)) best = subset;
    }
    if (best) {
      claimed.add(t.id);
      for (const r of best) matchedRows.add(r);
      matches.push({
        kind: "combo",
        txId: t.id,
        rows: best,
        deltaDays: 0,
        sameMerchant: new Set(best.map((r) => fold(r.payee))).size === 1,
      });
    }
  }

  // ---- Pass 3: unique-amount wide window (order date vs charge date) ---------
  for (const r of rows) {
    if (matchedRows.has(r)) continue;
    const rEpoch = epochDay(r.date);
    const cands = candidates
      .filter((t) => !claimed.has(t.id) && t.amount === r.amount)
      .map((t) => ({ t, delta: Math.abs(epochDay(t.date) - rEpoch) }))
      .filter((c) => c.delta <= WIDE_WINDOW);
    if (cands.length !== 1) continue; // must be unique on the budget side
    const twin = rows.some(
      (o) => o !== r && !matchedRows.has(o) && o.amount === r.amount && Math.abs(epochDay(o.date) - rEpoch) <= WIDE_WINDOW * 2,
    );
    if (twin) continue; // ...and on the statement side
    const only = cands[0]!;
    claimed.add(only.t.id);
    matchedRows.add(r);
    matches.push({ kind: "wide", txId: only.t.id, rows: [r], deltaDays: only.delta });
  }

  // ---- Pass 4: charge/refund churn -------------------------------------------
  const churn: ChurnPair[] = [];
  const remaining = (): StatementRow[] => rows.filter((r) => !matchedRows.has(r));
  for (const charge of remaining()) {
    if (charge.amount >= 0 || matchedRows.has(charge)) continue;
    const cEpoch = epochDay(charge.date);
    const refund = remaining().find(
      (r) =>
        r !== charge &&
        r.amount === -charge.amount &&
        fold(r.payee) === fold(charge.payee) &&
        Math.abs(epochDay(r.date) - cEpoch) <= CHURN_WINDOW,
    );
    if (refund) {
      matchedRows.add(charge);
      matchedRows.add(refund);
      churn.push({ charge, refund });
    }
  }

  const toAdd = rows.filter((r) => !matchedRows.has(r));
  const unclaimedBudget = candidates.filter((t) => !claimed.has(t.id)).map((t) => t.id);
  const statementNet = rows.reduce((a, r) => a + r.amount, 0) as Cents;
  const budgetNet = candidates.reduce((a, t) => a + t.amount, 0) as Cents;

  return {
    matches,
    churn,
    toAdd,
    unclaimedBudget,
    check: { statementNet, budgetNet, from, to },
    parsedRows: rows.length,
    errors: mapped.errors,
  };
}

/** Turn confirmed statement rows into transactions on the target account. */
export function buildStatementTransactions(
  rows: readonly StatementRow[],
  opts: StatementOptions,
): Transaction[] {
  const asOf = rows.reduce((max, r) => (r.date > max ? r.date : max), "0000-00-00");
  return rows.map((r) => ({
    id: newId(),
    accountId: opts.accountId,
    date: r.date,
    effectiveDate: r.date,
    payee: r.payee,
    memo: r.memo,
    amount: r.amount,
    cleared: "reconciled" as const, // straight from the bank's own record
    approved: true, // statements are historical actuals
    source: {
      sourceBudget: opts.sourceKey,
      naturalKey: r.naturalKey,
      occurrenceIndex: r.occurrenceIndex,
      identity: r.identity,
      firstSeenExportTs: asOf,
      lastSeenExportTs: asOf,
    },
  }));
}
