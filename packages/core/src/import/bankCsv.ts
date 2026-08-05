import Papa from "papaparse";
import { parseMoney, type Cents, type CurrencyConfig } from "../money.js";
import { type ISODate } from "../time.js";
import { fingerprint } from "../ids.js";
import type { Transaction } from "../model/types.js";

/**
 * Import of a bank's own exported statement CSV (arbitrary columns) into a
 * single account. Distinct from the budget-export merge pipeline: here the user
 * maps columns, and rows become plain uncategorized transactions, de-duplicated
 * against what the account already has.
 */

export interface BankParseResult {
  headers: string[];
  rows: Record<string, string>[];
}

export function parseBankCsv(text: string): BankParseResult {
  const clean = text.length > 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const res = Papa.parse<Record<string, string>>(clean, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return { headers: res.meta.fields ?? [], rows: res.data };
}

export type BankDateFormat = "iso" | "dmy" | "mdy";

export type AmountMapping =
  | { mode: "single"; column: string; outflowPositive?: boolean }
  | { mode: "split"; inflowColumn: string; outflowColumn: string };

export interface BankMapping {
  dateColumn: string;
  dateFormat: BankDateFormat;
  payeeColumn: string;
  memoColumn?: string;
  amount: AmountMapping;
}

export interface BankDraft {
  date: ISODate;
  payee: string;
  memo: string;
  /** Signed minor units: inflow positive, outflow negative. */
  amount: Cents;
  sourceRow: number;
}

/** Parse a date cell in one of the supported layouts into an ISO date. */
export function parseBankDate(raw: string, format: BankDateFormat): ISODate {
  const s = raw.trim();
  if (format === "iso") {
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    if (!m) throw new Error(`Bad ISO date: ${JSON.stringify(raw)}`);
    return `${m[1]}-${pad(m[2]!)}-${pad(m[3]!)}`;
  }
  const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (!m) throw new Error(`Bad date: ${JSON.stringify(raw)}`);
  const a = Number(m[1]);
  const b = Number(m[2]);
  const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const day = format === "dmy" ? a : b;
  const month = format === "dmy" ? b : a;
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`Bad date: ${JSON.stringify(raw)}`);
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(n: string | number): string {
  return String(n).padStart(2, "0");
}

function money(raw: string, currency: CurrencyConfig): number {
  const s = raw.trim();
  if (!s) return 0;
  return parseMoney(s, currency);
}

export interface MapResult {
  drafts: BankDraft[];
  errors: string[];
}

/** Map parsed rows into transaction drafts using the column mapping. */
export function mapBankRows(rows: readonly Record<string, string>[], mapping: BankMapping, currency: CurrencyConfig): MapResult {
  const drafts: BankDraft[] = [];
  const errors: string[] = [];
  rows.forEach((row, i) => {
    const sourceRow = i + 2; // header is line 1
    try {
      const date = parseBankDate(row[mapping.dateColumn] ?? "", mapping.dateFormat);
      let amount: number;
      if (mapping.amount.mode === "single") {
        const raw = money(row[mapping.amount.column] ?? "", currency);
        amount = mapping.amount.outflowPositive ? -raw : raw;
      } else {
        const inflow = money(row[mapping.amount.inflowColumn] ?? "", currency);
        const outflow = money(row[mapping.amount.outflowColumn] ?? "", currency);
        amount = inflow - outflow;
      }
      drafts.push({
        date,
        payee: (row[mapping.payeeColumn] ?? "").trim(),
        memo: mapping.memoColumn ? (row[mapping.memoColumn] ?? "").trim() : "",
        amount: amount as Cents,
        sourceRow,
      });
    } catch (e) {
      errors.push(`Row ${sourceRow}: ${(e as Error).message}`);
    }
  });
  return { drafts, errors };
}

/** Content key for de-duplication within an account. */
function draftKey(date: string, amount: number, payee: string, memo: string): string {
  return fingerprint(["BANK", date, amount, payee.toLowerCase(), memo.toLowerCase()]);
}

export interface DedupeResult {
  fresh: BankDraft[];
  duplicates: number;
}

/** Drop drafts that already exist on the account (same date+amount+payee+memo). */
export function dedupeBankDrafts(existing: readonly Transaction[], accountId: string, drafts: readonly BankDraft[]): DedupeResult {
  const seen = new Set<string>();
  for (const t of existing) {
    if (t.accountId === accountId) seen.add(draftKey(t.date, t.amount, t.payee, t.memo));
  }
  const fresh: BankDraft[] = [];
  let duplicates = 0;
  for (const d of drafts) {
    const key = draftKey(d.date, d.amount, d.payee, d.memo);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key); // also dedupe within the same file
    fresh.push(d);
  }
  return { fresh, duplicates };
}
