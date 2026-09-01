import { describe, expect, it } from "vitest";
import * as ops from "./ops.js";
import { fingerprint } from "./ids.js";
import { nameIncomingRow } from "./import/payee.js";
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

  it("addTransfer creates both legs, linked and equal-and-opposite", () => {
    const SAV = f.tid("ASAV");
    const withSavings = { ...base(), accounts: [...base().accounts, f.account({ id: SAV, name: "Savings", type: "checking" })] };
    const b = ops.addTransfer(withSavings, {
      accountId: CHK, counterAccountId: SAV, date: "2026-01-20", amount: -25000 as Cents,
      memo: "stash", approved: true, clearedThis: "cleared", clearedCounter: "uncleared",
    });
    const legs = b.transactions.filter((t) => t.transfer);
    expect(legs).toHaveLength(2);
    const [a, c] = legs[0]!.accountId === CHK ? [legs[0]!, legs[1]!] : [legs[1]!, legs[0]!];
    expect(a).toMatchObject({ amount: -25000, payee: "Transfer to: Savings", cleared: "cleared" });
    expect(c).toMatchObject({ accountId: SAV, amount: 25000, payee: "Transfer from: Checking", cleared: "uncleared" });
    expect(a.transfer!.pairId).toBe(c.transfer!.pairId);
    const p = computeProjection(b);
    expect(p.accountBalances().get(CHK)).toBe(100000 - 20000 - 25000);
    expect(p.accountBalances().get(SAV)).toBe(25000);
  });

  it("updateTransfer mirrors edits onto the other leg", () => {
    const SAV = f.tid("ASAV");
    const withSavings = { ...base(), accounts: [...base().accounts, f.account({ id: SAV, name: "Savings", type: "checking" })] };
    let b = ops.addTransfer(withSavings, {
      accountId: CHK, counterAccountId: SAV, date: "2026-01-20", amount: -25000 as Cents,
      memo: "stash", approved: true, clearedThis: "cleared", clearedCounter: "uncleared",
    });
    const leg = b.transactions.find((t) => t.transfer && t.accountId === CHK)!;
    b = ops.updateTransfer(b, leg.id, { amount: -30000 as Cents, date: "2026-01-21", memo: "more" });
    const [a2, c2] = [b.transactions.find((t) => t.id === leg.id)!, b.transactions.find((t) => t.transfer && t.id !== leg.id)!];
    expect(a2).toMatchObject({ amount: -30000, date: "2026-01-21", memo: "more" });
    expect(c2).toMatchObject({ amount: 30000, date: "2026-01-21", memo: "more", cleared: "uncleared" });
  });

  it("a cross-household transfer carries its funding envelope on the outflow leg only", () => {
    const SAV = f.tid("ASAV");
    const withSavings = { ...base(), accounts: [...base().accounts, f.account({ id: SAV, name: "Savings", type: "checking" })] };
    let b = ops.addTransfer(withSavings, {
      accountId: CHK, counterAccountId: SAV, date: "2026-01-20", amount: -25000 as Cents,
      memo: "", approved: true, clearedThis: "cleared", clearedCounter: "uncleared", categoryId: DIN,
    });
    const out = b.transactions.find((t) => t.transfer && t.amount < 0)!;
    const inn = b.transactions.find((t) => t.transfer && t.amount > 0)!;
    expect(out.categoryId).toBe(DIN);
    expect(inn.categoryId).toBeUndefined();
    // Editing the amount keeps the envelope on the outflow leg.
    b = ops.updateTransfer(b, inn.id, { amount: 30000 as Cents });
    expect(b.transactions.find((t) => t.id === out.id)!.categoryId).toBe(DIN);
    expect(b.transactions.find((t) => t.id === inn.id)!.categoryId).toBeUndefined();
    // Explicitly clearing it clears it.
    b = ops.updateTransfer(b, out.id, { categoryId: undefined });
    expect(b.transactions.find((t) => t.id === out.id)!.categoryId).toBeUndefined();
  });

  it("normalizeTransferPayees rewrites imported transfer payees, idempotently, leaving the rest alone", () => {
    const SAV = f.tid("ASAV");
    const pair = f.tid("PN1");
    const withImported = {
      ...base(),
      accounts: [...base().accounts, f.account({ id: SAV, name: "Savings", type: "checking" })],
    };
    withImported.transactions = [
      ...withImported.transactions,
      f.txn({ id: f.tid("TL1"), accountId: CHK, date: "2026-01-12", amount: -5000 as Cents, payee: "Transfer : Savings", transfer: { counterAccountId: SAV, pairId: pair } }),
      f.txn({ id: f.tid("TL2"), accountId: SAV, date: "2026-01-12", amount: 5000 as Cents, payee: "Transfer : Checking", transfer: { counterAccountId: CHK, pairId: pair } }),
    ];
    const { budget: b, changed } = ops.normalizeTransferPayees(withImported);
    expect(changed).toBe(2);
    expect(b.transactions.find((t) => t.id === f.tid("TL1"))!.payee).toBe("Transfer to: Savings");
    expect(b.transactions.find((t) => t.id === f.tid("TL2"))!.payee).toBe("Transfer from: Checking");
    expect(b.transactions.find((t) => t.id === f.tid("TGRO"))!.payee).toBe(withImported.transactions.find((t) => t.id === f.tid("TGRO"))!.payee);
    const again = ops.normalizeTransferPayees(b);
    expect(again.changed).toBe(0);
    expect(again.budget).toBe(b); // untouched object when nothing changes
  });

  it("deleting or approving one transfer leg takes both", () => {
    const SAV = f.tid("ASAV");
    const withSavings = { ...base(), accounts: [...base().accounts, f.account({ id: SAV, name: "Savings", type: "checking" })] };
    let b = ops.addTransfer(withSavings, {
      accountId: CHK, counterAccountId: SAV, date: "2026-01-20", amount: -25000 as Cents,
      memo: "", approved: false, clearedThis: "uncleared", clearedCounter: "uncleared",
    });
    const leg = b.transactions.find((t) => t.transfer)!;
    const approved = ops.approveTransactions(b, [leg.id]);
    expect(approved.transactions.filter((t) => t.transfer && t.approved)).toHaveLength(2);
    b = ops.deleteTransaction(b, leg.id);
    expect(b.transactions.some((t) => t.transfer)).toBe(false);
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

  it("approveTransaction makes a scheduled txn count, entering it as uncleared", () => {
    const withScheduled = ops.addTransaction(
      base(),
      f.txn({ id: f.tid("TS"), accountId: CHK, date: "2026-01-25", amount: -4000 as Cents, categoryId: DIN, approved: false, cleared: "cleared" }),
    );
    expect(computeProjection(withScheduled).activityOf(DIN, M)).toBe(0);
    const approved = ops.approveTransaction(withScheduled, f.tid("TS"));
    expect(computeProjection(approved).activityOf(DIN, M)).toBe(-4000);
    expect(approved.transactions.find((t) => t.id === f.tid("TS"))!.cleared).toBe("uncleared");
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

describe("ops that had no test until something depended on them", () => {
  it("scheduledSuccessor advances the date, resets approval and mints fresh ids", () => {
    const monthly = f.txn({
      id: f.tid("TREC"), accountId: CHK, date: "2026-01-31", amount: -4000 as Cents, categoryId: DIN,
      payee: "Gym", cleared: "cleared", recurrence: { freq: "monthly", anchorDay: 31 },
      source: {
        sourceBudget: "x",
        naturalKey: fingerprint(["gym"]),
        identity: fingerprint(["gym", "2026-01-31"]),
        occurrenceIndex: 0,
        firstSeenExportTs: "2026-01-31",
        lastSeenExportTs: "2026-01-31",
      },
    });
    const next = ops.scheduledSuccessor(monthly)!;
    expect(next.date).toBe("2026-02-28"); // short months clamp, honouring the anchor
    expect(next.effectiveDate).toBe(next.date);
    expect(next.approved).toBe(false);
    expect(next.cleared).toBe("uncleared");
    expect(next.id).not.toBe(monthly.id);
    expect(next.payee).toBe("Gym");
    expect(next.recurrence).toEqual(monthly.recurrence); // it keeps repeating
    // Import provenance belongs to the row that was imported, not to its child:
    // inheriting it would make the successor look like a duplicate of the original.
    expect(next.source).toBeUndefined();

    // A March successor picks the anchor back up rather than staying at the 28th.
    expect(ops.scheduledSuccessor(next)!.date).toBe("2026-03-31");
    expect(ops.scheduledSuccessor({ ...monthly, recurrence: undefined })).toBeNull();
  });

  it("scheduledSuccessor gives a split successor its own split ids", () => {
    const split = f.txn({
      id: f.tid("TSPL"), accountId: CHK, date: "2026-01-05", amount: -10000 as Cents, categoryId: undefined,
      recurrence: { freq: "weekly" },
      splits: [
        { id: f.tid("S1"), categoryId: GRO, amount: -6000 as Cents, memo: "" },
        { id: f.tid("S2"), categoryId: DIN, amount: -4000 as Cents, memo: "" },
      ],
    });
    const next = ops.scheduledSuccessor(split)!;
    expect(next.date).toBe("2026-01-12");
    expect(next.splits!.map((s) => s.id)).not.toEqual(split.splits!.map((s) => s.id));
    expect(next.splits!.map((s) => s.amount)).toEqual([-6000, -4000]);
  });

  it("addTransactions and setTransactions add and replace wholesale", () => {
    const extra = [
      f.txn({ id: f.tid("TX1"), accountId: CHK, date: "2026-01-20", amount: -1000 as Cents, categoryId: DIN }),
      f.txn({ id: f.tid("TX2"), accountId: CHK, date: "2026-01-21", amount: -2000 as Cents, categoryId: DIN }),
    ];
    const added = ops.addTransactions(base(), extra);
    expect(added.transactions).toHaveLength(4);
    expect(computeProjection(added).activityOf(DIN, M)).toBe(-3000);

    const replaced = ops.setTransactions(added, extra);
    expect(replaced.transactions).toEqual(extra);
    expect(computeProjection(replaced).activityOf(GRO, M)).toBe(0); // the old rows are gone

    expect(ops.addTransactions(base(), []).transactions).toHaveLength(2);
  });

  it("setHouseholdOrder records the display order without touching anything else", () => {
    const b = ops.setHouseholdOrder(base(), ["Joint", "Personal"]);
    expect(b.budget.householdOrder).toEqual(["Joint", "Personal"]);
    expect(b.transactions).toEqual(base().transactions);
    expect(ops.setHouseholdOrder(b, []).budget.householdOrder).toEqual([]);
  });
});

describe("repeating transfers", () => {
  const SAV = f.tid("ASAV");
  function withSavings(): LoadedBudget {
    const b = base();
    return { ...b, accounts: [...b.accounts, f.account({ id: SAV, name: "Savings", type: "checking" })] };
  }
  const monthly = { freq: "monthly" as const, anchorDay: 15 };

  it("carries the cadence onto both legs, and schedules the next pair when it already happened", () => {
    const b = ops.addTransfer(withSavings(), {
      accountId: CHK, counterAccountId: SAV, date: "2026-01-15", amount: -25000 as Cents,
      memo: "", approved: true, clearedThis: "cleared", clearedCounter: "cleared", recurrence: monthly,
    });
    const now = b.transactions.filter((t) => t.date === "2026-01-15");
    expect(now).toHaveLength(2);
    expect(now.every((t) => t.recurrence?.freq === "monthly")).toBe(true);

    // Both halves of February are there, linked to each other and to nothing else.
    const next = b.transactions.filter((t) => t.date === "2026-02-15");
    expect(next).toHaveLength(2);
    expect(next[0]!.transfer!.pairId).toBe(next[1]!.transfer!.pairId);
    expect(next[0]!.transfer!.pairId).not.toBe(now[0]!.transfer!.pairId);
    expect(next.map((t) => t.amount).sort((x, y) => x - y)).toEqual([-25000, 25000]);
    expect(next.every((t) => !t.approved && t.cleared === "uncleared")).toBe(true);
  });

  it("approving a scheduled pair spawns the next one, still paired", () => {
    const scheduled = ops.addTransfer(withSavings(), {
      accountId: CHK, counterAccountId: SAV, date: "2026-03-15", amount: -25000 as Cents,
      memo: "", approved: false, clearedThis: "uncleared", clearedCounter: "uncleared", recurrence: monthly,
    });
    expect(scheduled.transactions.filter((t) => t.transfer)).toHaveLength(2); // nothing scheduled ahead yet

    const leg = scheduled.transactions.find((t) => t.accountId === CHK && t.transfer)!;
    const approved = ops.approveTransactions(scheduled, [leg.id]);

    const april = approved.transactions.filter((t) => t.date === "2026-04-15");
    expect(april).toHaveLength(2);
    expect(april[0]!.transfer!.pairId).toBe(april[1]!.transfer!.pairId);
    // …and the pair that spawned them is approved, both halves of it.
    expect(approved.transactions.filter((t) => t.date === "2026-03-15").every((t) => t.approved)).toBe(true);
    // Each account nets zero across the scheduled pair: it is still a transfer.
    expect(april.reduce((s, t) => s + t.amount, 0)).toBe(0);
  });

  it("leaves a half-linked leg unpaired rather than inventing a partner", () => {
    // A lone leg (a damaged import) must not spawn a successor pointing at nothing.
    const b = withSavings();
    const lone = f.txn({
      id: f.tid("TLON"), accountId: CHK, date: "2026-01-15", amount: -25000 as Cents, categoryId: undefined,
      approved: false, recurrence: monthly, transfer: { counterAccountId: SAV, pairId: f.tid("PLON") },
    });
    const approved = ops.approveTransactions(ops.addTransaction(b, lone), [lone.id]);
    const next = approved.transactions.find((t) => t.date === "2026-02-15")!;
    expect(next.transfer).toBeUndefined();
  });

  it("mirrors a cadence change onto the other leg", () => {
    const b = ops.addTransfer(withSavings(), {
      accountId: CHK, counterAccountId: SAV, date: "2026-01-15", amount: -25000 as Cents,
      memo: "", approved: false, clearedThis: "uncleared", clearedCounter: "uncleared",
    });
    const leg = b.transactions.find((t) => t.accountId === CHK && t.transfer)!;
    const weekly = ops.updateTransfer(b, leg.id, { recurrence: { freq: "weekly" } });
    expect(weekly.transactions.filter((t) => t.transfer).every((t) => t.recurrence?.freq === "weekly")).toBe(true);

    const stopped = ops.updateTransfer(weekly, leg.id, { recurrence: undefined });
    expect(stopped.transactions.filter((t) => t.transfer).every((t) => t.recurrence === undefined)).toBe(true);
  });
});

describe("the payee master list", () => {
  const withPayees = (): LoadedBudget => ({
    ...base(),
    transactions: [
      f.txn({ id: f.tid("PT1"), accountId: CHK, date: "2026-01-05", amount: -1000 as Cents, categoryId: GRO, payee: "Northwind" }),
      f.txn({ id: f.tid("PT2"), accountId: CHK, date: "2026-01-06", amount: -2000 as Cents, categoryId: GRO, payee: "Greengrocer" }),
      f.txn({
        id: f.tid("PT3"), accountId: CHK, date: "2026-01-07", amount: -500 as Cents, categoryId: undefined,
        payee: "Transfer to: Savings", transfer: { counterAccountId: f.tid("ASAV"), pairId: f.tid("PP1") },
      }),
    ],
  });

  it("syncPayees mints one entry per spelling, skips transfer legs, and does nothing twice", () => {
    const first = ops.syncPayees(withPayees());
    expect(first.added).toBe(2);
    expect(first.budget.payees!.map((p) => p.name).sort()).toEqual(["Greengrocer", "Northwind"]);

    const again = ops.syncPayees(first.budget);
    expect(again.added).toBe(0);
    expect(again.budget).toBe(first.budget); // untouched, so no needless save
  });

  it("keeps aliases through a rename — the whole point of the id", () => {
    let b = ops.syncPayees(withPayees()).budget;
    const northwind = b.payees!.find((p) => p.name === "Northwind")!;
    b = ops.addPayeeAlias(b, northwind.id, "AS Northwind Bank");
    b = ops.renamePayee(b, "Northwind", "AS Northwind Bank");

    const renamed = b.payees!.find((p) => p.id === northwind.id)!;
    expect(renamed.name).toBe("AS Northwind Bank");
    // The recorded alias survives, and the OLD spelling joins it — the rename
    // itself is evidence that "northwind" means this payee.
    expect([...renamed.aliases].sort()).toEqual(["as northwind bank", "northwind"]);
    expect(b.transactions.find((t) => t.id === f.tid("PT1"))!.payee).toBe("AS Northwind Bank");
  });

  it("renaming onto an existing payee merges them and keeps both sets of aliases", () => {
    let b = ops.syncPayees(withPayees()).budget;
    const northwind = b.payees!.find((p) => p.name === "Northwind")!;
    const greengrocer = b.payees!.find((p) => p.name === "Greengrocer")!;
    b = ops.addPayeeAlias(b, northwind.id, "as northwind bank");
    b = ops.addPayeeAlias(b, greengrocer.id, "greengrocer oü");
    b = ops.renamePayee(b, "Northwind", "Greengrocer");

    expect(b.payees).toHaveLength(1);
    expect(b.payees![0]!.name).toBe("Greengrocer");
    // Both recorded aliases survive the merge, plus the merged-away name itself.
    expect([...b.payees![0]!.aliases].sort()).toEqual(["as northwind bank", "greengrocer oü", "northwind"]);
    expect(b.transactions.filter((t) => t.payee === "Greengrocer")).toHaveLength(2);
  });

  it("a rename teaches the import: the old bank spelling becomes a live alias", () => {
    // The commit-fast-tidy-later workflow: a processor string was committed as
    // the payee, then renamed onto the real one in the payees screen. The next
    // statement's row — different per-transaction id, same stem — must land on
    // the real payee via the alias, no wizard correction needed.
    let b = ops.ensurePayee(base(), "Rideco").budget;
    b = ops.ensurePayee(b, "RIDECO.EU/O/1234567890").budget;
    b = ops.renamePayee(b, "RIDECO.EU/O/1234567890", "Rideco");

    const rideco = b.payees!.find((p) => p.name === "Rideco")!;
    expect(rideco.aliases).toEqual(["rideco.eu/o"]); // the stem, not the dead id

    const next = nameIncomingRow({ payee: "RIDECO.EU/O/9999999999", memo: "" }, b.payees!, new Map());
    expect(next).toMatchObject({ payee: "Rideco", from: "alias" });
  });

  it("a case-only rename records no self-alias", () => {
    let b = ops.ensurePayee(base(), "rideco").budget;
    b = ops.renamePayee(b, "rideco", "Rideco");
    expect(b.payees!.find((p) => p.name === "Rideco")!.aliases).toEqual([]);
  });

  it("gives an alias to exactly one payee", () => {
    let b = ops.syncPayees(withPayees()).budget;
    const [a, c] = b.payees!;
    b = ops.addPayeeAlias(b, a!.id, "shared key");
    b = ops.addPayeeAlias(b, c!.id, "shared key");
    expect(b.payees!.find((p) => p.id === a!.id)!.aliases).toEqual([]);
    expect(b.payees!.find((p) => p.id === c!.id)!.aliases).toEqual(["shared key"]);

    b = ops.removePayeeAlias(b, c!.id, "SHARED KEY"); // case doesn't matter
    expect(b.payees!.find((p) => p.id === c!.id)!.aliases).toEqual([]);
  });

  it("ensurePayee mints on first sighting and finds it afterwards", () => {
    const first = ops.ensurePayee(base(), "Cornerstore");
    expect(first.budget.payees).toHaveLength(1);
    const second = ops.ensurePayee(first.budget, "  cornerstore ");
    expect(second.payee.id).toBe(first.payee.id);
    expect(second.budget).toBe(first.budget);
  });
});
