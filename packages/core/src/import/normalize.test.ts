import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import { normalizePlan, normalizeRegister } from "./normalize.js";
import type { RawPlanRow, RawRegisterRow } from "./csv.js";

function reg(overrides: Partial<RawRegisterRow>): RawRegisterRow {
  return {
    account: "Checking",
    flag: "",
    date: "15.01.2026",
    payee: "Shop",
    groupCategory: "Everyday: Groceries",
    group: "Everyday",
    category: "Groceries",
    memo: "",
    outflow: "€12.34",
    inflow: "€0.00",
    cleared: "Cleared",
    sourceRow: 2,
    ...overrides,
  };
}

const OPTS = { sourceKey: "s1", currency: EUR, exportDate: "2026-08-03" };

describe("normalizeRegister", () => {
  it("folds amount into signed cents and parses the date", () => {
    const [n] = normalizeRegister([reg({})], OPTS);
    expect(n!.amount).toBe(-1234);
    expect(n!.date).toBe("2026-01-15");
    expect(n!.cleared).toBe("cleared");
    expect(n!.approved).toBe(true);
  });

  it("treats inflow as positive", () => {
    const [n] = normalizeRegister([reg({ outflow: "€0.00", inflow: "€2000.00" })], OPTS);
    expect(n!.amount).toBe(200000);
  });

  it("classifies within-budget transfers", () => {
    const [n] = normalizeRegister([reg({ payee: "Transfer : Savings", category: "", group: "" })], OPTS);
    expect(n!.kind).toBe("withinTransfer");
  });

  it("classifies income (Ready to Assign)", () => {
    const [n] = normalizeRegister([reg({ group: "Inflow", category: "Ready to Assign", inflow: "€500.00", outflow: "€0.00" })], OPTS);
    expect(n!.kind).toBe("income");
  });

  it("marks future-dated rows as unapproved", () => {
    const [n] = normalizeRegister([reg({ date: "01.09.2026" })], OPTS);
    expect(n!.approved).toBe(false);
  });

  it("detects split children from the memo marker", () => {
    const [n] = normalizeRegister([reg({ memo: "Split (2/3) part" })], OPTS);
    expect(n!.split).toEqual({ n: 2, m: 3 });
  });

  it("folds and trims category names (whitespace variants collapse)", () => {
    const [a] = normalizeRegister([reg({ category: "Luxuries " })], OPTS);
    const [b] = normalizeRegister([reg({ category: "Luxuries" })], OPTS);
    expect(a!.categoryFold).toBe(b!.categoryFold);
    expect(a!.category).toBe("Luxuries"); // display trimmed
  });
});

describe("normalizePlan", () => {
  it("parses assigned/activity/available", () => {
    const row: RawPlanRow = {
      month: "Jan 2026",
      groupCategory: "Everyday: Groceries",
      group: "Everyday",
      category: "Groceries",
      assigned: "€50.00",
      activity: "-€12.34",
      available: "€37.66",
      sourceRow: 2,
    };
    const [n] = normalizePlan([row], { sourceKey: "s1", currency: EUR });
    expect(n).toMatchObject({ assigned: 5000, activity: -1234, available: 3766 });
  });
});
