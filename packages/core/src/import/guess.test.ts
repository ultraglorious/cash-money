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

  it("spots the counterparty account column, and leaves it alone when there isn't one", () => {
    const bank = guessFormat(
      ["Date", "Sender/receiver name", "Sender/receiver account", "Amount", "Description"],
      [{ Date: "2026-01-02", "Sender/receiver name": "Acme", "Sender/receiver account": "GB29NWBK60161331926819", Amount: "-12.30", Description: "Invoice" }],
    );
    expect(bank.counterpartyColumn).toBe("Sender/receiver account");

    const card = guessFormat(["Date", "Payee", "Amount"], [{ Date: "2026-01-02", Payee: "Shop", Amount: "-4.00" }]);
    expect(card.counterpartyColumn).toBeUndefined();
  });
});
