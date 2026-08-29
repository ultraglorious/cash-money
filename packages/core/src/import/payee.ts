import type { Ulid } from "../ids.js";
import type { LoadedBudget, Payee } from "../model/types.js";
import { fold, trimN } from "./text.js";

/**
 * Naming an imported row the way you would name it.
 *
 * A bank names rows its own way: legal entities ("AS Northwind Bank", "EXAMPLECO OÜ"),
 * payment-processor strings ("RIDECO.EU/O/1234567890", "FRUITCO.COM/BILL"), or
 * nothing at all for the things the bank did to you — interest, fees, standing
 * orders, ATM withdrawals. Measured against real statements, only a handful of
 * rows arrive already carrying a name you actually use.
 *
 * Three answers, in order of how much they can be trusted:
 *
 *   1. an ALIAS you recorded — exact, deterministic, and yours;
 *   2. a MATCH against your existing payees — strip the legal form, and if every
 *      word of one of your payees appears in the bank's string, that is almost
 *      certainly who it is ("AS Northwind Bank" → "Northwind");
 *   3. the DESCRIPTION, cleaned of account numbers, card masks and dates, which
 *      is all there is for a row the bank never named.
 *
 * Only (1) is stored, and only because you confirmed it. (2) and (3) propose.
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
 * which is what makes it a usable alias key too.
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

/**
 * The key a row is remembered under: what the bank called it, else the shape of
 * its description. One function, so an alias recorded from a row still matches
 * the same row next month.
 */
export function technicalKey(row: { payee: string; memo: string }): string {
  return fold(row.payee) || fold(payeeFromDescription(row.memo));
}

/** Legal forms and company suffixes, never part of what you call something. */
const LEGAL = /\b(as|oü|ou|uab|sia|ab|oy|ltd|limited|gmbh|plc|inc|llc|osaühing|a\/s)\b/g;
/** Short tokens match too much — "as" alone would name half the statement. */
const MIN_TOKEN = 3;

function tokens(s: string): Set<string> {
  const folded = fold(s)
    .replace(/[õö]/g, "o")
    .replace(/[üú]/g, "u")
    .replace(/[äá]/g, "a")
    .replace(LEGAL, " ");
  return new Set(folded.split(/[^a-z0-9]+/).filter((t) => t.length >= MIN_TOKEN));
}

/**
 * The payee whose every word appears in the bank's string — the most specific
 * one, so "Northwind Insurance" beats "Northwind" when both fit.
 *
 * Deliberately conservative: never a partial word, never a token under three
 * characters. A first-time merchant comes back undefined rather than wearing
 * someone else's name.
 */
export function matchExistingPayee(technical: string, payees: readonly Payee[]): Payee | undefined {
  const words = tokens(technical);
  if (words.size === 0) return undefined;
  let best: Payee | undefined;
  let bestScore = [0, 0];
  for (const p of payees) {
    const pw = tokens(p.name);
    if (pw.size === 0) continue;
    let all = true;
    for (const w of pw) {
      if (!words.has(w)) {
        all = false;
        break;
      }
    }
    if (!all) continue;
    // More words wins; equal words, more letters wins. Scoring rather than
    // first-past-the-post keeps the answer independent of list order, so two
    // budgets holding the same payees always name a row the same way.
    const score = [pw.size, [...pw].reduce((n, w) => n + w.length, 0)];
    if (score[0]! > bestScore[0]! || (score[0] === bestScore[0] && score[1]! > bestScore[1]!)) {
      best = p;
      bestScore = score;
    }
  }
  return best;
}

/** The category a payee was last filed under — derived, so it can't go stale. */
export function lastCategoryByPayee(b: LoadedBudget): Map<string, Ulid> {
  const out = new Map<string, Ulid>();
  const newestFirst = [...b.transactions].sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
  for (const t of newestFirst) {
    if (t.transfer || !t.categoryId) continue;
    const key = fold(t.payee);
    if (key && !out.has(key)) out.set(key, t.categoryId);
  }
  return out;
}

export interface ProposedName {
  payee: string;
  categoryId?: Ulid;
  /** Which of the three answers this came from — the wizard says so. */
  from: "alias" | "match" | "bank" | "description";
}

/**
 * What to call an incoming row, and how that was decided.
 *
 * `payees` is the master list; `categories` comes from `lastCategoryByPayee` and
 * is passed in so a whole statement shares one pass over the transactions.
 */
export function nameIncomingRow(
  row: { payee: string; memo: string },
  payees: readonly Payee[],
  categories: Map<string, Ulid>,
): ProposedName {
  const withCategory = (payee: string, from: ProposedName["from"]): ProposedName => {
    const categoryId = categories.get(fold(payee));
    return { payee, from, ...(categoryId ? { categoryId } : {}) };
  };

  const key = technicalKey(row);
  if (key) {
    const aliased = payees.find((p) => p.aliases.includes(key));
    if (aliased) return withCategory(aliased.name, "alias");
  }

  const supplied = trimN(row.payee);
  if (supplied) {
    const matched = matchExistingPayee(supplied, payees);
    return matched ? withCategory(matched.name, "match") : withCategory(supplied, "bank");
  }

  const derived = payeeFromDescription(row.memo);
  const matched = derived ? matchExistingPayee(derived, payees) : undefined;
  return matched ? withCategory(matched.name, "match") : withCategory(derived, "description");
}
