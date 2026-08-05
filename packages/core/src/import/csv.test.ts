import { describe, expect, it } from "vitest";
import { parsePlanCsv, parseRegisterCsv } from "./csv.js";

// Note the leading BOM (﻿) and a memo containing a comma inside quotes.
const REGISTER = `﻿"Account","Flag","Date","Payee","Category Group/Category","Category Group","Category","Memo","Outflow","Inflow","Cleared"
"Checking","","15.01.2026","Shop","Everyday: Groceries","Everyday","Groceries","Bread, milk",€12.34,€0.00,"Cleared"
"Checking","Red","16.01.2026","Employer","Inflow: Ready to Assign","Inflow","Ready to Assign","",€0.00,€2000.00,"Uncleared"
`;

const PLAN = `﻿"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"
"Jan 2026","Everyday: Groceries","Everyday","Groceries",€50.00,-€12.34,€37.66
`;

describe("parseRegisterCsv", () => {
  it("strips the BOM and parses all columns", () => {
    const rows = parseRegisterCsv(REGISTER);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      account: "Checking",
      date: "15.01.2026",
      payee: "Shop",
      group: "Everyday",
      category: "Groceries",
      outflow: "€12.34",
      inflow: "€0.00",
      cleared: "Cleared",
      sourceRow: 2,
    });
  });

  it("keeps commas inside a quoted memo (no phantom columns)", () => {
    const rows = parseRegisterCsv(REGISTER);
    expect(rows[0]!.memo).toBe("Bread, milk");
  });

  it("throws when a required column is missing", () => {
    expect(() => parseRegisterCsv(`"Account","Date"\n"Checking","15.01.2026"`)).toThrow(
      /missing expected columns/,
    );
  });
});

describe("parsePlanCsv", () => {
  it("parses month/category/assigned/activity/available", () => {
    const rows = parsePlanCsv(PLAN);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      month: "Jan 2026",
      group: "Everyday",
      category: "Groceries",
      assigned: "€50.00",
      activity: "-€12.34",
      available: "€37.66",
    });
  });
});
