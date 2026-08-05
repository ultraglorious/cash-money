import type { RegisterFormat } from "./format.js";

/**
 * Best-effort column guessing for the mapping form: given a CSV's headers,
 * propose the pieces of a RegisterFormat the user would otherwise click
 * together. Pure and heuristic — the user always confirms/corrects in the UI.
 */
export interface FormatGuess {
  dateColumn?: string;
  payeeColumn?: string;
  memoColumn?: string;
  amount?: RegisterFormat["amount"];
}

const find = (headers: readonly string[], re: RegExp): string | undefined =>
  headers.find((h) => re.test(h));

export function guessFormat(headers: readonly string[]): FormatGuess {
  const guess: FormatGuess = {};
  guess.dateColumn = find(headers, /date/i);
  guess.payeeColumn = find(headers, /payee|description|name|details|narrative|memo/i);
  const memo = find(headers, /reference|note|memo/i);
  if (memo && memo !== guess.payeeColumn) guess.memoColumn = memo;

  const outflow = find(headers, /debit|outflow|withdraw|paid.?out/i);
  const inflow = find(headers, /credit|inflow|deposit|paid.?in/i);
  if (outflow && inflow) {
    guess.amount = { mode: "inOut", inflowColumn: inflow, outflowColumn: outflow };
  } else {
    const single = find(headers, /amount|value/i);
    if (single) guess.amount = { mode: "signed", column: single };
  }
  return guess;
}
