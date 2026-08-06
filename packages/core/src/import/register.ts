import Papa from "papaparse";
import { parseMoney, type CurrencyConfig } from "../money.js";
import { epochDay, type ISODate } from "../time.js";
import type { CategoryGroupKind, ClearedStatus, FlagColor } from "../model/types.js";
import type { ImportDateFormat, RegisterFormat } from "./format.js";
import { fold, trimN } from "./text.js";

/**
 * Format-driven register reading: one shared CSV parser, one date parser, and
 * the mapper that turns header-keyed rows into normalized transactions using a
 * `RegisterFormat` descriptor. Everything source-specific comes from the
 * descriptor — no format vocabulary lives in code.
 */

export interface ParsedCsv {
  headers: string[];
  /** Header-keyed cells, one record per data row (row 1 is the header line). */
  rows: Record<string, string>[];
}

/** Parse a CSV with a header line; strips a UTF-8 BOM and trims header names. */
export function parseCsv(text: string): ParsedCsv {
  const clean = text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const res = Papa.parse<Record<string, string>>(clean, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return { headers: res.meta.fields ?? [], rows: res.data };
}

/**
 * Parse a date cell in the declared layout into an ISO date. Accepts `-`, `/`,
 * or `.` separators and 2-digit years (assumed 20xx). The date may sit anywhere
 * inside the cell (some sources embed it in free text — e.g. a description
 * column mapped as the date); the first date-shaped token wins. Throws on
 * cells containing no date — callers collect the error per row.
 */
export function parseDateAs(raw: string, format: ImportDateFormat): ISODate {
  const s = raw.trim();
  if (format === "iso") {
    const m = /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/.exec(s);
    if (!m) throw new Error(`Bad ISO date: ${JSON.stringify(raw)}`);
    return `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`;
  }
  const m = /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?!\d)/.exec(s);
  if (!m) throw new Error(`Bad date: ${JSON.stringify(raw)}`);
  const a = Number(m[1]);
  const b = Number(m[2]);
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const day = format === "dmy" ? a : b;
  const month = format === "dmy" ? b : a;
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Bad date: ${JSON.stringify(raw)}`);
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(n: string | number): string {
  return String(n).padStart(2, "0");
}

/** Names in `required` that are missing from `headers`. */
export function requireColumns(headers: readonly string[], required: readonly string[]): string[] {
  const have = new Set(headers);
  return required.filter((c) => !have.has(c));
}

// ---- Format-driven row mapping ----------------------------------------------

export type RowKind = "withinTransfer" | "income" | "normal";

export interface NormTxn {
  sourceKey: string;
  account: string;
  accountFold: string;
  date: ISODate;
  /** The date column's value, when `date` was replaced by an extracted true date. */
  bookDate?: ISODate;
  epochDay: number;
  /** Whether the transaction is approved (false for future/scheduled rows). */
  approved: boolean;
  payee: string;
  payeeFold: string;
  group: string;
  groupFold: string;
  category: string;
  categoryFold: string;
  /** Semantics stamped at mapping time: what KIND of group this row's group is. */
  groupKind?: CategoryGroupKind;
  /** Whether this row's group imports hidden. */
  groupHidden?: boolean;
  memo: string;
  /** Signed minor units: inflow positive, outflow negative. */
  amount: number;
  cleared: ClearedStatus;
  flag?: FlagColor;
  sourceRow: number;
  kind: RowKind;
  /** For a within-budget transfer leg: the counterpart account's name. */
  counterAccount?: string;
  /** For split children: the "(n/m)" marker parsed from the memo. */
  split?: { n: number; m: number };
}

export interface MapRegisterOptions {
  sourceKey: string;
  currency: CurrencyConfig;
  /** Rows dated after this import as unapproved (scheduled). Absent = all approved. */
  exportDate?: ISODate;
  /** Force every row into this account (single-account statement files). */
  fixedAccount?: string;
}

export interface MapRegisterResult {
  rows: NormTxn[];
  /** Per-row problems (bad date, unparseable amount) and file-level ones (missing columns). */
  errors: string[];
}

function referencedColumns(format: RegisterFormat, opts: MapRegisterOptions): string[] {
  const cols = [format.date.column, format.payeeColumn];
  if (format.amount.mode === "signed") cols.push(format.amount.column);
  else cols.push(format.amount.inflowColumn, format.amount.outflowColumn);
  if (format.memoColumn) cols.push(format.memoColumn);
  if (format.accountColumn && !opts.fixedAccount) cols.push(format.accountColumn);
  if (format.category) {
    if (format.category.mode === "columns") {
      cols.push(format.category.categoryColumn);
      if (format.category.groupColumn) cols.push(format.category.groupColumn);
    } else {
      cols.push(format.category.column);
    }
  }
  if (format.clearedColumn) cols.push(format.clearedColumn);
  if (format.flagColumn) cols.push(format.flagColumn);
  if (format.transfer?.mode === "column") cols.push(format.transfer.column);
  return cols;
}

/**
 * Map header-keyed CSV rows into normalized transactions using a format
 * descriptor. Collects problems per row instead of throwing, so a wizard can
 * show them; snapshot imports treat any error as fatal.
 *
 * Cleared semantics: a source with no cleared column is taken as all-cleared
 * (the file IS the bank's/export's record); with a column, unmapped values are
 * conservative "uncleared".
 */
export function mapRegisterRows(
  parsed: ParsedCsv,
  format: RegisterFormat,
  opts: MapRegisterOptions,
): MapRegisterResult {
  const errors: string[] = [];
  const rows: NormTxn[] = [];

  const missing = requireColumns(parsed.headers, referencedColumns(format, opts));
  if (missing.length > 0) {
    return { rows, errors: [`Missing column(s): ${missing.join(", ")}`] };
  }
  if (!format.accountColumn && !opts.fixedAccount) {
    return { rows, errors: ["This format has no account column; an explicit target account is required."] };
  }

  const transferRe =
    format.transfer?.mode === "payeePattern" ? new RegExp(format.transfer.pattern, "i") : undefined;
  const splitRe = format.splitMemoPattern ? new RegExp(format.splitMemoPattern, "i") : undefined;
  const trueDateRe = format.trueDate ? new RegExp(format.trueDate.pattern, "i") : undefined;
  const sem = format.semantics;
  const incomeGroupFold = sem?.incomeGroup ? fold(sem.incomeGroup) : undefined;
  const incomeCategoryFold = sem?.incomeCategory ? fold(sem.incomeCategory) : undefined;
  const hiddenGroupFold = sem?.hiddenGroup ? fold(sem.hiddenGroup) : undefined;
  const ccGroupFold = sem?.creditCardPaymentsGroup ? fold(sem.creditCardPaymentsGroup) : undefined;

  const money = (cell: string | undefined): number =>
    cell && cell.trim() ? parseMoney(cell, opts.currency) : 0;

  parsed.rows.forEach((row, i) => {
    const sourceRow = i + 2; // row 1 is the header line
    try {
      const columnDate = parseDateAs(row[format.date.column] ?? "", format.date.format);
      // True-date extraction: some banks book days late but embed the real
      // transaction date in the description. On a match, the extracted date
      // becomes THE date and the column value is kept as bookDate.
      let date = columnDate;
      let bookDate: ISODate | undefined;
      if (trueDateRe && format.memoColumn) {
        const m = trueDateRe.exec(row[format.memoColumn] ?? "");
        if (m?.[1]) {
          const extracted = parseDateAs(m[1], format.trueDate!.format);
          if (extracted !== columnDate) {
            date = extracted;
            bookDate = columnDate;
          }
        }
      }

      let amount: number;
      if (format.amount.mode === "signed") {
        const v = money(row[format.amount.column]);
        amount = format.amount.outflowPositive ? -v : v;
      } else {
        amount = money(row[format.amount.inflowColumn]) - money(row[format.amount.outflowColumn]);
      }

      let group = "";
      let category = "";
      if (format.category) {
        if (format.category.mode === "columns") {
          group = format.category.groupColumn ? (row[format.category.groupColumn] ?? "") : "";
          category = row[format.category.categoryColumn] ?? "";
        } else {
          const cell = row[format.category.column] ?? "";
          const at = cell.indexOf(format.category.separator);
          group = at >= 0 ? cell.slice(0, at) : "";
          category = at >= 0 ? cell.slice(at + format.category.separator.length) : cell;
        }
      }
      const groupFold = fold(group);
      const categoryFold = fold(category);

      const payee = trimN(row[format.payeeColumn] ?? "");
      let kind: RowKind = "normal";
      let counterAccount: string | undefined;
      if (transferRe) {
        const m = transferRe.exec(payee);
        const applies =
          m && (format.transfer?.mode !== "payeePattern" || !format.transfer.onlyWhenUncategorized || !categoryFold);
        if (applies) {
          kind = "withinTransfer";
          counterAccount = (m[1] ?? "").trim();
        }
      } else if (format.transfer?.mode === "column") {
        const cell = (row[format.transfer.column] ?? "").trim();
        if (cell) {
          kind = "withinTransfer";
          counterAccount = cell;
        }
      }
      if (kind === "normal" && (groupFold && groupFold === incomeGroupFold || categoryFold && categoryFold === incomeCategoryFold)) {
        kind = "income";
      }

      const memoRaw = format.memoColumn ? (row[format.memoColumn] ?? "") : "";
      const splitMatch = splitRe?.exec(memoRaw);
      const split = splitMatch ? { n: Number(splitMatch[1]), m: Number(splitMatch[2]) } : undefined;

      const clearedCell = format.clearedColumn ? (row[format.clearedColumn] ?? "") : undefined;
      const cleared: ClearedStatus =
        clearedCell === undefined ? "cleared" : (format.clearedValues?.[fold(clearedCell)] ?? "uncleared");
      const flagCell = format.flagColumn ? (row[format.flagColumn] ?? "") : "";
      const flag: FlagColor | undefined = format.flagValues?.[fold(flagCell)];

      const account = opts.fixedAccount ?? trimN(row[format.accountColumn!] ?? "");

      rows.push({
        sourceKey: opts.sourceKey,
        account,
        accountFold: fold(account),
        date,
        bookDate,
        epochDay: epochDay(date),
        approved: opts.exportDate ? date <= opts.exportDate : true,
        payee,
        payeeFold: fold(payee),
        group: trimN(group),
        groupFold,
        category: trimN(category),
        categoryFold,
        groupKind: !groupFold
          ? undefined
          : groupFold === incomeGroupFold
            ? "income"
            : groupFold === ccGroupFold
              ? "creditCardPayments"
              : "normal",
        groupHidden: groupFold ? groupFold === hiddenGroupFold : undefined,
        memo: trimN(memoRaw),
        amount,
        cleared,
        flag,
        sourceRow,
        kind,
        counterAccount,
        split,
      });
    } catch (e) {
      errors.push(`Row ${sourceRow}: ${(e as Error).message}`);
    }
  });

  return { rows, errors };
}
