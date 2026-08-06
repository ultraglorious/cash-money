import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import type { Cents } from "../money.js";
import type { LoadedBudget, Transaction } from "../model/types.js";
import type { RegisterFormat } from "./format.js";
import { buildStatementTransactions, reconcileStatement } from "./statement.js";
import * as f from "../../test/fixtures/factories.js";

const ACC = f.tid("AACC");
const FORMAT: RegisterFormat = {
  id: "lib:test-statement",
  name: "Test statement",
  date: { column: "Date", format: "iso" },
  amount: { mode: "signed", column: "Amount" },
  payeeColumn: "Payee",
  memoColumn: "Memo",
  trueDate: { pattern: "\\(\\.\\.\\d+\\)\\s+(\\d{4}-\\d{2}-\\d{2})", format: "iso" },
};
const OPTS = { sourceKey: "stmt:acc", accountId: ACC, currency: EUR };

function budget(transactions: Transaction[]): LoadedBudget {
  return {
    budget: f.budget(),
    accounts: [f.account({ id: ACC, name: "Card", type: "creditCard" })],
    groups: [],
    categories: [],
    assignments: [],
    transactions,
  };
}

function csvOf(rows: Array<[date: string, payee: string, amount: string, memo?: string]>): string {
  const line = (cells: string[]): string => cells.map((c) => `"${c}"`).join(",");
  return [line(["Date", "Payee", "Amount", "Memo"]), ...rows.map((r) => line([r[0], r[1], r[2], r[3] ?? ""]))].join("\n") + "\n";
}

const tx = (id: string, date: string, amount: number, payee: string): Transaction => {
  const t = f.txn({ id: f.tid(id), accountId: ACC, date, amount: amount as Cents, payee });
  delete (t as { source?: unknown }).source;
  return t;
};

describe("reconcileStatement passes", () => {
  it("exact: matches on amount + true date ±1d despite renamed payees and late booking", () => {
    // Budget has the TRUE date (Jan 3) and a renamed payee; the statement books Jan 5.
    const b = budget([tx("T1", "2026-01-03", -1234, "Nice Cafe")]);
    const csv = csvOf([["2026-01-05", "CAFE*88123 TLL", "-12.34", "(..4460) 2026-01-03 09:15 CAFE*88123"]]);
    const r = reconcileStatement(b, csv, FORMAT, OPTS);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ kind: "exact", txId: f.tid("T1"), deltaDays: 0 });
    expect(r.matches[0]!.rows[0]!.bookDate).toBe("2026-01-05");
    expect(r.toAdd).toHaveLength(0);
  });

  it("exact: flags interchangeable ties (two identical rides, either pairing is fine)", () => {
    const b = budget([tx("T1", "2026-07-15", -990, "Taxi"), tx("T2", "2026-07-15", -990, "Taxi")]);
    const csv = csvOf([
      ["2026-07-15", "BOLT.EU/1", "-9.90"],
      ["2026-07-15", "BOLT.EU/2", "-9.90"],
    ]);
    const r = reconcileStatement(b, csv, FORMAT, OPTS);
    expect(r.matches).toHaveLength(2);
    expect(r.matches.some((m) => m.interchangeable)).toBe(true);
    expect(r.toAdd).toHaveLength(0);
  });

  it("combo: several same-visit swipes explain one squashed budget row", () => {
    const b = budget([tx("T1", "2026-03-10", -2100, "Pub"), tx("T2", "2026-03-12", -500, "Shop")]);
    const csv = csvOf([
      ["2026-03-10", "PUB TLL", "-7.00"],
      ["2026-03-10", "PUB TLL", "-7.00"],
      ["2026-03-10", "PUB TLL", "-7.00"],
      ["2026-03-12", "SHOP", "-5.00"],
    ]);
    const r = reconcileStatement(b, csv, FORMAT, OPTS);
    const combo = r.matches.find((m) => m.kind === "combo");
    expect(combo).toBeDefined();
    expect(combo).toMatchObject({ txId: f.tid("T1"), sameMerchant: true });
    expect(combo!.rows).toHaveLength(3);
    expect(r.toAdd).toHaveLength(0);
  });

  it("wide: a unique amount matches across several days (order date vs charge date)", () => {
    const b = budget([tx("T1", "2026-01-01", -45511, "Amazon")]);
    const csv = csvOf([["2026-01-03", "Amazon.de*XYZ", "-455.11"]]);
    const r = reconcileStatement(b, csv, FORMAT, OPTS);
    expect(r.matches[0]).toMatchObject({ kind: "wide", txId: f.tid("T1"), deltaDays: 2 });
  });

  it("wide: refuses when the amount is NOT unique (ambiguity guard)", () => {
    // Both candidates are >1 day away (outside the exact pass) but inside the
    // wide window — with two of them, the wide pass must refuse.
    const b = budget([tx("T1", "2026-01-06", -5000, "A"), tx("T2", "2026-01-07", -5000, "B")]);
    const csv = csvOf([["2026-01-03", "MERCHANT", "-50.00"]]);
    const r = reconcileStatement(b, csv, FORMAT, OPTS);
    expect(r.matches.filter((m) => m.kind === "wide")).toHaveLength(0);
    expect(r.toAdd).toHaveLength(1);
  });

  it("churn: a charge and its same-payee refund cancel out", () => {
    const b = budget([]);
    const csv = csvOf([
      ["2026-05-12", "APPLE.COM/BILL", "-69.99"],
      ["2026-05-13", "APPLE.COM/BILL", "69.99"],
    ]);
    const r = reconcileStatement(b, csv, FORMAT, OPTS);
    expect(r.churn).toHaveLength(1);
    expect(r.toAdd).toHaveLength(0);
  });

  it("residue: genuinely new rows land in toAdd; unclaimed budget rows are reported", () => {
    const b = budget([tx("T1", "2026-02-01", -1000, "Recorded"), tx("T2", "2026-02-10", -2000, "OnlyInBudget")]);
    const csv = csvOf([
      ["2026-02-01", "RECORDED", "-10.00"],
      ["2026-02-05", "NEW MERCHANT", "-33.33"],
    ]);
    const r = reconcileStatement(b, csv, FORMAT, OPTS);
    expect(r.toAdd).toHaveLength(1);
    expect(r.toAdd[0]!.payee).toBe("NEW MERCHANT");
    expect(r.unclaimedBudget).toEqual([f.tid("T2")]);
    expect(r.check.statementNet).toBe(-4333);
    expect(r.check.budgetNet).toBe(-3000);
  });

  it("identity: committed toAdd rows identity-match on the next run of the same file", () => {
    const csv = csvOf([["2026-06-01", "SHOP", "-15.00"]]);
    const first = reconcileStatement(budget([]), csv, FORMAT, OPTS);
    expect(first.toAdd).toHaveLength(1);
    const committed = buildStatementTransactions(first.toAdd, OPTS);
    expect(committed[0]!.cleared).toBe("reconciled"); // straight from the bank's record
    const second = reconcileStatement(budget(committed), csv, FORMAT, OPTS);
    expect(second.matches[0]!.kind).toBe("identity");
    expect(second.toAdd).toHaveLength(0);
  });

  it("collects per-row parse errors without dropping good rows", () => {
    const csv = csvOf([
      ["2026-03-01", "OK", "-4.50"],
      ["not a date", "BROKEN", "-1.00"],
    ]);
    const r = reconcileStatement(budget([]), csv, FORMAT, OPTS);
    expect(r.parsedRows).toBe(1);
    expect(r.errors).toHaveLength(1);
    expect(r.toAdd).toHaveLength(1);
  });
});
