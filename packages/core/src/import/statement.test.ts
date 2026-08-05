import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import type { Cents } from "../money.js";
import type { LoadedBudget } from "../model/types.js";
import type { RegisterFormat } from "./format.js";
import { stageStatement } from "./statement.js";
import * as f from "../../test/fixtures/factories.js";

const ACC = f.tid("AACC");
const FORMAT: RegisterFormat = {
  id: "lib:test-statement",
  name: "Test statement",
  date: { column: "Date", format: "iso" },
  amount: { mode: "signed", column: "Amount" },
  payeeColumn: "Payee",
  memoColumn: "Memo",
};
const OPTS = { sourceKey: "stmt:acc", accountId: ACC, currency: EUR };

function budget(transactions: LoadedBudget["transactions"] = []): LoadedBudget {
  return {
    budget: f.budget(),
    accounts: [f.account({ id: ACC, name: "Main", type: "checking" })],
    groups: [],
    categories: [],
    assignments: [],
    transactions,
  };
}

function csvOf(rows: Array<[date: string, payee: string, amount: string, memo?: string]>): string {
  const line = (cells: string[]): string => cells.map((c) => `"${c}"`).join(",");
  return [line(["Date", "Payee", "Amount", "Memo"]), ...rows.map((r) => line([r[0], r[1], r[2], r[3] ?? ""]))].join("\n") + "\n";
}

const WINDOW_1 = csvOf([
  ["2026-03-01", "Cafe", "-4.50"],
  ["2026-03-10", "Shop", "-20.00"],
  // Two identical same-day rows — distinguished by occurrence index.
  ["2026-03-15", "Metro", "-2.00"],
  ["2026-03-15", "Metro", "-2.00"],
]);

describe("stageStatement", () => {
  it("imports rows as approved, cleared, provenance-carrying transactions", () => {
    const { merged, report } = stageStatement(budget(), WINDOW_1, FORMAT, OPTS);
    expect(report).toMatchObject({ added: 4, matched: 0, legacyMatched: 0, parsedRows: 4, errors: [] });
    expect(merged).toHaveLength(4);
    for (const t of merged) {
      expect(t.accountId).toBe(ACC);
      expect(t.approved).toBe(true);
      expect(t.cleared).toBe("cleared");
      expect(t.source?.identity).toBeTruthy();
      expect(t.source?.sourceBudget).toBe("stmt:acc");
    }
    // The identical Metro rows got distinct identities.
    const metros = merged.filter((t) => t.payee === "Metro");
    expect(new Set(metros.map((t) => t.source!.identity)).size).toBe(2);
  });

  it("re-importing the same file adds nothing", () => {
    const first = stageStatement(budget(), WINDOW_1, FORMAT, OPTS);
    const second = stageStatement(budget(first.merged), WINDOW_1, FORMAT, OPTS);
    expect(second.report).toMatchObject({ added: 0, matched: 4 });
    expect(second.merged).toHaveLength(4);
  });

  it("overlapping windows add only the new rows — including across identical same-day pairs", () => {
    const first = stageStatement(budget(), WINDOW_1, FORMAT, OPTS);
    // Second statement overlaps the 10th-15th and extends to April.
    const window2 = csvOf([
      ["2026-03-10", "Shop", "-20.00"],
      ["2026-03-15", "Metro", "-2.00"],
      ["2026-03-15", "Metro", "-2.00"],
      ["2026-04-01", "Rent", "-800.00"],
    ]);
    const second = stageStatement(budget(first.merged), window2, FORMAT, OPTS);
    expect(second.report).toMatchObject({ added: 1, matched: 3 });
    expect(second.merged).toHaveLength(5);
    // Rows outside the second window (the Cafe row) are never deleted.
    expect(second.merged.some((t) => t.payee === "Cafe")).toBe(true);
  });

  it("matches provenance-less legacy rows by content instead of duplicating them", () => {
    // A row imported through the old ad-hoc bank path: no source provenance.
    const legacy = f.txn({ id: f.tid("TLEG"), accountId: ACC, date: "2026-03-01", amount: -450 as Cents, payee: "Cafe" });
    delete (legacy as { source?: unknown }).source;
    const { merged, report } = stageStatement(budget([legacy]), WINDOW_1, FORMAT, OPTS);
    expect(report).toMatchObject({ added: 3, legacyMatched: 1 });
    expect(merged).toHaveLength(4);
    // The legacy row kept its id and adopted provenance for future imports.
    const cafe = merged.find((t) => t.payee === "Cafe")!;
    expect(cafe.id).toBe(f.tid("TLEG"));
    expect(cafe.source?.identity).toBeTruthy();
  });

  it("preserves user categorization on re-import", () => {
    const first = stageStatement(budget(), WINDOW_1, FORMAT, OPTS);
    const categorized = first.merged.map((t) =>
      t.payee === "Shop" ? { ...t, categoryId: f.tid("CGRO") } : t,
    );
    const second = stageStatement(budget(categorized), WINDOW_1, FORMAT, OPTS);
    const shop = second.merged.find((t) => t.payee === "Shop")!;
    expect(shop.categoryId).toBe(f.tid("CGRO"));
  });

  it("collects per-row errors without dropping the good rows", () => {
    const text = csvOf([
      ["2026-03-01", "Cafe", "-4.50"],
      ["not a date", "Broken", "-1.00"],
    ]);
    const { merged, report } = stageStatement(budget(), text, FORMAT, OPTS);
    expect(merged).toHaveLength(1);
    expect(report.errors).toHaveLength(1);
  });
});
