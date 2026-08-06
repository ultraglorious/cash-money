import { describe, expect, it } from "vitest";
import type { Cents } from "./money.js";
import type { Transaction } from "./model/types.js";
import { deduceInvoiceCoverage } from "./invoices.js";
import * as f from "../test/fixtures/factories.js";

const CARD = f.tid("ACRD");
const CHK = f.tid("ACHK");

let seq = 0;
function spend(date: string, amount: number, over: Partial<Transaction> = {}): Transaction {
  return f.txn({ id: f.tid(`S${seq++}`), accountId: CARD, date, amount: amount as Cents, cleared: "uncleared", ...over });
}
function payment(date: string, amount: number): Transaction {
  return f.txn({
    id: f.tid(`P${seq++}`),
    accountId: CARD,
    date,
    amount: amount as Cents,
    cleared: "uncleared",
    transfer: { counterAccountId: CHK, pairId: f.tid(`PR${seq}`) },
  });
}
const ids = (ts: Transaction[]): string[] => ts.map((t) => t.id);

describe("deduceInvoiceCoverage", () => {
  it("matches the newest payment's billing window and settles everything older", () => {
    const jan = [spend("2026-01-05", -1000), spend("2026-01-20", -2500)];
    const feb = [spend("2026-02-03", -4000), spend("2026-02-14", -600), spend("2026-02-25", -900)];
    const mar = [spend("2026-03-02", -700)]; // next period: stays unsettled
    const pJan = payment("2026-02-10", 3500);
    const pFeb = payment("2026-03-10", 5500);
    const r = deduceInvoiceCoverage([...jan, ...feb, ...mar, pJan, pFeb], CARD);
    expect(r).not.toBeNull();
    expect(r!.paymentTxId).toBe(pFeb.id);
    expect(r!.windowFrom).toBe("2026-02-03");
    expect(r!.windowTo).toBe("2026-02-25");
    expect(new Set(r!.covered)).toEqual(new Set([...ids(jan), ...ids(feb), pJan.id, pFeb.id]));
  });

  it("permutes a boundary row whose true date sits inside the window but was booked into the next period", () => {
    // The Jan 25 swipe booked in February sits BETWEEN two covered rows by
    // date — no contiguous run sums to the payment, only the permuted one.
    const straddler = spend("2026-01-25", -800);
    const jan = [spend("2026-01-04", -1200), spend("2026-01-28", -300)];
    const pay = payment("2026-02-10", 1500); // covers Jan WITHOUT the straddler
    const r = deduceInvoiceCoverage([...jan, straddler, pay], CARD);
    expect(r).not.toBeNull();
    // The straddler is at the window's end edge, pushed to the NEXT invoice.
    expect(r!.covered).not.toContain(straddler.id);
    expect(new Set(r!.covered)).toEqual(new Set([...ids(jan), pay.id]));
  });

  it("includes a refund inside the period in the invoice sum", () => {
    const rows = [spend("2026-01-05", -2000), spend("2026-01-12", 500), spend("2026-01-20", -1000)];
    const pay = payment("2026-02-10", 2500);
    const r = deduceInvoiceCoverage([...rows, pay], CARD);
    expect(r).not.toBeNull();
    expect(new Set(r!.covered)).toEqual(new Set([...ids(rows), pay.id]));
  });

  it("refuses when no exact window exists, and falls back to an older matchable payment", () => {
    const jan = [spend("2026-01-05", -1000)];
    const feb = [spend("2026-02-05", -2000)];
    const pJan = payment("2026-02-10", 1000);
    const pFeb = payment("2026-03-10", 999999); // matches nothing
    const r = deduceInvoiceCoverage([...jan, ...feb, pJan, pFeb], CARD);
    expect(r).not.toBeNull();
    expect(r!.paymentTxId).toBe(pJan.id); // fell back
    expect(r!.covered).toContain(jan[0]!.id);
    expect(r!.covered).not.toContain(feb[0]!.id);

    expect(deduceInvoiceCoverage([...feb, payment("2026-03-10", 123456)], CARD)).toBeNull();
  });

  it("ignores scheduled rows and other accounts", () => {
    const rows = [
      spend("2026-01-05", -1000),
      spend("2026-01-08", -50, { approved: false }), // scheduled: not on any invoice
      f.txn({ id: f.tid("OTHER"), accountId: CHK, date: "2026-01-06", amount: -1000 as Cents }),
    ];
    const pay = payment("2026-02-10", 1000);
    const r = deduceInvoiceCoverage([...rows, pay], CARD);
    expect(r).not.toBeNull();
    expect(new Set(r!.covered)).toEqual(new Set([rows[0]!.id, pay.id]));
  });
});
