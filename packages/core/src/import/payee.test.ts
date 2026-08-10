import { describe, expect, it } from "vitest";
import {
  lastCategoryByPayee,
  matchExistingPayee,
  nameIncomingRow,
  payeeFromDescription,
  technicalKey,
} from "./payee.js";
import * as f from "../../test/fixtures/factories.js";
import type { Cents } from "../money.js";
import type { LoadedBudget, Payee } from "../model/types.js";

const CHK = f.tid("ACHK");
const GEVD = f.tid("GEVD");
const GRO = f.tid("CGRO");
const DIN = f.tid("CDIN");

let seq = 0;
const payee = (name: string, aliases: string[] = []): Payee => ({ id: f.tid(`P${seq++}`), name, aliases });

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

  it("gives back nothing when the description was only identifiers", () => {
    expect(payeeFromDescription("GB29NWBK60161331926819 2026-08-02")).toBe("");
    expect(payeeFromDescription("   ")).toBe("");
  });
});

describe("technicalKey", () => {
  it("is the bank's name when there is one, and the description's shape when there isn't", () => {
    expect(technicalKey({ payee: "AS Northwind Bank", memo: "whatever" })).toBe("as northwind bank");
    expect(technicalKey({ payee: "", memo: "Premium client monthly fee 06.2026" })).toBe("premium client monthly fee");
  });

  it("gives the same key for the same row next month", () => {
    expect(technicalKey({ payee: "", memo: "Card (..1234) monthly fee 06-2026" })).toBe(
      technicalKey({ payee: "", memo: "Card (..1234) monthly fee 07-2026" }),
    );
  });
});

describe("matchExistingPayee", () => {
  const list = [payee("Northwind"), payee("Northwind Insurance"), payee("Exampleco"), payee("Rideco"), payee("Streamco"), payee("Fruitco")];

  it("sees through a legal form and a processor's decoration", () => {
    expect(matchExistingPayee("AS Northwind Bank", list)?.name).toBe("Northwind");
    expect(matchExistingPayee("EXAMPLECO OÜ", list)?.name).toBe("Exampleco");
    expect(matchExistingPayee("AS Streamco Baltics", list)?.name).toBe("Streamco");
    expect(matchExistingPayee("RIDECO.EU/O/1234567890", list)?.name).toBe("Rideco");
    expect(matchExistingPayee("FRUITCO.COM/BILL", list)?.name).toBe("Fruitco");
  });

  it("prefers the more specific payee when both fit", () => {
    expect(matchExistingPayee("AS Northwind Insurance", list)?.name).toBe("Northwind Insurance");
  });

  it("says nothing about a first-time merchant rather than guessing", () => {
    expect(matchExistingPayee("PAY*Riverside Plaza", list)).toBeUndefined();
    expect(matchExistingPayee("Some Gym AS", list)).toBeUndefined();
    expect(matchExistingPayee("PAYPROC  *OU SOME SHOP", list)).toBeUndefined();
  });

  it("does not depend on the order of the payee list", () => {
    const a = payee("Account interest");
    const b = payee("Income tax");
    const technical = "Income tax on account interest";
    // Both fit and both have two words, so the longer text wins either way round.
    expect(matchExistingPayee(technical, [a, b])?.name).toBe(matchExistingPayee(technical, [b, a])?.name);
    expect(matchExistingPayee(technical, [a, b])?.name).toBe("Account interest");
  });

  it("never matches on a scrap of a word, or on a token too short to mean anything", () => {
    expect(matchExistingPayee("RIDECOZZA LABS", list)).toBeUndefined();
    expect(matchExistingPayee("anything at all", [payee("AS")])).toBeUndefined();
  });
});

describe("nameIncomingRow", () => {
  const categories = new Map([
    ["northwind", DIN],
    ["greengrocer", GRO],
  ]);

  it("prefers an alias you recorded over everything else", () => {
    const list = [payee("Greengrocer", ["as northwind bank"]), payee("Northwind")];
    expect(nameIncomingRow({ payee: "AS Northwind Bank", memo: "" }, list, categories)).toEqual({
      payee: "Greengrocer",
      from: "alias",
      categoryId: GRO,
    });
  });

  it("falls to a match against your payees, with the category they usually get", () => {
    expect(nameIncomingRow({ payee: "AS Northwind Bank", memo: "" }, [payee("Northwind")], categories)).toEqual({
      payee: "Northwind",
      from: "match",
      categoryId: DIN,
    });
  });

  it("keeps the bank's own name when nothing recognises it", () => {
    expect(nameIncomingRow({ payee: "Some Gym AS", memo: "" }, [payee("Northwind")], categories)).toEqual({
      payee: "Some Gym AS",
      from: "bank",
    });
  });

  it("derives a name from the description when the bank supplied none", () => {
    expect(nameIncomingRow({ payee: "", memo: "Standing order to a card account" }, [], categories)).toEqual({
      payee: "Standing order to a card account",
      from: "description",
    });
  });

  it("matches a derived name too, so a described row can still find its payee", () => {
    const list = [payee("Corner Bakery")];
    expect(
      nameIncomingRow({ payee: "", memo: "Card (..1234) 2026-07-02 CORNER BAKERY CENTRAL" }, list, categories),
    ).toMatchObject({ payee: "Corner Bakery", from: "match" });
  });

  it("aliases a described row by the shape of its description", () => {
    const list = [payee("Northwind fees", ["premium client monthly fee"])];
    expect(nameIncomingRow({ payee: "", memo: "Premium client monthly fee 07.2026" }, list, categories)).toMatchObject({
      payee: "Northwind fees",
      from: "alias",
    });
  });
});

describe("lastCategoryByPayee", () => {
  function budget(): LoadedBudget {
    return {
      budget: f.budget(),
      accounts: [f.account({ id: CHK, name: "Checking", type: "checking" })],
      groups: [f.group({ id: GEVD, name: "Everyday", kind: "normal" })],
      categories: [
        f.category({ id: GRO, groupId: GEVD, name: "Groceries" }),
        f.category({ id: DIN, groupId: GEVD, name: "Dining" }),
      ],
      assignments: [],
      transactions: [
        f.txn({ id: f.tid("T1"), accountId: CHK, date: "2026-01-10", amount: -2000 as Cents, categoryId: GRO, payee: "Greengrocer" }),
        f.txn({ id: f.tid("T2"), accountId: CHK, date: "2026-06-10", amount: -2500 as Cents, categoryId: DIN, payee: "Greengrocer" }),
        f.txn({
          id: f.tid("T3"), accountId: CHK, date: "2026-07-01", amount: -1000 as Cents, categoryId: undefined,
          payee: "Transfer to: Savings", transfer: { counterAccountId: f.tid("ASAV"), pairId: f.tid("P1") },
        }),
      ],
    };
  }

  it("takes the newest filing, since that is the current intent", () => {
    expect(lastCategoryByPayee(budget()).get("greengrocer")).toBe(DIN);
  });

  it("ignores transfer legs, whose payee is derived text", () => {
    expect(lastCategoryByPayee(budget()).has("transfer to: savings")).toBe(false);
  });
});
