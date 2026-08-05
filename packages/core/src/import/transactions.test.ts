import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import { normalizeRegister } from "./normalize.js";
import type { RawRegisterRow } from "./csv.js";
import { buildStagedTransactions } from "./transactions.js";

let row = 1;
function reg(o: Partial<RawRegisterRow>): RawRegisterRow {
  return {
    account: "Checking",
    flag: "",
    date: "15.01.2026",
    payee: "Shop",
    groupCategory: "",
    group: "Everyday",
    category: "Groceries",
    memo: "",
    outflow: "€0.00",
    inflow: "€0.00",
    cleared: "Cleared",
    sourceRow: ++row,
    ...o,
  };
}

const OPTS = { sourceKey: "s1", currency: EUR, exportDate: "2026-08-03" };
const build = (rows: RawRegisterRow[]) => buildStagedTransactions(normalizeRegister(rows, OPTS));

describe("buildStagedTransactions", () => {
  it("passes a simple categorized row through as one line", () => {
    const [t] = build([reg({ outflow: "€12.34" })]);
    expect(t!.kind).toBe("normal");
    expect(t!.lines).toHaveLength(1);
    expect(t!.amount).toBe(-1234);
  });

  it("reconstructs a split into one transaction with a line per child", () => {
    const staged = build([
      reg({ payee: "Market", memo: "Split (1/2) veg", category: "Groceries", outflow: "€30.00" }),
      reg({ payee: "Market", memo: "Split (2/2) toy", category: "Fun", group: "Everyday", outflow: "€20.00" }),
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
      reg({ payee: "A", memo: "Split (1/2)", outflow: "€10.00" }),
      reg({ payee: "A", memo: "Split (2/2)", outflow: "€10.00" }),
      reg({ payee: "B", memo: "Split (1/2)", outflow: "€5.00" }),
      reg({ payee: "B", memo: "Split (2/2)", outflow: "€5.00" }),
    ]);
    expect(staged).toHaveLength(2);
    expect(staged[0]!.amount).toBe(-2000);
    expect(staged[1]!.amount).toBe(-1000);
  });

  it("flags an incomplete split", () => {
    const staged = build([
      reg({ payee: "X", memo: "Split (1/3)", outflow: "€10.00" }),
      reg({ payee: "Y", memo: "", outflow: "€99.00" }), // breaks the run
    ]);
    expect(staged).toHaveLength(2);
    expect(staged[0]!.warnings?.[0]).toMatch(/incomplete split/);
  });

  it("keeps within-budget transfers as categoryless transfer intents", () => {
    const [t] = build([reg({ payee: "Transfer : Savings", group: "", category: "", outflow: "€100.00" })]);
    expect(t!.kind).toBe("withinTransfer");
    expect(t!.lines).toHaveLength(0);
  });
});
