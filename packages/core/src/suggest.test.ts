import { describe, expect, it } from "vitest";
import { assignSuggestions } from "./suggest.js";
import { computeProjection } from "./engine/compute.js";
import * as f from "../test/fixtures/factories.js";
import type { Cents } from "./money.js";
import type { LoadedBudget } from "./model/types.js";

const CHK = f.tid("ACHK");
const GINC = f.tid("GINC");
const GEVD = f.tid("GEVD");
const RTA = f.tid("CRTA");
const GRO = f.tid("CGRO");

/** Three months of history: assigned 100/200/300, spent 50/250/0. */
function threeMonths(): LoadedBudget {
  return {
    budget: f.budget(),
    accounts: [f.account({ id: CHK, name: "Checking", type: "checking", onBudget: true })],
    groups: [f.group({ id: GINC, name: "Inflow", kind: "income" }), f.group({ id: GEVD, name: "Everyday", kind: "normal" })],
    categories: [f.category({ id: RTA, groupId: GINC, name: "Ready to Assign" }), f.category({ id: GRO, groupId: GEVD, name: "Groceries" })],
    assignments: [
      f.assignment({ id: f.tid("A1"), month: "2026-01", categoryId: GRO, assigned: 10000 as Cents }),
      f.assignment({ id: f.tid("A2"), month: "2026-02", categoryId: GRO, assigned: 20000 as Cents }),
      f.assignment({ id: f.tid("A3"), month: "2026-03", categoryId: GRO, assigned: 30000 as Cents }),
    ],
    transactions: [
      f.txn({ id: f.tid("TI"), accountId: CHK, date: "2026-01-01", amount: 500000 as Cents, categoryId: RTA, payee: "Employer" }),
      f.txn({ id: f.tid("T1"), accountId: CHK, date: "2026-01-15", amount: -5000 as Cents, categoryId: GRO, payee: "Market" }),
      f.txn({ id: f.tid("T2"), accountId: CHK, date: "2026-02-15", amount: -25000 as Cents, categoryId: GRO, payee: "Market" }),
      f.txn({ id: f.tid("T4"), accountId: CHK, date: "2026-04-02", amount: -1000 as Cents, categoryId: GRO, payee: "Market" }),
    ],
  };
}

const byKey = (b: LoadedBudget, month: string) =>
  new Map(assignSuggestions(computeProjection(b), GRO, month as never).map((s) => [s.key, s]));

describe("assignSuggestions", () => {
  it("offers last month's assignment and last month's spending", () => {
    const s = byKey(threeMonths(), "2026-04");
    expect(s.get("lastMonth")!.amount).toBe(30000);
    expect(s.get("spentLastMonth")).toBeUndefined(); // nothing spent in March, so nothing to offer
    const feb = byKey(threeMonths(), "2026-03");
    expect(feb.get("spentLastMonth")!.amount).toBe(25000);
  });

  it("averages only the months the budget actually covers", () => {
    const s = byKey(threeMonths(), "2026-04");
    expect(s.get("averageAssigned")).toMatchObject({ amount: 20000, months: 3 }); // (100+200+300)/3
    expect(s.get("averageSpent")).toMatchObject({ amount: 10000, months: 3 }); // (50+250+0)/3

    // Standing in February there is only one month behind us: no average at all.
    expect(byKey(threeMonths(), "2026-02").has("averageAssigned")).toBe(false);
  });

  it("rounds an average to whole cents", () => {
    const b = threeMonths();
    b.assignments = [
      f.assignment({ id: f.tid("B1"), month: "2026-01", categoryId: GRO, assigned: 10 as Cents }),
      f.assignment({ id: f.tid("B2"), month: "2026-02", categoryId: GRO, assigned: 11 as Cents }),
      f.assignment({ id: f.tid("B3"), month: "2026-03", categoryId: GRO, assigned: 10 as Cents }),
    ];
    expect(byKey(b, "2026-04").get("averageAssigned")!.amount).toBe(10); // 10.33 → 10
  });

  it("proposes the amount that lands the envelope exactly on zero", () => {
    // March: 300 assigned, nothing spent, 250 carried in from February.
    const s = byKey(threeMonths(), "2026-03");
    const p = computeProjection(threeMonths());
    const zero = s.get("zeroOut")!;
    expect(zero.amount).toBe(p.assignedOf(GRO, "2026-03") - p.availableOf(GRO, "2026-03"));

    // Applying it would leave nothing in the envelope.
    const b = threeMonths();
    b.assignments = b.assignments.map((a) => (a.month === "2026-03" ? { ...a, assigned: zero.amount } : a));
    expect(computeProjection(b).availableOf(GRO, "2026-03")).toBe(0);
  });

  it("says nothing useful about an untouched category in a fresh budget", () => {
    const b = threeMonths();
    b.assignments = [];
    b.transactions = [b.transactions[0]!];
    expect(assignSuggestions(computeProjection(b), GRO, "2026-01")).toEqual([]);
  });

  it("never counts a refund as spending", () => {
    const b = threeMonths();
    b.transactions = [
      ...b.transactions,
      f.txn({ id: f.tid("TR"), accountId: CHK, date: "2026-03-10", amount: 8000 as Cents, categoryId: GRO, payee: "Refund" }),
    ];
    expect(byKey(b, "2026-04").get("spentLastMonth")).toBeUndefined(); // March nets positive: no spending to copy
  });
});
