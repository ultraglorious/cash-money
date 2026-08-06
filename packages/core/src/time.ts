/**
 * Date/month helpers. All operations are timezone-free: dates are handled as
 * plain "YYYY-MM-DD" strings and months as "YYYY-MM" strings, with any Date use
 * pinned to UTC so results never depend on the machine's local timezone.
 */

export type ISODate = string; // "2026-08-01"
export type MonthKey = string; // "2026-08"

/** Canonical shapes — the single source of truth for validation (schema.ts). */
export const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
export const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

const MONTH_ABBR: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse a month label "Aug 2026" (as produced by the CSV plan export) into a
 * MonthKey "2026-08".
 */
export function parseImportMonth(raw: string): MonthKey {
  const s = raw.trim();
  const m = /^([A-Za-z]{3,})\.?\s+(\d{4})$/.exec(s);
  if (!m) throw new Error(`Unrecognized import month: ${JSON.stringify(raw)}`);
  const abbr = m[1]!.slice(0, 3).toLowerCase();
  const month = MONTH_ABBR[abbr];
  if (!month) throw new Error(`Unrecognized month name: ${JSON.stringify(raw)}`);
  return `${m[2]}-${pad2(month)}`;
}

/** The MonthKey containing an ISO date. */
export function monthKeyOf(date: ISODate): MonthKey {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new Error(`Not an ISO date: ${JSON.stringify(date)}`);
  return `${m[1]}-${m[2]}`;
}

/** Whole days since the Unix epoch (UTC), for cheap +/- N day comparisons. */
export function epochDay(date: ISODate): number {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new Error(`Not an ISO date: ${JSON.stringify(date)}`);
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.floor(utc / 86_400_000);
}

/** Add (or subtract) whole months to a MonthKey. addMonths("2026-12", 1) => "2027-01". */
export function addMonths(month: MonthKey, delta: number): MonthKey {
  const m = MONTH_KEY_RE.exec(month);
  if (!m) throw new Error(`Not a MonthKey: ${JSON.stringify(month)}`);
  const zeroBased = (Number(m[1]) * 12 + (Number(m[2]) - 1)) + delta;
  const year = Math.floor(zeroBased / 12);
  const mon = zeroBased % 12;
  return `${String(year).padStart(4, "0")}-${pad2(mon + 1)}`;
}

/** -1 | 0 | 1 ordering of two MonthKeys (they sort lexicographically too). */
export function compareMonth(a: MonthKey, b: MonthKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Inclusive list of MonthKeys from `start` to `end`. */
export function monthRange(start: MonthKey, end: MonthKey): MonthKey[] {
  if (compareMonth(start, end) > 0) return [];
  const out: MonthKey[] = [];
  let cur = start;
  while (compareMonth(cur, end) <= 0) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
