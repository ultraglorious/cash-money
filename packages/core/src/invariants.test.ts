import { describe, expect, it } from "vitest";
import { applyPreservingNumbers, projectionDrift } from "./invariants.js";
import * as ops from "./ops.js";
import * as f from "../test/fixtures/factories.js";
import type { Cents } from "./money.js";
import type { LoadedBudget } from "./model/types.js";

const CHK = f.tid("ACHK");
const JNT = f.tid("AJNT");
const GINC = f.tid("GINC");
const GEVD = f.tid("GEVD");
const RTA = f.tid("CRTA");
const GRO = f.tid("CGRO");

function budget(): LoadedBudget {
  return {
    budget: f.budget(),
    accounts: [
      f.account({ id: CHK, name: "Checking", type: "checking", onBudget: true, household: "Personal" }),
      f.account({ id: JNT, name: "Joint", type: "checking", onBudget: true, household: "Joint" }),
    ],
    groups: [
      f.group({ id: GINC, name: "Inflow", kind: "income", household: "Personal" }),
      f.group({ id: GEVD, name: "Everyday", kind: "normal", household: "Personal" }),
    ],
    categories: [f.category({ id: RTA, groupId: GINC, name: "Ready to Assign" }), f.category({ id: GRO, groupId: GEVD, name: "Groceries" })],
    assignments: [f.assignment({ id: f.tid("A1"), month: "2026-06", categoryId: GRO, assigned: 20000 as Cents })],
    transactions: [
      f.txn({ id: f.tid("T1"), accountId: CHK, date: "2026-06-01", amount: 300000 as Cents, categoryId: RTA, payee: "Employer" }),
      f.txn({ id: f.tid("T2"), accountId: CHK, date: "2026-06-10", amount: -15000 as Cents, categoryId: GRO, payee: "Market" }),
    ],
  };
}

describe("projectionDrift", () => {
  it("says nothing when an edit only renames things", () => {
    const b = budget();
    expect(projectionDrift(b, ops.renamePayee(b, "Market", "Supermarket"))).toEqual([]);
  });

  it("catches money moving, and says where", () => {
    const b = budget();
    const moved = ops.setAssigned(b, "2026-06", GRO, 25000 as Cents);
    const drift = projectionDrift(b, moved);
    expect(drift.length).toBeGreaterThan(0);
    expect(drift.some((d) => d.kind === "available" && d.key === GRO && d.after - d.before === 5000)).toBe(true);
    expect(drift.some((d) => d.kind === "readyToAssign" && d.key === "Personal")).toBe(true);
  });

  it("catches a balance change even when the envelopes agree", () => {
    const b = budget();
    const extra = ops.addTransaction(b, f.txn({ id: f.tid("T9"), accountId: JNT, date: "2026-06-20", amount: 5000 as Cents, categoryId: undefined, payee: "Gift" }));
    expect(projectionDrift(b, extra).some((d) => d.kind === "balance" && d.key === JNT)).toBe(true);
  });
});

describe("applyPreservingNumbers", () => {
  it("lets a number-preserving edit through", () => {
    const b = budget();
    const { budget: next, drift } = applyPreservingNumbers(b, (x) => ops.renamePayee(x, "Market", "Supermarket"));
    expect(drift).toEqual([]);
    expect(next.transactions.find((t) => t.id === f.tid("T2"))!.payee).toBe("Supermarket");
  });

  it("refuses one that isn't, handing back the original budget untouched", () => {
    const b = budget();
    const { budget: next, drift } = applyPreservingNumbers(b, (x) => ops.setAssigned(x, "2026-06", GRO, 999 as Cents));
    expect(drift.length).toBeGreaterThan(0);
    expect(next).toBe(b); // the bad edit never escapes
  });
});
