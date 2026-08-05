import { describe, expect, it } from "vitest";
import { guessFormat } from "./guess.js";

describe("guessFormat", () => {
  it("prefers separate in/out columns when both exist", () => {
    const g = guessFormat(["Booking Date", "Description", "Debit", "Credit", "Reference"]);
    expect(g).toMatchObject({
      dateColumn: "Booking Date",
      payeeColumn: "Description",
      memoColumn: "Reference",
      amount: { mode: "inOut", inflowColumn: "Credit", outflowColumn: "Debit" },
    });
  });

  it("falls back to a single amount column", () => {
    const g = guessFormat(["Date", "Payee", "Amount"]);
    expect(g.amount).toEqual({ mode: "signed", column: "Amount" });
  });

  it("does not reuse the payee column as the memo", () => {
    const g = guessFormat(["Date", "Memo", "Amount"]);
    expect(g.payeeColumn).toBe("Memo");
    expect(g.memoColumn).toBeUndefined();
  });

  it("returns an empty guess for unrecognizable headers", () => {
    const g = guessFormat(["A", "B"]);
    expect(g.dateColumn).toBeUndefined();
    expect(g.amount).toBeUndefined();
  });
});
