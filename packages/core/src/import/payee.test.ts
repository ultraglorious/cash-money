import { describe, expect, it } from "vitest";
import { learnPayees, nameIncomingRow, payeeFromDescription } from "./payee.js";
import { fingerprint } from "../ids.js";
import * as f from "../../test/fixtures/factories.js";
import type { Cents } from "../money.js";
import type { LoadedBudget } from "../model/types.js";

const CHK = f.tid("ACHK");
const GEVD = f.tid("GEVD");
const GRO = f.tid("CGRO");
const DIN = f.tid("CDIN");

describe("payeeFromDescription", () => {
  it("keeps what the description says and drops what identifies the account", () => {
    const name = payeeFromDescription("Account interest GB29NWBK60161331926819, 01.06.2026 - 30.06.2026, interest");
    expect(name).not.toMatch(/EE\d/); // no account number
    expect(name).not.toMatch(/\d{2}\.\d{2}\.\d{4}/); // no dates
    expect(name.startsWith("Account interest")).toBe(true);
  });

  it("drops the period a recurring fee names, so every month derives the same payee", () => {
    expect(payeeFromDescription("Premium client monthly fee 06.2026")).toBe("Premium client monthly fee");
    expect(payeeFromDescription("Card (..1234) monthly fee 06-2026")).toBe("Card monthly fee");
    expect(payeeFromDescription("Premium client monthly fee 06.2026")).toBe(
      payeeFromDescription("Premium client monthly fee 07.2026"),
    );
  });

  it("does not leave the punctuation of what it removed behind", () => {
    expect(payeeFromDescription("Account interest GB29NWBK60161331926819, 01.06.2026 - 30.06.2026, interest rate 1.00%")).toBe(
      "Account interest, interest rate 1.00%",
    );
  });

  it("strips a card mask, a date and a time from a withdrawal", () => {
    expect(payeeFromDescription("Cash withdrawal: (..1234) 2026-08-02 11:03 SECURECASH ATM")).toBe(
      "Cash withdrawal: SECURECASH ATM",
    );
  });

  it("leaves an ordinary description alone", () => {
    expect(payeeFromDescription("Standing order to a card account")).toBe("Standing order to a card account");
  });

  it("gives back nothing when the description was only identifiers", () => {
    expect(payeeFromDescription("GB29NWBK60161331926819 2026-08-02")).toBe("");
    expect(payeeFromDescription("   ")).toBe("");
  });

  it("cuts an essay at a word boundary", () => {
    const long = payeeFromDescription(`Payment for ${"services rendered ".repeat(10)}`);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith(" ")).toBe(false);
  });
});

describe("learnPayees / nameIncomingRow", () => {
  const cpAcme = fingerprint(["counterparty", "ee11acme"]);
  function budget(): LoadedBudget {
    return {
      budget: f.budget(),
      accounts: [f.account({ id: CHK, name: "Checking", type: "checking" })],
      groups: [f.group({ id: GEVD, name: "Everyday", kind: "normal" })],
      categories: [f.category({ id: GRO, groupId: GEVD, name: "Groceries" }), f.category({ id: DIN, groupId: GEVD, name: "Dining" })],
      assignments: [],
      transactions: [
        f.txn({
          id: f.tid("T1"), accountId: CHK, date: "2026-01-10", amount: -2000 as Cents, categoryId: GRO,
          payee: "The Corner Shop", memo: "Card (..1234) 2026-01-10 CORNER SHOP OU",
        }),
        f.txn({
          id: f.tid("T2"), accountId: CHK, date: "2026-02-10", amount: -5000 as Cents, categoryId: DIN,
          payee: "Acme Ltd", memo: "Invoice 88213",
          source: {
            sourceBudget: "s", naturalKey: fingerprint(["n"]), occurrenceIndex: 0, identity: fingerprint(["i"]),
            firstSeenExportTs: "2026-02-10", lastSeenExportTs: "2026-02-10", counterparty: cpAcme,
          },
        }),
      ],
    };
  }

  it("recognises a counterparty it has seen before, and files it as before", () => {
    const named = nameIncomingRow({ payee: "", memo: "Invoice 90011", counterparty: cpAcme }, learnPayees(budget()));
    expect(named).toEqual({ payee: "Acme Ltd", categoryId: DIN });
  });

  it("recognises the same shape of description when there is no counterparty", () => {
    const named = nameIncomingRow(
      { payee: "", memo: "Card (..1234) 2026-07-02 CORNER SHOP OU" }, // a later visit, same shop
      learnPayees(budget()),
    );
    expect(named).toEqual({ payee: "The Corner Shop", categoryId: GRO });
  });

  it("never overrides what the bank actually supplied", () => {
    const named = nameIncomingRow({ payee: "Someone Else", memo: "Invoice 90011", counterparty: cpAcme }, learnPayees(budget()));
    expect(named.payee).toBe("Someone Else");
  });

  it("falls back to the description when nothing has been seen before", () => {
    const named = nameIncomingRow({ payee: "", memo: "Premium client monthly fee 06.2026" }, learnPayees(budget()));
    expect(named.payee).toBe("Premium client monthly fee");
    expect(named.categoryId).toBeUndefined();
  });

  it("prefers the newest name, since renaming is how you correct it", () => {
    const b = budget();
    b.transactions = [
      ...b.transactions,
      f.txn({
        id: f.tid("T3"), accountId: CHK, date: "2026-06-01", amount: -3000 as Cents, categoryId: GRO,
        payee: "Corner Shop (the good one)", memo: "Card (..1234) 2026-06-01 CORNER SHOP OU",
      }),
    ];
    const named = nameIncomingRow({ payee: "", memo: "Card (..1234) 2026-08-01 CORNER SHOP OU" }, learnPayees(b));
    expect(named.payee).toBe("Corner Shop (the good one)");
  });

  it("ignores transfer rows, whose payee is derived text rather than a name", () => {
    const b = budget();
    b.transactions = [
      f.txn({
        id: f.tid("T4"), accountId: CHK, date: "2026-03-01", amount: -1000 as Cents, categoryId: undefined,
        payee: "Transfer to: Savings", memo: "Standing order to a card account",
        transfer: { counterAccountId: f.tid("ASAV"), pairId: f.tid("P1") },
      }),
    ];
    const named = nameIncomingRow({ payee: "", memo: "Standing order to a card account" }, learnPayees(b));
    expect(named.payee).toBe("Standing order to a card account"); // derived, not the transfer's label
  });
});
