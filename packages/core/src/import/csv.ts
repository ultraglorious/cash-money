import Papa from "papaparse";

/**
 * Parsing of the two exported CSV shapes into typed raw rows. A real RFC-4180
 * parser is mandatory: memos contain commas, so naive comma-splitting fabricates
 * phantom columns/categories.
 */

export interface RawRegisterRow {
  account: string;
  flag: string;
  date: string;
  payee: string;
  groupCategory: string;
  group: string;
  category: string;
  memo: string;
  outflow: string;
  inflow: string;
  cleared: string;
  /** 1-based line number in the source file (header is line 1). */
  sourceRow: number;
}

export interface RawPlanRow {
  month: string;
  groupCategory: string;
  group: string;
  category: string;
  assigned: string;
  activity: string;
  available: string;
  sourceRow: number;
}

export const REGISTER_HEADERS = [
  "Account",
  "Flag",
  "Date",
  "Payee",
  "Category Group/Category",
  "Category Group",
  "Category",
  "Memo",
  "Outflow",
  "Inflow",
  "Cleared",
] as const;

export const PLAN_HEADERS = [
  "Month",
  "Category Group/Category",
  "Category Group",
  "Category",
  "Assigned",
  "Activity",
  "Available",
] as const;

function stripBom(s: string): string {
  return s.length > 0 && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function parse(text: string): { rows: Record<string, string>[]; fields: string[] } {
  const res = Papa.parse<Record<string, string>>(stripBom(text), {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (h) => h.trim(),
  });
  return { rows: res.data, fields: res.meta.fields ?? [] };
}

function assertHeaders(actual: string[], expected: readonly string[], kind: string): void {
  const missing = expected.filter((h) => !actual.includes(h));
  if (missing.length > 0) {
    throw new Error(
      `${kind} CSV is missing expected columns: ${missing.join(", ")}. ` +
        `Found: ${actual.join(", ")}`,
    );
  }
}

export function parseRegisterCsv(text: string): RawRegisterRow[] {
  const { rows, fields } = parse(text);
  assertHeaders(fields, REGISTER_HEADERS, "Register");
  return rows.map((r, i) => ({
    account: r["Account"] ?? "",
    flag: r["Flag"] ?? "",
    date: r["Date"] ?? "",
    payee: r["Payee"] ?? "",
    groupCategory: r["Category Group/Category"] ?? "",
    group: r["Category Group"] ?? "",
    category: r["Category"] ?? "",
    memo: r["Memo"] ?? "",
    outflow: r["Outflow"] ?? "",
    inflow: r["Inflow"] ?? "",
    cleared: r["Cleared"] ?? "",
    sourceRow: i + 2, // +1 for 0-based, +1 for header line
  }));
}

export function parsePlanCsv(text: string): RawPlanRow[] {
  const { rows, fields } = parse(text);
  assertHeaders(fields, PLAN_HEADERS, "Plan");
  return rows.map((r, i) => ({
    month: r["Month"] ?? "",
    groupCategory: r["Category Group/Category"] ?? "",
    group: r["Category Group"] ?? "",
    category: r["Category"] ?? "",
    assigned: r["Assigned"] ?? "",
    activity: r["Activity"] ?? "",
    available: r["Available"] ?? "",
    sourceRow: i + 2,
  }));
}
