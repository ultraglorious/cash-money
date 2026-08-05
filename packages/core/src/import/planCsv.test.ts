import { describe, expect, it } from "vitest";
import { EUR } from "../money.js";
import { builtinFormat } from "./formats/index.js";
import { parsePlan } from "./planCsv.js";

const SEM = builtinFormat("lib:budget-export-register")!.semantics;
const OPTS = { sourceKey: "s1", currency: EUR, semantics: SEM };

// Note the leading BOM (﻿) and the extra combined column, which is ignored.
const PLAN = `﻿"Month","Category Group/Category","Category Group","Category","Assigned","Activity","Available"
"Jan 2026","Everyday: Groceries","Everyday","Groceries",€50.00,-€12.34,€37.66
"Jan 2026","Inflow: Ready to Assign","Inflow","Ready to Assign",€0.00,€0.00,€0.00
`;

describe("parsePlan", () => {
  it("parses assigned/activity/available and stamps semantics", () => {
    const rows = parsePlan(PLAN, OPTS);
    expect(rows[0]).toMatchObject({
      month: "Jan 2026",
      group: "Everyday",
      category: "Groceries",
      assigned: 5000,
      activity: -1234,
      available: 3766,
      groupKind: "normal",
      groupHidden: false,
      sourceRow: 2,
    });
    expect(rows[1]!.groupKind).toBe("income");
  });

  it("throws when the expected columns are missing", () => {
    expect(() => parsePlan('"Month","Category"\n"Jan 2026","X"\n', OPTS)).toThrow(/missing column/i);
  });
});
