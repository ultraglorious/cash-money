import { describe, expect, it } from "vitest";
import type { Fingerprint } from "../ids.js";
import { EUR } from "../money.js";
import type { Cents } from "../money.js";
import type { ImportConfig } from "./config.js";
import { mergeImport } from "./merge.js";
import { stageImport } from "./pipeline.js";
import * as f from "../../test/fixtures/factories.js";

const REG_V1 = `﻿"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"
"Checking","","05.01.2026","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","",€0.00,€3000.00,"Cleared"
"Checking","","10.01.2026","Shop","Everyday: Groceries","Everyday","Groceries","",€40.00,€0.00,"Cleared"
`;
// V2 = V1 plus one new row in a NEW category (a later fresh export).
const REG_V2 = `﻿"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"
"Checking","","05.01.2026","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","",€0.00,€3000.00,"Cleared"
"Checking","","10.01.2026","Shop","Everyday: Groceries","Everyday","Groceries","",€40.00,€0.00,"Cleared"
"Checking","","02.02.2026","Cafe","Everyday: Dining","Everyday","Dining","",€12.00,€0.00,"Cleared"
`;
const PLAN = `﻿"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"
"Jan 2026","Everyday: Groceries","Everyday","Groceries",€100.00,-€40.00,€60.00
`;

const CONFIG: ImportConfig = {
  currency: EUR,
  budgetName: "B",
  sources: [{ sourceKey: "main", label: "Main", household: "Main" }],
  exportDate: "2026-08-03",
};

const stage = (reg: string) =>
  stageImport([{ sourceKey: "main", registerCsv: reg, planCsv: PLAN }], CONFIG, "2026-08-03").staging;

describe("mergeImport", () => {
  it("re-importing the same snapshot is a no-op with stable entity ids", () => {
    const existing = stage(REG_V1);
    const { merged, report } = mergeImport(existing, stage(REG_V1));
    expect(report.transactions).toMatchObject({ added: 0, changed: 0, deleted: 0 });
    expect(report).toMatchObject({ accountsAdded: 0, groupsAdded: 0, categoriesAdded: 0 });
    expect(merged.accounts.map((a) => a.id)).toEqual(existing.accounts.map((a) => a.id));
    expect(merged.categories.map((c) => c.id)).toEqual(existing.categories.map((c) => c.id));
    expect(merged.budget.id).toBe(existing.budget.id);
    // Matched rows keep their existing ids.
    const ids = new Set(existing.transactions.map((t) => t.id));
    expect(merged.transactions.every((t) => ids.has(t.id))).toBe(true);
  });

  it("preserves app-created transactions and rows from other sources", () => {
    const existing = stage(REG_V1);
    const cat = existing.categories.find((c) => c.name === "Groceries")!;
    const appTxn = f.txn({
      id: f.tid("TAPP"),
      accountId: existing.accounts[0]!.id,
      date: "2026-01-20",
      amount: -777 as Cents,
      payee: "Manual entry",
      categoryId: cat.id,
    });
    delete (appTxn as { source?: unknown }).source;
    const stmtTxn = {
      ...f.txn({ id: f.tid("TSTM"), accountId: existing.accounts[0]!.id, date: "2026-01-21", amount: -555 as Cents, payee: "Bank row" }),
      source: {
        sourceBudget: "stmt:acc",
        naturalKey: existing.transactions[0]!.source!.naturalKey,
        occurrenceIndex: 9,
        identity: "f".repeat(64) as Fingerprint,
        firstSeenExportTs: "2026-01-21",
        lastSeenExportTs: "2026-01-21",
      },
    };
    const withEdits = { ...existing, transactions: [...existing.transactions, appTxn, stmtTxn] };

    const { merged, report } = mergeImport(withEdits, stage(REG_V2));
    expect(merged.transactions.some((t) => t.id === f.tid("TAPP"))).toBe(true);
    expect(merged.transactions.some((t) => t.id === f.tid("TSTM"))).toBe(true);
    // The app transaction still points at the SAME category id (it matched).
    expect(merged.transactions.find((t) => t.id === f.tid("TAPP"))!.categoryId).toBe(cat.id);
    // V2's new row arrived; nothing was deleted.
    expect(report.transactions.added).toBe(1);
    expect(report.transactions.deleted).toBe(0);
  });

  it("adds new snapshot categories and keeps app-created assignments", () => {
    const existing = stage(REG_V1);
    // App-created category with its own assignment.
    const appCat = f.category({ id: f.tid("CAPP"), groupId: existing.groups[0]!.id, name: "My own" });
    const appAsg = f.assignment({ id: f.tid("AAPP"), month: "2026-01", categoryId: appCat.id, assigned: 1234 as Cents });
    const withApp = { ...existing, categories: [...existing.categories, appCat], assignments: [...existing.assignments, appAsg] };

    const { merged, report } = mergeImport(withApp, stage(REG_V2));
    expect(report.categoriesAdded).toBe(1); // "Dining" from V2
    expect(merged.categories.some((c) => c.name === "Dining")).toBe(true);
    expect(merged.categories.some((c) => c.id === appCat.id)).toBe(true);
    // The app category's assignment survived; the imported one follows the snapshot.
    expect(merged.assignments.some((a) => a.id === f.tid("AAPP"))).toBe(true);
    const gro = merged.categories.find((c) => c.name === "Groceries")!;
    const groAsg = merged.assignments.filter((a) => a.categoryId === gro.id && a.month === "2026-01");
    expect(groAsg).toHaveLength(1);
    expect(groAsg[0]!.assigned).toBe(10000);
  });
});
