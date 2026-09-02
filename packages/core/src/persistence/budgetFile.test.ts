import { describe, expect, it } from "vitest";
import type { Cents } from "../money.js";
import { parseBudgetFile, serializeBudgetFile, type BudgetFileData } from "./budgetFile.js";
import * as f from "../../test/fixtures/factories.js";

function sample(): BudgetFileData {
  const ACC = f.tid("ACC1");
  const GRP = f.tid("GRP1");
  const CAT = f.tid("CAT1");
  return {
    loaded: {
      budget: f.budget(),
      accounts: [f.account({ id: ACC, name: "Checking", type: "checking" })],
      groups: [f.group({ id: GRP, name: "Everyday", kind: "normal" })],
      categories: [f.category({ id: CAT, groupId: GRP, name: "Groceries" })],
      assignments: [f.assignment({ id: f.tid("AS1"), month: "2026-01", categoryId: CAT, assigned: 5000 as Cents })],
      transactions: [
        f.txn({ id: f.tid("TX1"), accountId: ACC, date: "2026-01-05", amount: -1234 as Cents, categoryId: CAT, recurrence: { freq: "monthly", anchorDay: 5 } }),
      ],
    },
    savedFormats: [
      {
        format: {
          id: "fmt1",
          name: "My bank",
          date: { column: "Date", format: "iso" },
          amount: { mode: "signed", column: "Amount" },
          payeeColumn: "Payee",
        },
        lastUsed: "2026-08-06",
      },
    ],
    importSources: [{ accountId: ACC, formatId: "fmt1", sourceKey: "src1", lastUsed: "2026-08-06" }],
    skippedRows: [],
  };
}

describe("budget file (single-file container)", () => {
  it("round-trips the whole budget plus formats and sources", () => {
    const text = serializeBudgetFile(sample(), "2026-08-06T12:00:00Z");
    const back = parseBudgetFile(text);
    // A budget written before payees or transfer aliases existed comes back
    // with empty lists rather than absent ones, so nothing downstream guards.
    expect(back.loaded).toEqual({ ...sample().loaded, payees: [], transferAliases: [] });
    expect(back.savedFormats).toEqual(sample().savedFormats);
    expect(back.importSources).toEqual(sample().importSources);
  });

  it("round-trips the payee master list, aliases and all", () => {
    const withPayees = {
      ...sample(),
      loaded: {
        ...sample().loaded,
        payees: [{ id: f.tid("PNorthwind"), name: "Northwind", aliases: ["as northwind bank", "as northwind insurance"] }],
      },
    };
    const back = parseBudgetFile(serializeBudgetFile(withPayees, "T"));
    expect(back.loaded.payees).toEqual(withPayees.loaded.payees);
  });

  it("round-trips the transfer aliases", () => {
    const withAliases = {
      ...sample(),
      loaded: {
        ...sample().loaded,
        transferAliases: [{ key: "northwind bank", accountId: f.tid("ACC1"), counterAccountId: f.tid("ACC2") }],
      },
    };
    const back = parseBudgetFile(serializeBudgetFile(withAliases, "T"));
    expect(back.loaded.transferAliases).toEqual(withAliases.loaded.transferAliases);
  });

  it("is byte-stable: same data serializes identically", () => {
    expect(serializeBudgetFile(sample(), "T")).toBe(serializeBudgetFile(sample(), "T"));
  });

  it("rejects broken JSON, invalid shapes, and files from newer app versions", () => {
    expect(() => parseBudgetFile("{nope")).toThrow(/broken JSON/);
    expect(() => parseBudgetFile("{}")).toThrow(/Not a valid budget file/);
    const future = serializeBudgetFile(sample(), "T").replace('"fileVersion": 1', '"fileVersion": 99');
    expect(() => parseBudgetFile(future)).toThrow(/newer app version/);
  });
});
