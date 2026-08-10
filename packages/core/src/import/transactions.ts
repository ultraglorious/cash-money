import type { NormTxn } from "./register.js";
import type { StagedLine, StagedTxn } from "./staged.js";
import { fold } from "./text.js";

/**
 * Builds staged transactions from normalized rows, reconstructing split
 * transactions. Splits are exported as consecutive child rows sharing
 * account/date/payee, each memo tagged "Split (n/m)"; there is no parent row.
 * We fold each run of children (n = 1..m) into one transaction whose amount is
 * the sum of its lines.
 */
export function buildStagedTransactions(norm: readonly NormTxn[]): StagedTxn[] {
  // Preserve source order so split runs stay contiguous.
  const rows = [...norm].sort((a, b) => a.sourceRow - b.sourceRow);
  const out: StagedTxn[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;

    if (r.split) {
      // Collect a contiguous split run.
      const run: NormTxn[] = [r];
      let j = i + 1;
      while (
        j < rows.length &&
        rows[j]!.split &&
        rows[j]!.accountFold === r.accountFold &&
        rows[j]!.date === r.date &&
        rows[j]!.payeeFold === r.payeeFold &&
        run.length < r.split.m
      ) {
        run.push(rows[j]!);
        j++;
      }
      out.push(makeSplit(run, r.split.m));
      i = j - 1;
      continue;
    }

    out.push(makeSimple(r));
  }

  return out;
}

function lineOf(r: NormTxn): StagedLine {
  return {
    group: r.group,
    groupFold: r.groupFold,
    category: r.category,
    categoryFold: r.categoryFold,
    groupKind: r.groupKind,
    groupHidden: r.groupHidden,
    amount: r.amount,
    memo: r.memo,
    isIncome: r.kind === "income",
  };
}

function makeSimple(r: NormTxn): StagedTxn {
  const lines = r.kind === "withinTransfer" ? [] : [lineOf(r)];
  return {
    sourceKey: r.sourceKey,
    account: r.account,
    accountFold: r.accountFold,
    date: r.date,
    bookDate: r.bookDate,
    effectiveDate: r.date,
    epochDay: r.epochDay,
    approved: r.approved,
    payee: r.payee,
    payeeFold: r.payeeFold,
    memo: r.memo,
    ...(r.counterparty ? { counterparty: r.counterparty } : {}),
    amount: r.amount,
    cleared: r.cleared,
    flag: r.flag,
    kind: r.kind === "withinTransfer" ? "withinTransfer" : r.kind,
    lines,
    ...(r.counterAccount ? { counterAccount: r.counterAccount, counterAccountFold: fold(r.counterAccount) } : {}),
    sourceRows: [r.sourceRow],
  };
}

function makeSplit(run: NormTxn[], expected: number): StagedTxn {
  const head = run[0]!;
  const lines = run.map(lineOf);
  const amount = lines.reduce((a, l) => a + l.amount, 0);
  const warnings: string[] = [];
  if (run.length !== expected) {
    warnings.push(`incomplete split: expected ${expected} lines, got ${run.length}`);
  }
  // A split is income only if every line is income (rare); otherwise treat as normal.
  const kind = lines.every((l) => l.isIncome) ? "income" : "normal";
  return {
    sourceKey: head.sourceKey,
    account: head.account,
    accountFold: head.accountFold,
    date: head.date,
    effectiveDate: head.date,
    epochDay: head.epochDay,
    approved: head.approved,
    payee: head.payee,
    payeeFold: head.payeeFold,
    memo: head.memo,
    ...(head.counterparty ? { counterparty: head.counterparty } : {}),
    amount,
    cleared: head.cleared,
    flag: head.flag,
    kind,
    lines,
    sourceRows: run.map((r) => r.sourceRow),
    ...(warnings.length ? { warnings } : {}),
  };
}
