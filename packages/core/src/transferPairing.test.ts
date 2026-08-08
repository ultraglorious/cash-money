import { describe, expect, it } from "vitest";
import { findTransferCandidates } from "./transferPairing.js";
import { computeProjection } from "./engine/compute.js";
import * as ops from "./ops.js";
import * as f from "../test/fixtures/factories.js";
import type { Cents } from "./money.js";
import type { LoadedBudget, Transaction } from "./model/types.js";

const PCHK = f.tid("APCH"); // Personal checking
const PSAV = f.tid("APSV"); // Personal savings (same budget scope)
const JCHK = f.tid("AJCH"); // Joint checking (another scope)
const BRK = f.tid("ABRK"); // tracking, no scope at all
const GINC = f.tid("GIN1");
const GEVD = f.tid("GEV1");
const GJIN = f.tid("GJIN");
const RTA = f.tid("CRTA");
const JRTA = f.tid("CJRT");
const CONTRIB = f.tid("CCON");
const GRO = f.tid("CGRO");

function budgetOf(transactions: Transaction[]): LoadedBudget {
  return {
    budget: f.budget(),
    accounts: [
      f.account({ id: PCHK, name: "Checking", type: "checking", onBudget: true, household: "Personal" }),
      f.account({ id: PSAV, name: "Savings", type: "checking", onBudget: true, household: "Personal" }),
      f.account({ id: JCHK, name: "Joint Account", type: "checking", onBudget: true, household: "Joint" }),
      f.account({ id: BRK, name: "Broker", type: "tracking", onBudget: false, household: "Personal" }),
    ],
    groups: [
      f.group({ id: GINC, name: "Inflow", kind: "income", household: "Personal" }),
      f.group({ id: GEVD, name: "Everyday", kind: "normal", household: "Personal" }),
      f.group({ id: GJIN, name: "Inflow", kind: "income", household: "Joint" }),
    ],
    categories: [
      f.category({ id: RTA, groupId: GINC, name: "Ready to Assign" }),
      f.category({ id: GRO, groupId: GEVD, name: "Groceries" }),
      f.category({ id: CONTRIB, groupId: GEVD, name: "Reserved for Joint" }),
      f.category({ id: JRTA, groupId: GJIN, name: "Ready to Assign" }),
    ],
    assignments: [f.assignment({ id: f.tid("AS1"), month: "2026-06", categoryId: CONTRIB, assigned: 150000 as Cents })],
    transactions,
  };
}

/** The shape imported data actually has: an envelope spend here, income there. */
const sendLeg = f.txn({ id: f.tid("TSND"), accountId: PCHK, date: "2026-06-28", amount: -150000 as Cents, categoryId: CONTRIB, payee: "Joint Account" });
const recvLeg = f.txn({ id: f.tid("TRCV"), accountId: JCHK, date: "2026-07-01", amount: 150000 as Cents, categoryId: JRTA, payee: "From Eric" });

describe("findTransferCandidates", () => {
  it("pairs a cross-household send with its arrival and says why", () => {
    const [c, ...rest] = findTransferCandidates(budgetOf([sendLeg, recvLeg]));
    expect(rest).toEqual([]);
    expect(c).toMatchObject({
      outflowId: sendLeg.id,
      inflowId: recvLeg.id,
      amount: 150000,
      dayGap: 3,
      confidence: "high", // the payee names the other account
    });
  });

  it("never offers a pair inside one budget scope — those arrive linked already", () => {
    const out = f.txn({ id: f.tid("TSO1"), accountId: PCHK, date: "2026-06-10", amount: -50000 as Cents, categoryId: GRO, payee: "Savings" });
    const inn = f.txn({ id: f.tid("TSI1"), accountId: PSAV, date: "2026-06-10", amount: 50000 as Cents, categoryId: RTA, payee: "Checking" });
    expect(findTransferCandidates(budgetOf([out, inn]))).toEqual([]);
  });

  it("treats a same-size coincidence as low confidence, not a transfer", () => {
    const rent = f.txn({ id: f.tid("TRNT"), accountId: PCHK, date: "2026-06-03", amount: -150000 as Cents, categoryId: GRO, payee: "Landlord" });
    const salary = f.txn({ id: f.tid("TSAL"), accountId: JCHK, date: "2026-06-02", amount: 150000 as Cents, payee: "Employer", categoryId: undefined });
    const [c] = findTransferCandidates(budgetOf([rent, salary]));
    expect(c?.confidence).toBe("low");
  });

  it("demotes a match when another row fits exactly as well", () => {
    const twin = { ...recvLeg, id: f.tid("TRC2"), payee: "From Eric" };
    const cands = findTransferCandidates(budgetOf([sendLeg, recvLeg, twin]));
    expect(cands).toHaveLength(1);
    expect(cands[0]!.confidence).toBe("medium");
    expect(cands[0]!.reason).toContain("just as well");
  });

  it("uses each row once and respects the date window", () => {
    const second = { ...sendLeg, id: f.tid("TSN2"), date: "2026-06-29" };
    const paired = findTransferCandidates(budgetOf([sendLeg, second, recvLeg]));
    expect(paired).toHaveLength(1);
    expect(paired[0]!.outflowId).toBe(second.id); // nearer date wins

    const tooFar = { ...recvLeg, id: f.tid("TRC3"), date: "2026-08-01" };
    expect(findTransferCandidates(budgetOf([sendLeg, tooFar]))).toEqual([]);
  });

  it("skips rows that are already transfers, splits, or unapproved", () => {
    const already = { ...sendLeg, transfer: { counterAccountId: JCHK, pairId: f.tid("PR1") } };
    expect(findTransferCandidates(budgetOf([already, recvLeg]))).toEqual([]);
    expect(findTransferCandidates(budgetOf([{ ...sendLeg, approved: false }, recvLeg]))).toEqual([]);
  });

  it("finds money moved to a tracking account even with an unhelpful payee", () => {
    const out = f.txn({ id: f.tid("TBO1"), accountId: PCHK, date: "2026-06-05", amount: -100000 as Cents, categoryId: GRO, payee: "Monthly investment" });
    const inn = f.txn({ id: f.tid("TBI1"), accountId: BRK, date: "2026-06-06", amount: 100000 as Cents, payee: "Deposit", categoryId: undefined });
    const [c] = findTransferCandidates(budgetOf([out, inn]));
    expect(c).toMatchObject({ inflowAccountId: BRK, confidence: "high" });
  });
});

describe("ops.linkTransfers", () => {
  it("links both legs with canonical payees and keeps the funding envelope", () => {
    const b = budgetOf([sendLeg, recvLeg]);
    const { budget, linked } = ops.linkTransfers(b, [{ outflowId: sendLeg.id, inflowId: recvLeg.id }]);
    expect(linked).toBe(1);
    const out = budget.transactions.find((t) => t.id === sendLeg.id)!;
    const inn = budget.transactions.find((t) => t.id === recvLeg.id)!;
    expect(out.payee).toBe("Transfer to: Joint Account");
    expect(inn.payee).toBe("Transfer from: Checking");
    expect(out.transfer!.pairId).toBe(inn.transfer!.pairId);
    expect(out.transfer!.counterAccountId).toBe(JCHK);
    expect(out.categoryId).toBe(CONTRIB); // the envelope that funded it survives
    expect(inn.categoryId).toBeUndefined(); // arriving cash needs no category
    expect(budget.transactions).toHaveLength(2); // nothing merged away
  });

  it("changes no number the engine derives — the whole point of linking, not stitching", () => {
    const b = budgetOf([
      f.txn({ id: f.tid("TINC"), accountId: PCHK, date: "2026-06-01", amount: 500000 as Cents, categoryId: RTA, payee: "Employer" }),
      sendLeg,
      recvLeg,
    ]);
    const before = computeProjection(b);
    const after = computeProjection(ops.linkTransfers(b, [{ outflowId: sendLeg.id, inflowId: recvLeg.id }]).budget);

    for (const month of ["2026-06", "2026-07"] as const) {
      expect(after.readyToAssignOf(month)).toBe(before.readyToAssignOf(month));
      expect([...after.readyToAssignByHousehold(month)]).toEqual([...before.readyToAssignByHousehold(month)]);
      expect(after.activityOf(CONTRIB, month)).toBe(before.activityOf(CONTRIB, month));
      expect(after.availableOf(CONTRIB, month)).toBe(before.availableOf(CONTRIB, month));
    }
    expect([...after.accountBalances()]).toEqual([...before.accountBalances()]);
  });

  it("ignores pairs whose rows are gone or already linked", () => {
    const b = budgetOf([sendLeg, recvLeg]);
    const once = ops.linkTransfers(b, [{ outflowId: sendLeg.id, inflowId: recvLeg.id }]).budget;
    expect(ops.linkTransfers(once, [{ outflowId: sendLeg.id, inflowId: recvLeg.id }]).linked).toBe(0);
    expect(ops.linkTransfers(b, [{ outflowId: f.tid("NOPE"), inflowId: recvLeg.id }]).linked).toBe(0);
  });
});
