import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import { builtinFormat } from "./formats/index.js";
import { mapRegisterRows, parseCsv } from "./register.js";
import { buildStagedTransactions } from "./transactions.js";

const LIB = builtinFormat("lib:budget-export-register")!;
const OPTS = { sourceKey: "s1", currency: EUR, exportDate: "2026-08-03" };

function csv(rows: Array<Partial<Record<string, string>>>): string {
  const headers = ["Account", "Flag", "Date", "Payee", "Category Group", "Category", "Memo", "Outflow", "Inflow", "Cleared"];
  const defaults: Record<string, string> = {
    Account: "Checking", Flag: "", Date: "15.01.2026", Payee: "Shop",
    "Category Group": "Everyday", Category: "Groceries", Memo: "", Outflow: "€0.00", Inflow: "€0.00", Cleared: "Cleared",
  };
  const line = (cells: string[]): string => cells.map((c) => `"${c}"`).join(",");
  return [line(headers), ...rows.map((r) => line(headers.map((h) => r[h] ?? defaults[h]!)))].join("\n") + "\n";
}

const build = (rows: Array<Partial<Record<string, string>>>) => {
  const mapped = mapRegisterRows(parseCsv(csv(rows)), LIB, OPTS);
  expect(mapped.errors).toEqual([]);
  return buildStagedTransactions(mapped.rows);
};

describe("buildStagedTransactions", () => {
  it("passes a simple categorized row through as one line", () => {
    const [t] = build([{ Outflow: "€12.34" }]);
    expect(t!.kind).toBe("normal");
    expect(t!.lines).toHaveLength(1);
    expect(t!.amount).toBe(-1234);
  });

  it("reconstructs a split into one transaction with a line per child", () => {
    const staged = build([
      { Payee: "Market", Memo: "Split (1/2) veg", Category: "Groceries", Outflow: "€30.00" },
      { Payee: "Market", Memo: "Split (2/2) toy", Category: "Fun", Outflow: "€20.00" },
    ]);
    expect(staged).toHaveLength(1);
    const t = staged[0]!;
    expect(t.lines.map((l) => l.category)).toEqual(["Groceries", "Fun"]);
    expect(t.amount).toBe(-5000);
    expect(t.sourceRows).toHaveLength(2);
    expect(t.warnings).toBeUndefined();
  });

  it("does not merge splits that belong to different payees/dates", () => {
    const staged = build([
      { Payee: "A", Memo: "Split (1/2)", Outflow: "€10.00" },
      { Payee: "A", Memo: "Split (2/2)", Outflow: "€10.00" },
      { Payee: "B", Memo: "Split (1/2)", Outflow: "€5.00" },
      { Payee: "B", Memo: "Split (2/2)", Outflow: "€5.00" },
    ]);
    expect(staged).toHaveLength(2);
    expect(staged[0]!.amount).toBe(-2000);
    expect(staged[1]!.amount).toBe(-1000);
  });

  it("flags an incomplete split", () => {
    const staged = build([
      { Payee: "X", Memo: "Split (1/3)", Outflow: "€10.00" },
      { Payee: "Y", Memo: "", Outflow: "€99.00" }, // breaks the run
    ]);
    expect(staged).toHaveLength(2);
    expect(staged[0]!.warnings?.[0]).toMatch(/incomplete split/);
  });

  it("keeps within-budget transfers as categoryless transfer intents with the counter stamped", () => {
    const [t] = build([{ Payee: "Transfer : Savings", "Category Group": "", Category: "", Outflow: "€100.00" }]);
    expect(t!.kind).toBe("withinTransfer");
    expect(t!.lines).toHaveLength(0);
    expect(t!.counterAccount).toBe("Savings");
    expect(t!.counterAccountFold).toBe("savings");
  });
});
