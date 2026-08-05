import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import { computeProjection } from "../engine/compute.js";
import type { ImportConfig } from "./config.js";
import { stageImport } from "./pipeline.js";

/**
 * A miniature two-budget merge exercising: income, a credit-card purchase + payoff
 * transfer, a split, a cross-budget funding transfer (recorded as plain payees on
 * each side), and a false-positive same-amount bank payee that must NOT stitch.
 */

// Personal budget: checking + credit card.
const PERSONAL_REG = `﻿"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"
"Checking","","05.01.2026","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","",€0.00,€3000.00,"Cleared"
"Checking","","31.01.2026","Joint Account","Savings: Reserved for Joint","Savings","Reserved for Joint","Jan transfer",€1000.00,€0.00,"Cleared"
"Checking","","10.01.2026","Acme Bank","Monthly Bills: Bank Fees","Monthly Bills","Bank Fees","",€2.00,€0.00,"Cleared"
"Card","","12.01.2026","Market","Everyday: Groceries","Everyday","Groceries","Split (1/2) veg",€30.00,€0.00,"Cleared"
"Card","","12.01.2026","Market","Everyday: Dining","Everyday","Dining","Split (2/2) lunch",€20.00,€0.00,"Cleared"
"Checking","","15.01.2026","Transfer : Card","","","","",€50.00,€0.00,"Cleared"
"Card","","15.01.2026","Transfer : Checking","","","","",€0.00,€50.00,"Cleared"
`;
const PERSONAL_PLAN = `﻿"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"
"Jan 2026","Everyday: Groceries","Everyday","Groceries",€100.00,-€30.00,€70.00
"Jan 2026","Everyday: Dining","Everyday","Dining",€40.00,-€20.00,€20.00
"Jan 2026","Credit Card Payments: Card","Credit Card Payments","Card",€0.00,€50.00,€50.00
`;

// Joint budget: one account. Receives the funding as a plain "Me" payee.
const JOINT_REG = `﻿"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"
"Joint Account","","31.01.2026","Me","Inflow: Ready to Assign","Inflow","Ready to Assign","Jan transfer",€0.00,€1000.00,"Cleared"
"Joint Account","","20.01.2026","Grocer","Everyday Expenses: Groceries","Everyday Expenses","Groceries","",€40.00,€0.00,"Cleared"
"Joint Account","","10.01.2026","Acme Bank","Monthly Obligations: Bank Fees","Monthly Obligations","Bank Fees","",€2.00,€0.00,"Cleared"
`;
const JOINT_PLAN = `﻿"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"
"Jan 2026","Everyday Expenses: Groceries","Everyday Expenses","Groceries",€50.00,-€40.00,€10.00
`;

const CONFIG: ImportConfig = {
  currency: EUR,
  budgetName: "Household",
  sources: [
    { sourceKey: "personal", label: "Personal", household: "personal" },
    { sourceKey: "joint", label: "Joint", household: "joint" },
  ],
  stitchRules: [
    { aSourceKey: "personal", aLinkPayee: "Joint Account", bSourceKey: "joint", bLinkPayee: "Me", windowDays: 3 },
  ],
  exportDate: "2026-08-03",
  trackingAccountHints: ["investment", "deposit", "etf", "shares"],
};

function run() {
  return stageImport(
    [
      { sourceKey: "personal", registerCsv: PERSONAL_REG, planCsv: PERSONAL_PLAN },
      { sourceKey: "joint", registerCsv: JOINT_REG, planCsv: JOINT_PLAN },
    ],
    CONFIG,
    "2026-08-03",
  );
}

describe("stageImport end-to-end merge", () => {
  it("merges into one budget with all accounts as siblings", () => {
    const { staging } = run();
    const names = staging.accounts.map((a) => a.name).sort();
    expect(names).toEqual(["Card", "Checking", "Joint Account"]);
    expect(staging.accounts.find((a) => a.name === "Card")!.type).toBe("creditCard");
  });

  it("keeps same-named groups separate by household", () => {
    const { staging } = run();
    const groceriesGroups = staging.groups.filter((g) => g.name.toLowerCase().includes("everyday"));
    // "Everyday" (personal) and "Everyday Expenses" (joint) are distinct groups.
    expect(new Set(groceriesGroups.map((g) => g.household)).size).toBeGreaterThan(1);
  });

  it("stitches the cross-budget funding into one linked transfer (not income)", () => {
    const { staging, report } = run();
    expect(report.transfers.crossMatched).toBe(1);
    // Two legs share a pairId; the joint inflow is no longer income.
    const xfer = staging.transactions.filter((t) => t.transfer);
    const pairIds = new Set(xfer.map((t) => t.transfer!.pairId));
    // within-budget CC payoff (1 pair = 2 legs) + cross-budget (2 legs) = 4 legs, 2 pairs
    expect(xfer).toHaveLength(4);
    expect(pairIds.size).toBe(2);
  });

  it("does not stitch the same-amount own-bank fee rows", () => {
    const { staging } = run();
    const bank = staging.transactions.filter((t) => t.payee === "Acme Bank");
    expect(bank).toHaveLength(2);
    expect(bank.every((t) => !t.transfer)).toBe(true);
  });

  it("reconstructs the split and links the card payment category", () => {
    const { staging, report } = run();
    expect(report.splitsReconstructed).toBe(1);
    const split = staging.transactions.find((t) => t.splits);
    expect(split!.splits).toHaveLength(2);
    expect(report.creditCardLinks).toBe(1);
    const card = staging.accounts.find((a) => a.name === "Card")!;
    expect(staging.categories.some((c) => c.linkedAccountId === card.id)).toBe(true);
  });

  it("conserves money and produces a coherent budget the engine can compute", () => {
    const { staging, report } = run();
    // Net across accounts: personal income 3000 - 1000 joint transfer out - 2 fee
    // - 50 (split, on card) ... check the engine runs and RTA is sane.
    const p = computeProjection(staging);
    const last = p.months[p.months.length - 1]!;
    const view = p.monthView(last);
    const sumAvail = view.flat.reduce((a, c) => a + c.available, 0);
    const total = sumAvail + view.readyToAssign;
    const bal = p.accountBalances();
    let onBudget = 0;
    for (const acc of staging.accounts) if (acc.onBudget) onBudget += bal.get(acc.id)!;
    expect(total).toBe(onBudget);
    expect(report.unresolvedCategories).toBe(0);
  });
});
