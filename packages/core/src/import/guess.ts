import type { RegisterFormat } from "./format.js";

/**
 * Best-effort column guessing for the mapping form: given a CSV's headers (and
 * optionally a few sample rows), propose the pieces of a RegisterFormat the
 * user would otherwise click together. Pure and heuristic — the user always
 * confirms/corrects in the UI.
 */
export interface FormatGuess {
  dateColumn?: string;
  payeeColumn?: string;
  memoColumn?: string;
  amount?: RegisterFormat["amount"];
  trueDate?: RegisterFormat["trueDate"];
}

const find = (headers: readonly string[], re: RegExp): string | undefined =>
  headers.find((h) => re.test(h));

/**
 * Card statements often book a purchase days late but embed the real
 * transaction date in the description, prefixed by the masked card number —
 * e.g. `(..1234) 2026-01-03 21:42 MERCHANT…`. Recognize that shape.
 */
const EMBEDDED_DATE = /\(\.\.\d+\)\s+(\d{4}-\d{2}-\d{2})/;

export function guessFormat(
  headers: readonly string[],
  sampleRows: readonly Record<string, string>[] = [],
): FormatGuess {
  const guess: FormatGuess = {};
  guess.dateColumn = find(headers, /date/i);
  guess.payeeColumn = find(headers, /payee|description|name|details|narrative|memo/i);
  // Memo: best matching PATTERN wins (not header order) — "Description" beats a
  // usually-empty "Reference number" even when it appears later in the file.
  const rest = headers.filter((h) => h !== guess.payeeColumn);
  for (const re of [/description/i, /memo|note/i, /reference/i]) {
    const hit = find(rest, re);
    if (hit) {
      guess.memoColumn = hit;
      break;
    }
  }

  const outflow = find(headers, /debit|outflow|withdraw|paid.?out/i);
  const inflow = find(headers, /credit|inflow|deposit|paid.?in/i);
  const single = find(headers, /amount|value/i);
  // A lone Debit/Credit MARKER column (e.g. "Debit/Credit (D/C)") is not an
  // amount pair; prefer a real signed amount column when one exists.
  if (outflow && inflow && outflow !== inflow) {
    guess.amount = { mode: "inOut", inflowColumn: inflow, outflowColumn: outflow };
  } else if (single) {
    guess.amount = { mode: "signed", column: single };
  }

  if (guess.memoColumn) {
    const hits = sampleRows.filter((r) => EMBEDDED_DATE.test(r[guess.memoColumn!] ?? "")).length;
    if (hits >= 2 || (sampleRows.length > 0 && hits === sampleRows.length)) {
      guess.trueDate = { pattern: EMBEDDED_DATE.source, format: "iso" };
    }
  }
  return guess;
}
