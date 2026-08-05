import { parseMoney, type CurrencyConfig } from "../money.js";
import { epochDay, parseImportDate, type ISODate } from "../time.js";
import type { ClearedStatus, FlagColor } from "../model/types.js";
import type { RawPlanRow, RawRegisterRow } from "./csv.js";

/** Normalized text for matching: NFC + trim + lowercase. Never shown to users. */
export function fold(s: string): string {
  return s.normalize("NFC").trim().toLowerCase();
}
/** Display-normalized text: NFC + trim (preserves original case). */
export function trimN(s: string): string {
  return s.normalize("NFC").trim();
}

export type RowKind = "withinTransfer" | "income" | "normal";

export interface NormTxn {
  sourceKey: string;
  account: string;
  accountFold: string;
  date: ISODate;
  epochDay: number;
  /** Whether the transaction is approved (false for future/scheduled rows). */
  approved: boolean;
  payee: string;
  payeeFold: string;
  group: string;
  groupFold: string;
  category: string;
  categoryFold: string;
  memo: string;
  /** Signed minor units: inflow positive, outflow negative. */
  amount: number;
  cleared: ClearedStatus;
  flag?: FlagColor;
  sourceRow: number;
  kind: RowKind;
  /** For split children: the "(n/m)" marker parsed from the memo. */
  split?: { n: number; m: number };
}

export interface NormPlan {
  sourceKey: string;
  month: string;
  group: string;
  groupFold: string;
  category: string;
  categoryFold: string;
  assigned: number;
  /** Exported activity/available, retained only as a reconciliation oracle. */
  activity: number;
  available: number;
  sourceRow: number;
}

const SPLIT_RE = /split\s*\((\d+)\/(\d+)\)/i;

function clearedOf(raw: string): ClearedStatus {
  switch (raw.trim().toLowerCase()) {
    case "cleared":
      return "cleared";
    case "reconciled":
      return "reconciled";
    default:
      return "uncleared";
  }
}

const FLAGS: Record<string, FlagColor> = {
  blue: "blue",
  green: "green",
  purple: "purple",
  red: "red",
  yellow: "yellow",
};

function flagOf(raw: string): FlagColor | undefined {
  return FLAGS[raw.trim().toLowerCase()];
}

function signedAmount(inflow: string, outflow: string, currency: CurrencyConfig): number {
  const inV = inflow.trim() ? parseMoney(inflow, currency) : 0;
  const outV = outflow.trim() ? parseMoney(outflow, currency) : 0;
  return inV - outV;
}

export interface NormalizeOptions {
  sourceKey: string;
  currency: CurrencyConfig;
  /** Rows dated after this are unapproved (scheduled). */
  exportDate: ISODate;
}

export function normalizeRegister(rows: RawRegisterRow[], opts: NormalizeOptions): NormTxn[] {
  const out: NormTxn[] = [];
  for (const r of rows) {
    const date = parseImportDate(r.date);
    const payeeFold = fold(r.payee);
    const groupFold = fold(r.group);
    const categoryFold = fold(r.category);
    const memo = trimN(r.memo);

    // A "Transfer :" payee is a within-budget transfer ONLY when it carries no
    // category. The source app forbids categorising a transfer between two budget
    // accounts, so a categorised transfer leg always involves an off-budget
    // (tracking) account — e.g. selling shares brings money into the budget as
    // "Ready to Assign" income, and buying shares is categorised spending. Those
    // must keep their category (and their income/activity effect), not be flattened
    // into a categoryless transfer.
    const isTransferPayee = /^transfer\s*:/i.test(r.payee.trim());
    let kind: RowKind = "normal";
    if (isTransferPayee && !categoryFold) kind = "withinTransfer";
    else if (groupFold === "inflow" || categoryFold === "ready to assign") kind = "income";

    const splitMatch = SPLIT_RE.exec(r.memo);
    const split = splitMatch
      ? { n: Number(splitMatch[1]), m: Number(splitMatch[2]) }
      : undefined;

    out.push({
      sourceKey: opts.sourceKey,
      account: trimN(r.account),
      accountFold: fold(r.account),
      date,
      epochDay: epochDay(date),
      approved: date <= opts.exportDate,
      payee: trimN(r.payee),
      payeeFold,
      group: trimN(r.group),
      groupFold,
      category: trimN(r.category),
      categoryFold,
      memo,
      amount: signedAmount(r.inflow, r.outflow, opts.currency),
      cleared: clearedOf(r.cleared),
      flag: flagOf(r.flag),
      sourceRow: r.sourceRow,
      kind,
      split,
    });
  }
  return out;
}

export function normalizePlan(
  rows: RawPlanRow[],
  opts: Pick<NormalizeOptions, "sourceKey" | "currency">,
): NormPlan[] {
  return rows.map((r) => ({
    sourceKey: opts.sourceKey,
    month: r.month, // parsed to MonthKey later in the plan stage
    group: trimN(r.group),
    groupFold: fold(r.group),
    category: trimN(r.category),
    categoryFold: fold(r.category),
    assigned: r.assigned.trim() ? parseMoney(r.assigned, opts.currency) : 0,
    activity: r.activity.trim() ? parseMoney(r.activity, opts.currency) : 0,
    available: r.available.trim() ? parseMoney(r.available, opts.currency) : 0,
    sourceRow: r.sourceRow,
  }));
}
