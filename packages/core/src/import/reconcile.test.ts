import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import type { ImportConfig } from "./config.js";
import { stageImport } from "./pipeline.js";
import { reconcileTransactions } from "./reconcile.js";

const HEADER =
  '﻿"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"';
const PLAN = '﻿"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"';

const INCOME = '"Checking","","05.01.2026","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","",€0.00,€3000.00,"Cleared"';
const GROCERIES = '"Checking","","06.01.2026","Shop","Everyday: Groceries","Everyday","Groceries","",€12.00,€0.00,"Uncleared"';
const GROCERIES_CLEARED = '"Checking","","06.01.2026","Shop","Everyday: Groceries","Everyday","Groceries","",€12.00,€0.00,"Cleared"';
const EXTRA = '"Checking","","07.01.2026","Cafe","Everyday: Dining","Everyday","Dining","",€5.00,€0.00,"Uncleared"';

const CONFIG: ImportConfig = {
  currency: EUR,
  sources: [{ sourceKey: "s", label: "S", household: "s" }],
  stitchRules: [],
  exportDate: "2026-08-03",
};

function stage(rows: string[]) {
  return stageImport(
    [{ sourceKey: "s", registerCsv: [HEADER, ...rows].join("\n") + "\n", planCsv: PLAN + "\n" }],
    CONFIG,
    "2026-08-03",
  ).staging.transactions;
}

describe("reconcileTransactions", () => {
  it("re-importing the same export is a no-op", () => {
    const first = stage([INCOME, GROCERIES]);
    const second = stage([INCOME, GROCERIES]);
    const { report, merged } = reconcileTransactions(first, second);
    expect(report).toEqual({ added: 0, changed: 0, unchanged: 2, deleted: 0 });
    // Ids are preserved from the first import.
    const firstIds = new Set(first.map((t) => t.id));
    expect(merged.every((t) => firstIds.has(t.id))).toBe(true);
  });

  it("detects an in-place change (cleared status) without adding/deleting", () => {
    const first = stage([INCOME, GROCERIES]);
    const second = stage([INCOME, GROCERIES_CLEARED]);
    const { report } = reconcileTransactions(first, second);
    expect(report).toEqual({ added: 0, changed: 1, unchanged: 1, deleted: 0 });
  });

  it("detects an added transaction", () => {
    const first = stage([INCOME, GROCERIES]);
    const second = stage([INCOME, GROCERIES, EXTRA]);
    const { report, merged } = reconcileTransactions(first, second);
    expect(report.added).toBe(1);
    expect(report.deleted).toBe(0);
    expect(merged).toHaveLength(3);
  });

  it("detects a deleted transaction (vanished from the re-imported source)", () => {
    const first = stage([INCOME, GROCERIES, EXTRA]);
    const second = stage([INCOME, GROCERIES]);
    const { report, merged } = reconcileTransactions(first, second);
    expect(report.deleted).toBe(1);
    expect(merged).toHaveLength(2);
  });

  it("treats an amount edit as delete+add (identity changes)", () => {
    const first = stage([INCOME, GROCERIES]);
    const edited = '"Checking","","06.01.2026","Shop","Everyday: Groceries","Everyday","Groceries","",€99.00,€0.00,"Uncleared"';
    const second = stage([INCOME, edited]);
    const { report } = reconcileTransactions(first, second);
    expect(report.added).toBe(1);
    expect(report.deleted).toBe(1);
    expect(report.changed).toBe(0);
  });
});
