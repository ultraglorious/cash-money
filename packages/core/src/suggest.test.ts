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
      f.assignment({ id: f.tid("B2"), month: "2026-02", categoryId: GRO, assigned: 12 as Cents }),
      f.assignment({ id: f.tid("B3"), month: "2026-03", categoryId: GRO, assigned: 13 as Cents }),
    ];
    expect(byKey(b, "2026-04").get("averageAssigned")!.amount).toBe(12); // 11.67 → 12
  });

  /** Two months, so an envelope can carry something in from the first. */
  function carried(janAssigned: number, janSpent: number, febAssigned: number, febSpent: number): LoadedBudget {
    const b = threeMonths();
    b.assignments = [
      f.assignment({ id: f.tid("C1"), month: "2026-01", categoryId: GRO, assigned: janAssigned as Cents }),
      f.assignment({ id: f.tid("C2"), month: "2026-02", categoryId: GRO, assigned: febAssigned as Cents }),
    ];
    b.transactions = [
      b.transactions[0]!, // the income row, so the months exist
      f.txn({ id: f.tid("CJ"), accountId: CHK, date: "2026-01-15", amount: -janSpent as Cents, categoryId: GRO, payee: "Market" }),
      f.txn({ id: f.tid("CF"), accountId: CHK, date: "2026-02-15", amount: -febSpent as Cents, categoryId: GRO, payee: "Market" }),
    ];
    return b;
  }

  it("resetAssigned takes back this month's assignment, leaving what carried in", () => {
    // January leaves 100 in the envelope; February adds 50 more.
    const b = carried(10000, 0, 5000, 0);
    expect(byKey(b, "2026-02").get("resetAssigned")!.amount).toBe(0);

    b.assignments = b.assignments.filter((a) => a.month !== "2026-02");
    expect(computeProjection(b).availableOf(GRO, "2026-02")).toBe(10000); // January's 100 survives
  });

  it("resetAvailable empties the envelope, clawing a carried surplus back", () => {
    const b = carried(10000, 0, 5000, 0);
    const reset = byKey(b, "2026-02").get("resetAvailable")!;
    expect(reset.amount).toBe(-10000); // a negative assignment hands the 100 back

    b.assignments = b.assignments.map((a) => (a.month === "2026-02" ? { ...a, assigned: reset.amount } : a));
    expect(computeProjection(b).availableOf(GRO, "2026-02")).toBe(0);
  });

  it("resetAvailable covers an overspend with a positive assignment", () => {
    const b = carried(0, 0, 5000, 20000); // 50 assigned against 200 spent
    const reset = byKey(b, "2026-02").get("resetAvailable")!;
    expect(reset.amount).toBe(20000); // assign the full 200

    b.assignments = b.assignments.map((a) => (a.month === "2026-02" ? { ...a, assigned: reset.amount } : a));
    expect(computeProjection(b).availableOf(GRO, "2026-02")).toBe(0);
  });

  it("offers only one reset when the two would do the same thing", () => {
    // Nothing carried in and nothing spent: emptying the envelope IS taking the
    // assignment back, so there is one option rather than two identical ones.
    const s = byKey(carried(0, 0, 5000, 0), "2026-02");
    expect(s.get("resetAssigned")!.amount).toBe(0);
    expect(s.has("resetAvailable")).toBe(false);
  });

  describe("envelopes that aren't filled every month", () => {
    /**
     * Travel, in miniature: funded and spent in two scattered months, nothing
     * in between. The calendar questions all answer zero here.
     */
    function lumpy(): LoadedBudget {
      const b = threeMonths();
      b.assignments = [
        f.assignment({ id: f.tid("L1"), month: "2025-06", categoryId: GRO, assigned: 90000 as Cents }),
        f.assignment({ id: f.tid("L2"), month: "2025-11", categoryId: GRO, assigned: 50000 as Cents }),
      ];
      b.transactions = [
        f.txn({ id: f.tid("LI"), accountId: CHK, date: "2025-01-01", amount: 900000 as Cents, categoryId: RTA, payee: "Employer" }),
        f.txn({ id: f.tid("LJ"), accountId: CHK, date: "2025-06-14", amount: -90000 as Cents, categoryId: GRO, payee: "Airline" }),
        f.txn({ id: f.tid("LK"), accountId: CHK, date: "2025-11-03", amount: -40000 as Cents, categoryId: GRO, payee: "Airline" }),
      ];
      return b;
    }

    it("answers from the months it was actually funded, when the calendar can't", () => {
      const s = byKey(lumpy(), "2026-04");
      // Nothing in the three months behind us, so the usual questions are silent.
      expect(s.has("lastMonth")).toBe(false);
      expect(s.has("averageAssigned")).toBe(false);
      // But the envelope has a rhythm, and these read it.
      expect(s.get("lastFunded")).toMatchObject({ amount: 50000, month: "2025-11" });
      expect(s.get("typicalWhenFunded")).toMatchObject({ amount: 70000, months: 2 }); // (900 + 500) / 2
      expect(s.get("spentLastTime")).toMatchObject({ amount: 40000, month: "2025-11" });
    });

    it("keeps quiet when the ordinary answers already say the same thing", () => {
      // A category funded steadily: last time funded IS last month, so offering
      // both would be one choice wearing two labels.
      const s = byKey(threeMonths(), "2026-04");
      expect(s.get("lastMonth")!.amount).toBe(30000);
      expect(s.has("lastFunded")).toBe(false);
    });

    it("looks back further than the averages do, but not forever", () => {
      const b = lumpy();
      // Push the funding outside the two-year window and it drops off.
      b.assignments = [f.assignment({ id: f.tid("L9"), month: "2023-01", categoryId: GRO, assigned: 90000 as Cents })];
      b.transactions = [
        ...b.transactions,
        f.txn({ id: f.tid("LO"), accountId: CHK, date: "2023-01-05", amount: -90000 as Cents, categoryId: GRO, payee: "Airline" }),
      ];
      const s = byKey(b, "2026-04");
      expect(s.has("lastFunded")).toBe(false);
      expect(s.has("typicalWhenFunded")).toBe(false);
    });
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
