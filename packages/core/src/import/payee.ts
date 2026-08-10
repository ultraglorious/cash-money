import type { Fingerprint, Ulid } from "../ids.js";
import type { LoadedBudget } from "../model/types.js";
import { fold, trimN } from "./text.js";

/**
 * Naming a statement row the bank didn't name.
 *
 * Banks fill the counterparty column for transfers between people and leave it
 * empty for everything the bank did to you — interest, account fees, card fees,
 * standing orders, ATM withdrawals. Those rows arrive blank, which means the
 * only way to tell them apart is to open the statement alongside the app and
 * read the description yourself.
 *
 * The description always says what the row is; it just says it with the account
 * number, the card mask and a date range wrapped around it. Strip those and
 * what remains is a usable name — "Account interest", "Premium client monthly
 * fee", "Cash withdrawal: BRINK'S ATM …". It is a starting point to correct,
 * not a claim to be right, so the wizard leaves it editable.
 */

/** IBAN-shaped tokens, card masks, dates, times, and long digit runs. */
const NOISE: RegExp[] = [
  /\b[A-Z]{2}\d{2}[A-Z0-9]{8,26}\b/g, // IBAN
  /\(\.\.\d+\)/g, // card mask, e.g. (..1234)
  /\b\d{4}-\d{2}-\d{2}\b/g, // ISO date
  /\b\d{2}[.\/]\d{2}[.\/]\d{4}\b/g, // 01.06.2026
  /\b\d{2}[.\-\/]\d{4}\b/g, // a period marker like 06.2026 — otherwise every
  //                              month's fee derives a different name and the
  //                              one you typed last month never matches.
  /\b\d{2}:\d{2}(:\d{2})?\b/g, // time
  /\b\d{7,}\b/g, // reference numbers
];

/** Trailing junk left behind once the noise is gone. */
const EDGE = /^[\s,;:\-–—\\/|.]+|[\s,;:\-–—\\/|.]+$/g;

const MAX_LENGTH = 60;

/**
 * A readable payee from a statement description, or "" when nothing survives.
 * Deterministic and pure — the same description always names the same thing,
 * which is what makes it a usable learning key too.
 */
export function payeeFromDescription(description: string): string {
  let s = trimN(description);
  if (!s) return "";
  for (const re of NOISE) s = s.replace(re, " ");
  // Removing a date range mid-sentence strands its punctuation ("interest , - ,
  // interest rate"), so collapse any run of separators left behind.
  s = s.replace(/\s{2,}/g, " ").replace(/(?:\s*[-–—,;:|\\/]+\s*){2,}/g, ", ").replace(EDGE, "");
  // A description that was ONLY noise leaves nothing worth showing.
  if (s.length <= 2) return "";
  if (s.length > MAX_LENGTH) {
    const cut = s.slice(0, MAX_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    s = (lastSpace > MAX_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).replace(EDGE, "");
  }
  return s;
}

/** The key a description is remembered under: its derived name, folded. */
export function descriptionKey(description: string): string {
  return fold(payeeFromDescription(description));
}

export interface PayeeMemory {
  /** What a counterparty account was called last time (the reliable key). */
  byCounterparty: Map<Fingerprint, string>;
  /** What this shape of description was called last time. */
  byDescription: Map<string, string>;
  /** The category a payee usually gets. */
  categoryOf: Map<string, Ulid>;
}

/**
 * What the budget already knows about naming and filing rows.
 *
 * Newest first: a payee you renamed last month should win over what you called
 * the same counterparty two years ago. Transfers are skipped — their payee is
 * derived text, not a name you chose.
 */
export function learnPayees(b: LoadedBudget): PayeeMemory {
  const byCounterparty = new Map<Fingerprint, string>();
  const byDescription = new Map<string, string>();
  const categoryOf = new Map<string, Ulid>();

  const newestFirst = [...b.transactions].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  for (const t of newestFirst) {
    if (t.transfer) continue;
    const payee = trimN(t.payee);
    if (payee) {
      const cp = t.source?.counterparty;
      if (cp && !byCounterparty.has(cp)) byCounterparty.set(cp, payee);
      const key = descriptionKey(t.memo);
      if (key && !byDescription.has(key)) byDescription.set(key, payee);
      if (t.categoryId && !categoryOf.has(fold(payee))) categoryOf.set(fold(payee), t.categoryId);
    }
  }
  return { byCounterparty, byDescription, categoryOf };
}

export interface NamedRow {
  payee: string;
  memo: string;
  counterparty?: Fingerprint;
}

/**
 * The best name available for an incoming row, and the category that name
 * usually gets. Preference order: what the bank supplied, what this exact
 * counterparty was called before, what this description was called before, and
 * finally the description itself, cleaned up.
 */
export function nameIncomingRow(row: NamedRow, memory: PayeeMemory): { payee: string; categoryId?: Ulid } {
  const supplied = trimN(row.payee);
  const payee =
    supplied ||
    (row.counterparty ? memory.byCounterparty.get(row.counterparty) : undefined) ||
    memory.byDescription.get(descriptionKey(row.memo)) ||
    payeeFromDescription(row.memo);
  const categoryId = payee ? memory.categoryOf.get(fold(payee)) : undefined;
  return { payee, ...(categoryId ? { categoryId } : {}) };
}
