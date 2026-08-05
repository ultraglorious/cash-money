import { newId, type Ulid } from "../ids.js";
import type { Cents, CurrencyConfig } from "../money.js";
import type { LoadedBudget, Transaction } from "../model/types.js";
import type { RegisterFormat } from "./format.js";
import { identifyStaged } from "./identity.js";
import { mapRegisterRows, parseCsv } from "./register.js";
import { mergeStatement, type StatementMergeReport } from "./reconcile.js";
import { buildStagedTransactions } from "./transactions.js";

/**
 * Statement import: a single-account CSV (typically a bank's own export) merged
 * into an EXISTING budget. Rows become plain transactions on the target account
 * — uncategorized, approved, cleared per the format — carrying full content
 * identity, so re-importing the same or an overlapping statement is a no-op for
 * rows already present. Transfer/category information a statement format may
 * declare is intentionally ignored here: linking against an existing budget's
 * accounts and categories is a separate, riskier problem than recording actuals.
 *
 * Occurrence-index caveat: identical same-day rows are told apart by their order
 * in the file. Banks are consistent about a day's order across exports in
 * practice; a bank that reorders them could make one such row look new. That
 * exposure is inherited from content-based identity (and existed in the old
 * fingerprint dedupe too).
 */

export interface StatementOptions {
  /**
   * Stable source key for this (account, format) pairing — persisted by the app
   * and reused on every import into the account, which is what keeps identities
   * stable across statements.
   */
  sourceKey: string;
  /** The existing account the statement belongs to. */
  accountId: Ulid;
  currency: CurrencyConfig;
}

export interface StatementReport extends StatementMergeReport {
  /** Rows successfully parsed from the file. */
  parsedRows: number;
  /** Per-row parse problems (bad dates, amounts); these rows were skipped. */
  errors: string[];
}

export interface StatementResult {
  /** The budget's full transaction list with the statement merged in. */
  merged: Transaction[];
  report: StatementReport;
}

export function stageStatement(
  budget: LoadedBudget,
  csvText: string,
  format: RegisterFormat,
  opts: StatementOptions,
): StatementResult {
  const account = budget.accounts.find((a) => a.id === opts.accountId);
  if (!account) throw new Error(`No such account: ${opts.accountId}`);

  const mapped = mapRegisterRows(parseCsv(csvText), format, {
    sourceKey: opts.sourceKey,
    currency: opts.currency,
    fixedAccount: account.name,
  });
  const staged = buildStagedTransactions(mapped.rows);
  const identified = identifyStaged(staged);

  // Provenance timestamp: the statement covers up to its newest row.
  const asOf = staged.reduce((max, t) => (t.date > max ? t.date : max), "0000-00-00");

  const incoming: Transaction[] = identified.map(({ t, naturalKey, occurrenceIndex, identity }) => ({
    id: newId(),
    accountId: opts.accountId,
    date: t.date,
    effectiveDate: t.effectiveDate,
    payee: t.payee,
    memo: t.memo,
    amount: t.amount as Cents,
    cleared: t.cleared,
    approved: true, // statements are historical actuals
    ...(t.flag ? { flag: t.flag } : {}),
    source: {
      sourceBudget: opts.sourceKey,
      naturalKey,
      occurrenceIndex,
      identity,
      firstSeenExportTs: asOf,
      lastSeenExportTs: asOf,
    },
  }));

  const { merged, report } = mergeStatement(budget.transactions, incoming, opts.accountId);
  return { merged, report: { ...report, parsedRows: mapped.rows.length, errors: mapped.errors } };
}
