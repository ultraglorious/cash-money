import Papa from "papaparse";
import type { ISODate } from "../time.js";
import type { ImportDateFormat } from "./format.js";

/**
 * Format-agnostic CSV reading: one shared header-based parser and one date
 * parser covering the layouts real exports use. The format-driven row mapper
 * (`mapRegisterRows`) builds on these.
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
 * or `.` separators and 2-digit years (assumed 20xx). Throws on malformed input
 * — callers collect the error per row.
 */
export function parseDateAs(raw: string, format: ImportDateFormat): ISODate {
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
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Bad date: ${JSON.stringify(raw)}`);
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function pad(n: string | number): string {
  return String(n).padStart(2, "0");
}
