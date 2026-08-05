import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import type { Cents } from "../money.js";
import { dedupeBankDrafts, mapBankRows, parseBankCsv, parseBankDate, type BankMapping } from "./bankCsv.js";
import * as f from "../../test/fixtures/factories.js";

describe("parseBankDate", () => {
  it("parses the supported layouts", () => {
    expect(parseBankDate("2026-01-05", "iso")).toBe("2026-01-05");
    expect(parseBankDate("05/01/2026", "dmy")).toBe("2026-01-05");
    expect(parseBankDate("01/05/2026", "mdy")).toBe("2026-01-05");
    expect(parseBankDate("5.1.26", "dmy")).toBe("2026-01-05");
  });
  it("rejects nonsense", () => {
    expect(() => parseBankDate("nope", "iso")).toThrow();
    expect(() => parseBankDate("31/31/2026", "dmy")).toThrow();
  });
});

describe("parseBankCsv", () => {
  it("strips a BOM and returns headers + rows", () => {
    const { headers, rows } = parseBankCsv(`﻿Date,Description,Amount\n2026-01-05,Shop,-12.34\n`);
    expect(headers).toEqual(["Date", "Description", "Amount"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.Description).toBe("Shop");
  });
});

describe("mapBankRows", () => {
  const rows = [
    { Date: "05/01/2026", Description: "Coffee", Debit: "3.50", Credit: "" },
    { Date: "06/01/2026", Description: "Salary", Debit: "", Credit: "2000.00" },
  ];

  it("maps a single signed amount column", () => {
    const single = [{ Date: "2026-01-05", Description: "Shop", Amount: "-12.34" }];
    const mapping: BankMapping = { dateColumn: "Date", dateFormat: "iso", payeeColumn: "Description", amount: { mode: "single", column: "Amount" } };
    const { drafts, errors } = mapBankRows(single, mapping, EUR);
    expect(errors).toHaveLength(0);
    expect(drafts[0]).toMatchObject({ date: "2026-01-05", payee: "Shop", amount: -1234 });
  });

  it("inverts sign when outflows are stored positive", () => {
    const single = [{ Date: "2026-01-05", Description: "Shop", Amount: "12.34" }];
    const mapping: BankMapping = { dateColumn: "Date", dateFormat: "iso", payeeColumn: "Description", amount: { mode: "single", column: "Amount", outflowPositive: true } };
    expect(mapBankRows(single, mapping, EUR).drafts[0]!.amount).toBe(-1234);
  });

  it("maps separate debit/credit columns to a signed amount", () => {
    const mapping: BankMapping = { dateColumn: "Date", dateFormat: "dmy", payeeColumn: "Description", amount: { mode: "split", inflowColumn: "Credit", outflowColumn: "Debit" } };
    const { drafts } = mapBankRows(rows, mapping, EUR);
    expect(drafts[0]!.amount).toBe(-350); // Coffee debit
    expect(drafts[1]!.amount).toBe(200000); // Salary credit
  });

  it("collects per-row errors instead of throwing", () => {
    const bad = [{ Date: "bogus", Description: "X", Amount: "1.00" }];
    const mapping: BankMapping = { dateColumn: "Date", dateFormat: "iso", payeeColumn: "Description", amount: { mode: "single", column: "Amount" } };
    const { drafts, errors } = mapBankRows(bad, mapping, EUR);
    expect(drafts).toHaveLength(0);
    expect(errors[0]).toMatch(/Row 2/);
  });
});

describe("dedupeBankDrafts", () => {
  it("skips drafts already on the account and within-file duplicates", () => {
    const acc = f.tid("ACC1");
    const existing = [f.txn({ id: f.tid("T1"), accountId: acc, date: "2026-01-05", amount: -1234 as Cents, payee: "Shop", memo: "" })];
    const drafts = [
      { date: "2026-01-05", payee: "Shop", memo: "", amount: -1234 as Cents, sourceRow: 2 }, // dup of existing
      { date: "2026-01-06", payee: "Cafe", memo: "", amount: -500 as Cents, sourceRow: 3 },
      { date: "2026-01-06", payee: "Cafe", memo: "", amount: -500 as Cents, sourceRow: 4 }, // dup within file
    ];
    const { fresh, duplicates } = dedupeBankDrafts(existing, acc, drafts);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.payee).toBe("Cafe");
    expect(duplicates).toBe(2);
  });
});
