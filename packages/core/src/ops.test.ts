import { describe, expect, it } from "vitest";
import * as ops from "./ops.js";
import { computeProjection } from "./engine/compute.js";
import * as f from "../test/fixtures/factories.js";
import type { Cents } from "./money.js";
import type { LoadedBudget } from "./model/types.js";

const CHK = f.tid("ACHK");
const GEVD = f.tid("GEVD");
const GINC = f.tid("GINC");
const GRO = f.tid("CGRO");
const DIN = f.tid("CDIN");
const RTA = f.tid("CRTA");
const M = "2026-01";

function base(): LoadedBudget {
  return {
    budget: f.budget(),
    accounts: [f.account({ id: CHK, name: "Checking", type: "checking" })],
    groups: [
      f.group({ id: GEVD, name: "Everyday", kind: "normal", sortOrder: 0 }),
      f.group({ id: GINC, name: "Inflow", kind: "income", sortOrder: 1 }),
    ],
    categories: [
      f.category({ id: GRO, groupId: GEVD, name: "Groceries" }),
      f.category({ id: DIN, groupId: GEVD, name: "Dining" }),
      f.category({ id: RTA, groupId: GINC, name: "Ready to Assign" }),
    ],
    assignments: [
      f.assignment({ id: f.tid("A1"), month: M, categoryId: GRO, assigned: 50000 as Cents }),
      f.assignment({ id: f.tid("A2"), month: M, categoryId: DIN, assigned: 30000 as Cents }),
    ],
    transactions: [
      f.txn({ id: f.tid("TINC"), accountId: CHK, date: "2026-01-02", amount: 100000 as Cents, categoryId: RTA }),
      f.txn({ id: f.tid("TGRO"), accountId: CHK, date: "2026-01-10", amount: -20000 as Cents, categoryId: GRO }),
    ],
  };
}

describe("account ops", () => {
  it("addAccount defaults onBudget from type and appends", () => {
    let b = ops.addAccount(base(), { name: "Savings", type: "checking", household: "Personal" });
    const chk = b.accounts.find((a) => a.name === "Savings")!;
    expect(chk.onBudget).toBe(true);
    expect(chk.household).toBe("Personal");

    b = ops.addAccount(b, { name: "Brokerage", type: "tracking" });
    expect(b.accounts.find((a) => a.name === "Brokerage")!.onBudget).toBe(false);
  });

  it("setAccountClosed hides/shows and renameAccount renames", () => {
    let b = ops.setAccountClosed(base(), CHK, true);
    expect(b.accounts.find((a) => a.id === CHK)!.closed).toBe(true);
    b = ops.renameAccount(b, CHK, "Main");
    expect(b.accounts.find((a) => a.id === CHK)!.name).toBe("Main");
  });
});

describe("section ops", () => {
  it("addGroup appends a normal section with the next sortOrder", () => {
    const b = ops.addGroup(base(), { name: "Savings" });
    const g = b.groups.find((x) => x.name === "Savings")!;
    expect(g.kind).toBe("normal");
    expect(g.sortOrder).toBe(2);
  });
  it("renameGroup and setGroupHidden change only that field", () => {
    let b = ops.renameGroup(base(), GEVD, "Daily");
    expect(b.groups.find((g) => g.id === GEVD)!.name).toBe("Daily");
    b = ops.setGroupHidden(b, GEVD, true);
    expect(b.groups.find((g) => g.id === GEVD)!.hidden).toBe(true);
  });
  it("deleteGroup cascades: its categories go and their txns become uncategorized", () => {
    const b = ops.deleteGroup(base(), GEVD);
    expect(b.groups.find((g) => g.id === GEVD)).toBeUndefined();
    expect(b.categories.some((c) => c.groupId === GEVD)).toBe(false);
    expect(b.transactions.find((t) => t.id === f.tid("TGRO"))!.categoryId).toBeUndefined();
    expect(b.assignments.length).toBe(0);
  });
});

describe("ordering ops", () => {
  it("reorderCategory reorders within a section", () => {
    const b = ops.reorderCategory(base(), DIN, GEVD, 0);
    const inGevd = b.categories.filter((c) => c.groupId === GEVD).sort((a, c) => a.sortOrder - c.sortOrder).map((c) => c.id);
    expect(inGevd).toEqual([DIN, GRO]);
  });

  it("reorderCategory moves a category into another section at an index", () => {
    const b = ops.reorderCategory(base(), GRO, GINC, 0);
    const cat = b.categories.find((c) => c.id === GRO)!;
    expect(cat.groupId).toBe(GINC);
    const inInc = b.categories.filter((c) => c.groupId === GINC).sort((a, c) => a.sortOrder - c.sortOrder).map((c) => c.id);
    expect(inInc[0]).toBe(GRO);
  });

  it("setGroupOrder applies an explicit section order", () => {
    const withOther = ops.addGroup(base(), { name: "Bills" });
    const other = withOther.groups.find((g) => g.name === "Bills")!.id;
    const b = ops.setGroupOrder(withOther, [other, GEVD]);
    expect(b.groups.find((g) => g.id === other)!.sortOrder).toBe(0);
    expect(b.groups.find((g) => g.id === GEVD)!.sortOrder).toBe(1);
  });

  it("setCategoryOrder applies an explicit order", () => {
    const b = ops.setCategoryOrder(base(), GEVD, [DIN, GRO]);
    expect(b.categories.find((c) => c.id === DIN)!.sortOrder).toBe(0);
    expect(b.categories.find((c) => c.id === GRO)!.sortOrder).toBe(1);
  });

  it("setAccountOrder applies an explicit order", () => {
    const start = ops.addAccount(base(), { name: "Second", type: "checking" });
    const [a1, a2] = start.accounts.map((a) => a.id) as [any, any];
    const b = ops.setAccountOrder(start, [a2, a1]);
    expect(b.accounts.find((a) => a.id === a2)!.sortOrder).toBe(0);
    expect(b.accounts.find((a) => a.id === a1)!.sortOrder).toBe(1);
  });
});

describe("category ops", () => {
  it("addCategory places it under the group", () => {
    const b = ops.addCategory(base(), { groupId: GEVD, name: "Fun" });
    const c = b.categories.find((x) => x.name === "Fun")!;
    expect(c.groupId).toBe(GEVD);
  });
  it("rename / move / hide change only the intended field", () => {
    let b = ops.renameCategory(base(), GRO, "Food");
    expect(b.categories.find((c) => c.id === GRO)!.name).toBe("Food");
    b = ops.moveCategory(b, GRO, GINC);
    expect(b.categories.find((c) => c.id === GRO)!.groupId).toBe(GINC);
    b = ops.setCategoryHidden(b, GRO, true);
    expect(b.categories.find((c) => c.id === GRO)!.hidden).toBe(true);
  });
  it("deleteCategory drops assignments and uncategorizes its transactions", () => {
    const b = ops.deleteCategory(base(), GRO);
    expect(b.categories.find((c) => c.id === GRO)).toBeUndefined();
    expect(b.assignments.some((a) => a.categoryId === GRO)).toBe(false);
    expect(b.transactions.find((t) => t.id === f.tid("TGRO"))!.categoryId).toBeUndefined();
  });
});

describe("assignment ops", () => {
  it("setAssigned upserts", () => {
    const b = ops.setAssigned(base(), M, GRO, 12345 as Cents);
    expect(ops.getAssigned(b, M, GRO)).toBe(12345);
    const b2 = ops.setAssigned(b, "2026-02", DIN, 999 as Cents);
    expect(ops.getAssigned(b2, "2026-02", DIN)).toBe(999);
  });

  it("coverShortfall moves exactly the shortfall when the donor can afford it", () => {
    // DIN: assigned 30000, spend 40000 -> available -10000. GRO has 30000 spare.
    const withHole = ops.addTransaction(
      base(),
      f.txn({ id: f.tid("TDIN"), accountId: CHK, date: "2026-01-12", amount: -40000 as Cents, categoryId: DIN }),
    );
    const b = ops.coverShortfall(withHole, M, GRO, DIN);
    const p = computeProjection(b);
    expect(p.availableOf(DIN, M)).toBe(0);
    expect(p.availableOf(GRO, M)).toBe(20000); // 30000 - 10000
  });

  it("coverShortfall never overdraws the donor (clamps to its available)", () => {
    // DIN: assigned 30000, spend 100000 -> available -70000. GRO only has 30000.
    const withHole = ops.addTransaction(
      base(),
      f.txn({ id: f.tid("TDIN"), accountId: CHK, date: "2026-01-12", amount: -100000 as Cents, categoryId: DIN }),
    );
    const b = ops.coverShortfall(withHole, M, GRO, DIN);
    const p = computeProjection(b);
    expect(p.availableOf(GRO, M)).toBe(0); // drained exactly to zero, not below
    expect(p.availableOf(DIN, M)).toBe(-40000); // hole shrinks by what GRO had
  });

  it("coverShortfall is a no-op without a shortfall", () => {
    const b = base(); // DIN is not negative here
    expect(ops.coverShortfall(b, M, GRO, DIN)).toBe(b); // same object back
  });

  it("moveMoney shifts Available between categories but leaves Ready to Assign unchanged", () => {
    const before = computeProjection(base());
    const rtaBefore = before.readyToAssignOf(M);
    const groBefore = before.availableOf(GRO, M);
    const dinBefore = before.availableOf(DIN, M);

    const b = ops.moveMoney(base(), M, GRO, DIN, 10000 as Cents);
    const after = computeProjection(b);

    expect(after.readyToAssignOf(M)).toBe(rtaBefore);
    expect(after.availableOf(GRO, M)).toBe(groBefore - 10000);
    expect(after.availableOf(DIN, M)).toBe(dinBefore + 10000);
  });
});

describe("transaction ops", () => {
  it("addTransaction affects activity, available and balance", () => {
    const b = ops.addTransaction(
      base(),
      f.txn({ id: f.tid("TX9"), accountId: CHK, date: "2026-01-20", amount: -5000 as Cents, categoryId: DIN }),
    );
    const p = computeProjection(b);
    expect(p.activityOf(DIN, M)).toBe(-5000);
    expect(p.accountBalances().get(CHK)).toBe(100000 - 20000 - 5000);
  });

  it("updateTransaction changes the amount and downstream activity", () => {
    const b = ops.updateTransaction(base(), f.tid("TGRO"), { amount: -30000 as Cents });
    expect(computeProjection(b).activityOf(GRO, M)).toBe(-30000);
  });

  it("deleteTransaction reverts its effect", () => {
    const b = ops.deleteTransaction(base(), f.tid("TGRO"));
    expect(computeProjection(b).activityOf(GRO, M)).toBe(0);
  });

  it("approving a repeating scheduled txn enters the next occurrence", () => {
    const withRepeat = ops.addTransaction(
      base(),
      f.txn({
        id: f.tid("TR"), accountId: CHK, date: "2026-01-31", amount: -4000 as Cents, categoryId: DIN,
        approved: false, recurrence: { freq: "monthly", anchorDay: 31 },
      }),
    );
    const b = ops.approveTransaction(withRepeat, f.tid("TR"));
    expect(b.transactions.find((t) => t.id === f.tid("TR"))!.approved).toBe(true);
    const next = b.transactions.find((t) => !t.approved && t.recurrence);
    expect(next).toMatchObject({ date: "2026-02-28", amount: -4000, cleared: "uncleared" });
    expect(next!.id).not.toBe(f.tid("TR"));
    expect(next!.source).toBeUndefined();
    // The anchor day survives the short month: approving Feb's lands on Mar 31.
    const b2 = ops.approveTransaction(b, next!.id);
    expect(b2.transactions.find((t) => !t.approved && t.recurrence)!.date).toBe("2026-03-31");
    // Re-approving an already-approved row spawns nothing.
    expect(ops.approveTransaction(b2, f.tid("TR")).transactions).toHaveLength(b2.transactions.length);
  });

  it("renamePayee renames exact matches everywhere and ignores empty targets", () => {
    const two = ops.addTransaction(base(), f.txn({ id: f.tid("TX2"), accountId: CHK, date: "2026-01-21", amount: -100 as Cents, payee: "Shop A" }));
    const renamed = ops.renamePayee(
      ops.updateTransaction(two, f.tid("TGRO"), { payee: "Shop A" }),
      "Shop A",
      "Shop B",
    );
    expect(renamed.transactions.filter((t) => t.payee === "Shop B")).toHaveLength(2);
    expect(ops.renamePayee(renamed, "Shop B", "  ")).toBe(renamed);
  });

  it("setClearedStatus and deleteTransactions act on many rows at once", () => {
    const b = ops.setClearedStatus(base(), [f.tid("TGRO"), f.tid("TINC")], "reconciled");
    expect(b.transactions.filter((t) => t.cleared === "reconciled").length).toBeGreaterThanOrEqual(2);
    const d = ops.deleteTransactions(base(), [f.tid("TGRO")]);
    expect(d.transactions.find((t) => t.id === f.tid("TGRO"))).toBeUndefined();
  });

  it("reconcileAccount marks rows reconciled and never moves the through-date backwards", () => {
    const b1 = ops.reconcileAccount(base(), CHK, [f.tid("TGRO")], "2026-01-31");
    expect(b1.transactions.find((t) => t.id === f.tid("TGRO"))!.cleared).toBe("reconciled");
    expect(b1.accounts.find((a) => a.id === CHK)!.reconciledThrough).toBe("2026-01-31");

    const b2 = ops.reconcileAccount(b1, CHK, [], "2026-01-15"); // older statement re-run
    expect(b2.accounts.find((a) => a.id === CHK)!.reconciledThrough).toBe("2026-01-31");

    const b3 = ops.reconcileAccount(b2, CHK, [], "2026-02-28");
    expect(b3.accounts.find((a) => a.id === CHK)!.reconciledThrough).toBe("2026-02-28");
  });

  it("approveTransaction makes a scheduled txn count", () => {
    const withScheduled = ops.addTransaction(
      base(),
      f.txn({ id: f.tid("TS"), accountId: CHK, date: "2026-01-25", amount: -4000 as Cents, categoryId: DIN, approved: false }),
    );
    expect(computeProjection(withScheduled).activityOf(DIN, M)).toBe(0);
    const approved = ops.approveTransaction(withScheduled, f.tid("TS"));
    expect(computeProjection(approved).activityOf(DIN, M)).toBe(-4000);
  });

  it("setSplits enforces the sum, splits activity across categories, and unsplits back", () => {
    const bad = () =>
      ops.setSplits(base(), f.tid("TGRO"), [
        { id: f.tid("S1"), categoryId: GRO, amount: -12000 as Cents, memo: "" },
        { id: f.tid("S2"), categoryId: DIN, amount: -5000 as Cents, memo: "" }, // sums to -17000, not -20000
      ]);
    expect(bad).toThrow(/must sum/);

    const split = ops.setSplits(base(), f.tid("TGRO"), [
      { id: f.tid("S1"), categoryId: GRO, amount: -12000 as Cents, memo: "food" },
      { id: f.tid("S2"), categoryId: DIN, amount: -8000 as Cents, memo: "wine" },
    ]);
    const tx = split.transactions.find((t) => t.id === f.tid("TGRO"))!;
    expect(tx.categoryId).toBeUndefined();
    expect(tx.splits).toHaveLength(2);
    const p = computeProjection(split);
    expect(p.activityOf(GRO, M)).toBe(-12000);
    expect(p.activityOf(DIN, M)).toBe(-8000);

    const unsplit = ops.setSplits(split, f.tid("TGRO"), undefined, GRO);
    const tx2 = unsplit.transactions.find((t) => t.id === f.tid("TGRO"))!;
    expect(tx2.splits).toBeUndefined();
    expect(tx2.categoryId).toBe(GRO);
  });
});
