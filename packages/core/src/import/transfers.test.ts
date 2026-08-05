import { describe, expect, it } from "vitest";
import { epochDay } from "../time.js";
import { fold } from "./normalize.js";
import type { StagedTxn, StagedKind } from "./staged.js";
import type { StitchRule } from "./config.js";
import { dedupeWithinTransfers, stitchCrossBudget } from "./transfers.js";

let rowSeq = 1;
function st(o: {
  sourceKey: string;
  account: string;
  date: string;
  payee: string;
  amount: number;
  kind?: StagedKind;
}): StagedTxn {
  const kind = o.kind ?? "normal";
  return {
    sourceKey: o.sourceKey,
    account: o.account,
    accountFold: fold(o.account),
    date: o.date,
    effectiveDate: o.date,
    epochDay: epochDay(o.date),
    approved: true,
    payee: o.payee,
    payeeFold: fold(o.payee),
    memo: "",
    amount: o.amount,
    cleared: "cleared",
    kind,
    lines:
      kind === "normal" || kind === "income"
        ? [{ group: "G", groupFold: "g", category: "C", categoryFold: "c", amount: o.amount, memo: "", isIncome: kind === "income" }]
        : [],
    sourceRows: [rowSeq++],
  };
}

describe("dedupeWithinTransfers", () => {
  it("pairs the two mirrored legs and links them with a shared pairId", () => {
    const staged = [
      st({ sourceKey: "a", account: "Checking", date: "2026-07-10", payee: "Transfer : Card", amount: -49965, kind: "withinTransfer" }),
      st({ sourceKey: "a", account: "Card", date: "2026-07-10", payee: "Transfer : Checking", amount: 49965, kind: "withinTransfer" }),
    ];
    const r = dedupeWithinTransfers(staged);
    expect(r).toEqual({ pairs: 1, unpaired: 0 });
    expect(staged[0]!.kind).toBe("transfer");
    expect(staged[1]!.kind).toBe("transfer");
    expect(staged[0]!.transfer!.pairId).toBe(staged[1]!.transfer!.pairId);
    expect(staged[0]!.transfer!.counterAccount).toBe("Card");
    expect(staged[1]!.transfer!.counterAccount).toBe("Checking");
  });

  it("does not merge same-day transfers of different amounts", () => {
    const staged = [
      st({ sourceKey: "a", account: "A", date: "2026-06-29", payee: "Transfer : B", amount: -638894, kind: "withinTransfer" }),
      st({ sourceKey: "a", account: "B", date: "2026-06-29", payee: "Transfer : A", amount: 638894, kind: "withinTransfer" }),
      st({ sourceKey: "a", account: "A", date: "2026-06-29", payee: "Transfer : B", amount: -638856, kind: "withinTransfer" }),
      st({ sourceKey: "a", account: "B", date: "2026-06-29", payee: "Transfer : A", amount: 638856, kind: "withinTransfer" }),
    ];
    const r = dedupeWithinTransfers(staged);
    expect(r.pairs).toBe(2);
    // The .94 legs pair together, the .56 legs pair together.
    expect(staged[0]!.transfer!.pairId).toBe(staged[1]!.transfer!.pairId);
    expect(staged[2]!.transfer!.pairId).toBe(staged[3]!.transfer!.pairId);
    expect(staged[0]!.transfer!.pairId).not.toBe(staged[2]!.transfer!.pairId);
  });

  it("keeps an unpaired leg one-sided and flags it", () => {
    const staged = [
      st({ sourceKey: "a", account: "A", date: "2026-06-01", payee: "Transfer : Gone", amount: -1000, kind: "withinTransfer" }),
    ];
    const r = dedupeWithinTransfers(staged);
    expect(r).toEqual({ pairs: 0, unpaired: 1 });
    expect(staged[0]!.kind).toBe("transfer");
    expect(staged[0]!.warnings?.[0]).toMatch(/unpaired/);
  });
});

const RULE: StitchRule = {
  aSourceKey: "a",
  aLinkPayee: "Joint Account",
  bSourceKey: "b",
  bLinkPayee: "Me",
  windowDays: 3,
};

describe("stitchCrossBudget", () => {
  it("matches an equal-and-opposite pair on the same date and links them", () => {
    const staged = [
      st({ sourceKey: "a", account: "Checking", date: "2026-07-31", payee: "Joint Account", amount: -350000 }),
      st({ sourceKey: "b", account: "Joint", date: "2026-07-31", payee: "Me", amount: 350000, kind: "income" }),
    ];
    const r = stitchCrossBudget(staged, [RULE]);
    expect(r.matched).toBe(1);
    expect(r.unmatched).toBe(0);
    expect(staged[0]!.kind).toBe("transfer");
    expect(staged[1]!.kind).toBe("transfer"); // income leg is no longer income
    expect(staged[0]!.transfer!.pairId).toBe(staged[1]!.transfer!.pairId);
    expect(staged[0]!.transfer!.counterAccount).toBe("Joint");
    expect(staged[1]!.transfer!.counterAccount).toBe("Checking");
    expect(r.deltaHistogram[0]).toBe(1);
  });

  it("matches within the date window but not beyond it", () => {
    const near = [
      st({ sourceKey: "a", account: "Chk", date: "2026-06-01", payee: "Joint Account", amount: -350000 }),
      st({ sourceKey: "b", account: "Jnt", date: "2026-05-30", payee: "Me", amount: 350000, kind: "income" }),
    ];
    expect(stitchCrossBudget(near, [RULE]).matched).toBe(1);

    const far = [
      st({ sourceKey: "a", account: "Chk", date: "2026-01-01", payee: "Joint Account", amount: -50000 }),
      st({ sourceKey: "b", account: "Jnt", date: "2026-01-10", payee: "Me", amount: 50000, kind: "income" }),
    ];
    const r = stitchCrossBudget(far, [RULE]);
    expect(r.matched).toBe(0);
    expect(r.unmatched).toBe(2); // both left as ordinary txns
  });

  it("resolves repeated identical amounts by nearest date (mutual exclusion)", () => {
    const staged = [
      st({ sourceKey: "a", account: "Chk", date: "2026-06-27", payee: "Joint Account", amount: -350000 }),
      st({ sourceKey: "a", account: "Chk", date: "2026-07-31", payee: "Joint Account", amount: -350000 }),
      st({ sourceKey: "b", account: "Jnt", date: "2026-07-31", payee: "Me", amount: 350000, kind: "income" }),
      st({ sourceKey: "b", account: "Jnt", date: "2026-06-27", payee: "Me", amount: 350000, kind: "income" }),
    ];
    const r = stitchCrossBudget(staged, [RULE]);
    expect(r.matched).toBe(2);
    // June A pairs with June B; July A pairs with July B (nearest date).
    const june = staged.find((s) => s.sourceKey === "a" && s.date === "2026-06-27")!;
    const juneB = staged.find((s) => s.sourceKey === "b" && s.date === "2026-06-27")!;
    expect(june.transfer!.pairId).toBe(juneB.transfer!.pairId);
  });

  it("never stitches payees not named by a rule (false-positive guard)", () => {
    const staged = [
      // Both budgets pay their own bank the same amount on the same day.
      st({ sourceKey: "a", account: "Chk", date: "2026-08-10", payee: "Acme Bank", amount: -100 }),
      st({ sourceKey: "b", account: "Jnt", date: "2026-08-10", payee: "Acme Bank", amount: 100 }),
    ];
    const r = stitchCrossBudget(staged, [RULE]);
    expect(r.matched).toBe(0);
    expect(staged[0]!.kind).toBe("normal");
    expect(staged[1]!.kind).toBe("normal");
  });

  it("leaves a one-sided cross candidate as an ordinary transaction", () => {
    const staged = [
      st({ sourceKey: "b", account: "Jnt", date: "2026-03-03", payee: "Me", amount: 350000, kind: "income" }),
    ];
    const r = stitchCrossBudget(staged, [RULE]);
    expect(r.matched).toBe(0);
    expect(r.unmatched).toBe(1);
    expect(staged[0]!.kind).toBe("income"); // still income, not a half-transfer
  });
});
