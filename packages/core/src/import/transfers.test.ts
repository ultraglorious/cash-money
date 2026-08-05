import { describe, expect, it } from "vitest";
import { epochDay } from "../time.js";
import { fold } from "./text.js";
import type { StagedTxn, StagedKind } from "./staged.js";
import { dedupeWithinTransfers } from "./transfers.js";

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
  // Mirror the parser: a within-transfer leg carries its counterpart's name.
  const counter = kind === "withinTransfer" ? o.payee.replace(/^transfer\s*:/i, "").trim() : undefined;
  return {
    ...(counter ? { counterAccount: counter, counterAccountFold: fold(counter) } : {}),
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

describe("cross-budget rows are never stitched", () => {
  it("keeps equal-and-opposite cross-budget rows as ordinary transactions", () => {
    // The funding pattern: an outflow in one budget, income in the other. These
    // must stay exactly as recorded — collapsing them into one transfer makes
    // both budgets claim the same money and wrecks Ready-to-Assign.
    const staged = [
      st({ sourceKey: "a", account: "Checking", date: "2026-07-31", payee: "Joint Account", amount: -350000 }),
      st({ sourceKey: "b", account: "Joint", date: "2026-07-31", payee: "Me", amount: 350000, kind: "income" }),
    ];
    dedupeWithinTransfers(staged);
    expect(staged[0]!.kind).toBe("normal");
    expect(staged[1]!.kind).toBe("income");
    expect(staged[0]!.transfer).toBeUndefined();
    expect(staged[1]!.transfer).toBeUndefined();
  });
});
