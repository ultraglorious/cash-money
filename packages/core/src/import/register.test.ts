import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import type { RegisterFormat } from "./format.js";
import { builtinFormat } from "./formats/index.js";
import { formatFitsHeaders, mapRegisterRows, parseCsv, parseDateAs, type MapRegisterOptions } from "./register.js";

const LIB = builtinFormat("lib:budget-export-register")!;
const OPTS: MapRegisterOptions = { sourceKey: "s1", currency: EUR, exportDate: "2026-08-03" };

/** Build a register CSV in the library format from partial row specs. */
function csv(rows: Array<Partial<Record<string, string>>>): string {
  const headers = ["Account", "Flag", "Date", "Payee", "Category Group", "Category", "Memo", "Outflow", "Inflow", "Cleared"];
  const defaults: Record<string, string> = {
    Account: "Checking", Flag: "", Date: "15.01.2026", Payee: "Shop",
    "Category Group": "Everyday", Category: "Groceries", Memo: "", Outflow: "€12.34", Inflow: "€0.00", Cleared: "Cleared",
  };
  const line = (cells: string[]): string => cells.map((c) => `"${c}"`).join(",");
  return [line(headers), ...rows.map((r) => line(headers.map((h) => r[h] ?? defaults[h]!)))].join("\n") + "\n";
}

function mapOne(row: Partial<Record<string, string>>, opts: MapRegisterOptions = OPTS) {
  const { rows, errors } = mapRegisterRows(parseCsv(csv([row])), LIB, opts);
  expect(errors).toEqual([]);
  return rows[0]!;
}

describe("parseCsv", () => {
  it("strips a BOM, trims headers, and keys rows by header", () => {
    const text = '﻿"Date ","Payee"\n"01.02.2026","Shop"\n';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(["Date", "Payee"]);
    expect(rows).toEqual([{ Date: "01.02.2026", Payee: "Shop" }]);
  });

  it("skips blank lines and preserves commas inside quotes", () => {
    const { rows } = parseCsv('"A","B"\n\n"x, y","z"\n');
    expect(rows).toEqual([{ A: "x, y", B: "z" }]);
  });
});

describe("parseDateAs", () => {
  it("parses each layout with -, /, or . separators", () => {
    expect(parseDateAs("2026-02-01", "iso")).toBe("2026-02-01");
    expect(parseDateAs("2026/2/1", "iso")).toBe("2026-02-01");
    expect(parseDateAs("01.02.2026", "dmy")).toBe("2026-02-01");
    expect(parseDateAs("1/2/2026", "dmy")).toBe("2026-02-01");
    expect(parseDateAs("02-01-2026", "mdy")).toBe("2026-02-01");
  });

  it("expands 2-digit years to 20xx", () => {
    expect(parseDateAs("01.02.26", "dmy")).toBe("2026-02-01");
    expect(parseDateAs("2/1/26", "mdy")).toBe("2026-02-01");
  });

  it("finds a date embedded in free text (a description mapped as the date column)", () => {
    expect(parseDateAs("(..1234) 2026-01-03 00:00 Amazon.de*XYZ\\5 rue\\LUXEMBOURG", "iso")).toBe("2026-01-03");
    expect(parseDateAs("paid on 03.01.2026 at the till", "dmy")).toBe("2026-01-03");
    // Digit-boundary guards: long digit runs are not dates.
    expect(() => parseDateAs("ref 12345-67-89012", "iso")).toThrow(/Bad ISO date/);
  });

  it("rejects out-of-range and malformed dates", () => {
    expect(() => parseDateAs("32.01.2026", "dmy")).toThrow(/Bad date/);
    expect(() => parseDateAs("01.13.2026", "dmy")).toThrow(/Bad date/);
    expect(() => parseDateAs("soon", "iso")).toThrow(/Bad ISO date/);
    expect(() => parseDateAs("", "dmy")).toThrow(/Bad date/);
  });
});

describe("mapRegisterRows with the library budget-export format", () => {
  it("folds in/out amounts into signed cents and parses the date", () => {
    const n = mapOne({});
    expect(n.amount).toBe(-1234);
    expect(n.date).toBe("2026-01-15");
    expect(n.cleared).toBe("cleared");
    expect(n.approved).toBe(true);
  });

  it("treats inflow as positive", () => {
    expect(mapOne({ Outflow: "€0.00", Inflow: "€2000.00" }).amount).toBe(200000);
  });

  it("classifies within-budget transfers and stamps the counterpart", () => {
    const n = mapOne({ Payee: "Transfer : Savings", Category: "", "Category Group": "" });
    expect(n.kind).toBe("withinTransfer");
    expect(n.counterAccount).toBe("Savings");
  });

  it("treats a categorised transfer leg as income, not a within-budget transfer", () => {
    const n = mapOne({
      Payee: "Transfer : Brokerage", "Category Group": "Inflow", Category: "Ready to Assign",
      Inflow: "€5485.94", Outflow: "€0.00",
    });
    expect(n.kind).toBe("income");
  });

  it("treats a categorised transfer leg with a spending category as normal activity", () => {
    const n = mapOne({ Payee: "Transfer : Brokerage", "Category Group": "Savings Goals", Category: "Uninvested Savings" });
    expect(n.kind).toBe("normal");
  });

  it("classifies income by group or by category name", () => {
    expect(mapOne({ "Category Group": "Inflow", Category: "Ready to Assign" }).kind).toBe("income");
    expect(mapOne({ "Category Group": "", Category: "Ready to Assign" }).kind).toBe("income");
  });

  it("stamps group semantics: kind and hiddenness", () => {
    expect(mapOne({}).groupKind).toBe("normal");
    expect(mapOne({ "Category Group": "Inflow", Category: "Ready to Assign" }).groupKind).toBe("income");
    expect(mapOne({ "Category Group": "Credit Card Payments", Category: "Card" }).groupKind).toBe("creditCardPayments");
    expect(mapOne({ "Category Group": "Hidden Categories" }).groupHidden).toBe(true);
    expect(mapOne({}).groupHidden).toBe(false);
  });

  it("marks future-dated rows as unapproved; no exportDate means all approved", () => {
    expect(mapOne({ Date: "01.09.2026" }).approved).toBe(false);
    expect(mapOne({ Date: "01.09.2026" }, { sourceKey: "s1", currency: EUR }).approved).toBe(true);
  });

  it("detects split children from the memo marker", () => {
    expect(mapOne({ Memo: "Split (2/3) part" }).split).toEqual({ n: 2, m: 3 });
  });

  it("maps cleared/flag vocabulary; unmapped cleared values become uncleared", () => {
    expect(mapOne({ Cleared: "Reconciled" }).cleared).toBe("reconciled");
    expect(mapOne({ Cleared: "Something else" }).cleared).toBe("uncleared");
    expect(mapOne({ Flag: "Red" }).flag).toBe("red");
    expect(mapOne({ Flag: "Chartreuse" }).flag).toBeUndefined();
  });

  it("folds and trims category names (whitespace variants collapse)", () => {
    const a = mapOne({ Category: "Luxuries " });
    const b = mapOne({ Category: "Luxuries" });
    expect(a.categoryFold).toBe(b.categoryFold);
    expect(a.category).toBe("Luxuries");
  });

  it("collects per-row errors and keeps the good rows", () => {
    const text = csv([{}, { Date: "not a date" }]);
    const { rows, errors } = mapRegisterRows(parseCsv(text), LIB, OPTS);
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/Row 3: Bad date/);
  });

  it("reports missing columns as a file-level error", () => {
    const { rows, errors } = mapRegisterRows(parseCsv('"Account","Date"\n"Checking","15.01.2026"\n'), LIB, OPTS);
    expect(rows).toHaveLength(0);
    expect(errors[0]).toMatch(/Missing column\(s\):.*Payee/);
  });
});

describe("mapRegisterRows with statement-style formats", () => {
  const STATEMENT: RegisterFormat = {
    id: "lib:test-statement",
    name: "Test statement",
    date: { column: "Booked", format: "iso" },
    amount: { mode: "signed", column: "Amount" },
    payeeColumn: "Description",
  };
  const stmtCsv = '"Booked","Description","Amount"\n"2026-03-01","Cafe","-4.50"\n"2026-03-02","Refund","1.00"\n';

  it("maps a single signed column into a fixed account, all cleared and approved", () => {
    const { rows, errors } = mapRegisterRows(parseCsv(stmtCsv), STATEMENT, {
      sourceKey: "b1", currency: EUR, fixedAccount: "Main",
    });
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.amount)).toEqual([-450, 100]);
    expect(rows[0]).toMatchObject({ account: "Main", cleared: "cleared", approved: true, kind: "normal" });
    expect(rows[0]!.group).toBe("");
  });

  it("flips signs when outflowPositive is declared", () => {
    const f: RegisterFormat = { ...STATEMENT, amount: { mode: "signed", column: "Amount", outflowPositive: true } };
    const { rows } = mapRegisterRows(parseCsv(stmtCsv), f, { sourceKey: "b1", currency: EUR, fixedAccount: "Main" });
    expect(rows.map((r) => r.amount)).toEqual([450, -100]);
  });

  it("requires a target account when the format has no account column", () => {
    const { errors } = mapRegisterRows(parseCsv(stmtCsv), STATEMENT, { sourceKey: "b1", currency: EUR });
    expect(errors[0]).toMatch(/target account/);
  });

  it("supports a combined group/category column split on the first separator", () => {
    const f: RegisterFormat = {
      ...STATEMENT,
      category: { mode: "combined", column: "Cat", separator: ": " },
    };
    const text = '"Booked","Description","Amount","Cat"\n"2026-03-01","Cafe","-4.50","Everyday: Dining: Out"\n"2026-03-02","Store","-1.00","Misc"\n';
    const { rows } = mapRegisterRows(parseCsv(text), f, { sourceKey: "b1", currency: EUR, fixedAccount: "Main" });
    expect(rows[0]).toMatchObject({ group: "Everyday", category: "Dining: Out" });
    expect(rows[1]).toMatchObject({ group: "", category: "Misc" });
  });

  it("recognizes transfers via a counter-account column", () => {
    const f: RegisterFormat = { ...STATEMENT, transfer: { mode: "column", column: "TransferTo" } };
    const text = '"Booked","Description","Amount","TransferTo"\n"2026-03-01","Move","-10.00","Savings"\n"2026-03-02","Cafe","-4.50",""\n';
    const { rows } = mapRegisterRows(parseCsv(text), f, { sourceKey: "b1", currency: EUR, fixedAccount: "Main" });
    expect(rows[0]).toMatchObject({ kind: "withinTransfer", counterAccount: "Savings" });
    expect(rows[1]!.kind).toBe("normal");
  });

  it("formatFitsHeaders recognizes a file the format can read (account column not required)", () => {
    expect(formatFitsHeaders(STATEMENT, ["Booked", "Description", "Amount", "Extra"])).toBe(true);
    expect(formatFitsHeaders(STATEMENT, ["Date", "Description", "Amount"])).toBe(false);
    expect(formatFitsHeaders(LIB, ["Date", "Payee"])).toBe(false); // library format needs its full column set
  });

  it("honours a custom split-memo marker", () => {
    const f: RegisterFormat = { ...STATEMENT, memoColumn: "Note", splitMemoPattern: "part\\s+(\\d+)\\s+of\\s+(\\d+)" };
    const text = '"Booked","Description","Amount","Note"\n"2026-03-01","Shop","-4.50","part 1 of 2"\n';
    const { rows } = mapRegisterRows(parseCsv(text), f, { sourceKey: "b1", currency: EUR, fixedAccount: "Main" });
    expect(rows[0]!.split).toEqual({ n: 1, m: 2 });
  });
});
