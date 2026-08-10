import { describe, expect, it } from "vitest";
import type { Cents } from "../money.js";
import type { Transaction } from "../model/types.js";
import type { BudgetFileData } from "./budgetFile.js";
import { mergeBudgetFiles, reportTookFromFile } from "./merge3.js";
import * as f from "../../test/fixtures/factories.js";

const ACC = f.tid("ACC1");
const CAT = f.tid("CAT1");

function tx(id: string, over: Partial<Transaction> = {}): Transaction {
  return f.txn({ id: f.tid(id), accountId: ACC, date: "2026-01-10", amount: -1000 as Cents, payee: "Shop", ...over });
}

function file(transactions: Transaction[], over: Partial<BudgetFileData> = {}): BudgetFileData {
  return {
    loaded: {
      budget: f.budget(),
      accounts: [f.account({ id: ACC, name: "Checking", type: "checking" })],
      groups: [],
      categories: [],
      assignments: [],
      transactions,
      ...(over.loaded ?? {}),
    },
    savedFormats: over.savedFormats ?? [],
    importSources: over.importSources ?? [],
  };
}

describe("mergeBudgetFiles (three-way)", () => {
  it("keeps additions from both sides", () => {
    const base = file([tx("T1")]);
    const ours = file([tx("T1"), tx("T2", { payee: "Local Add" })]);
    const theirs = file([tx("T1"), tx("T3", { payee: "Remote Add" })]);
    const { merged, report } = mergeBudgetFiles(base, ours, theirs);
    expect(merged.loaded.transactions.map((t) => t.payee).sort()).toEqual(["Local Add", "Remote Add", "Shop"]);
    expect(report.addedFromFile).toBe(1);
    expect(report.tiesKeptLocal).toBe(0);
  });

  it("takes a one-sided edit; untouched side yields", () => {
    const base = file([tx("T1"), tx("T2")]);
    const ours = file([tx("T1", { payee: "Edited Here" }), tx("T2")]);
    const theirs = file([tx("T1"), tx("T2", { amount: -777 as Cents })]);
    const { merged, report } = mergeBudgetFiles(base, ours, theirs);
    const byId = new Map(merged.loaded.transactions.map((t) => [t.id, t]));
    expect(byId.get(f.tid("T1"))!.payee).toBe("Edited Here");
    expect(byId.get(f.tid("T2"))!.amount).toBe(-777);
    expect(report.updatedFromFile).toBe(1);
    expect(report.tiesKeptLocal).toBe(0);
  });

  it("propagates deletions but never deletes an edited record", () => {
    const base = file([tx("T1"), tx("T2"), tx("T3")]);
    const ours = file([tx("T1"), tx("T3", { memo: "edited here" })]); // deleted T2, edited T3
    const theirs = file([tx("T2", { memo: "edited there" }), tx("T3")]); // deleted T1... and T3? no: kept T3, edited T2
    const { merged, report } = mergeBudgetFiles(base, ours, theirs);
    const ids = new Set(merged.loaded.transactions.map((t) => t.id));
    expect(ids.has(f.tid("T1"))).toBe(false); // deleted there, untouched here
    expect(ids.has(f.tid("T2"))).toBe(true); // we deleted it, but they edited it — edit survives
    expect(merged.loaded.transactions.find((t) => t.id === f.tid("T3"))!.memo).toBe("edited here");
    expect(report.deletedFromFile).toBe(1);
  });

  it("both-edited tie keeps ours and reports it", () => {
    const base = file([tx("T1")]);
    const ours = file([tx("T1", { amount: -1111 as Cents })]);
    const theirs = file([tx("T1", { amount: -2222 as Cents })]);
    const { merged, report } = mergeBudgetFiles(base, ours, theirs);
    expect(merged.loaded.transactions[0]!.amount).toBe(-1111);
    expect(report.tiesKeptLocal).toBe(1);
    expect(reportTookFromFile(report)).toBe(false);
  });

  it("keys assignments by envelope slot, not record id", () => {
    const base = file([]);
    const ours = file([]);
    const theirs = file([]);
    // Same (month, category) slot assigned on both machines under different ids.
    ours.loaded.assignments = [f.assignment({ id: f.tid("A1"), month: "2026-02", categoryId: CAT, assigned: 5000 as Cents })];
    theirs.loaded.assignments = [f.assignment({ id: f.tid("A2"), month: "2026-02", categoryId: CAT, assigned: 7000 as Cents })];
    const { merged, report } = mergeBudgetFiles(base, ours, theirs);
    expect(merged.loaded.assignments).toHaveLength(1); // never two records for one slot
    expect(merged.loaded.assignments[0]!.assigned).toBe(5000); // ours wins the tie
    expect(report.tiesKeptLocal).toBe(1);
  });

  it("dedupes the same imported row arriving from both sides under different ids", () => {
    const source = {
      sourceBudget: "stmt:acc",
      naturalKey: "nk1",
      occurrenceIndex: 0,
      identity: "id1",
      firstSeenExportTs: "2026-08-01",
      lastSeenExportTs: "2026-08-01",
    };
    const base = file([]);
    const ours = file([tx("TL", { source: source as Transaction["source"] })]);
    const theirs = file([tx("TR", { source: source as Transaction["source"] })]);
    const { merged, report } = mergeBudgetFiles(base, ours, theirs);
    expect(merged.loaded.transactions).toHaveLength(1);
    expect(merged.loaded.transactions[0]!.id).toBe(f.tid("TL")); // ours kept
    expect(report.dedupedImports).toBe(1);
  });

  it("merges budget meta one-sidedly and keeps ours on a tie", () => {
    const base = file([]);
    const ours = file([]);
    const theirs = file([]);
    theirs.loaded.budget = { ...theirs.loaded.budget, householdOrder: ["B", "A"] };
    const oneSided = mergeBudgetFiles(base, ours, theirs);
    expect(oneSided.merged.loaded.budget.householdOrder).toEqual(["B", "A"]);

    ours.loaded.budget = { ...ours.loaded.budget, name: "Ours" };
    theirs.loaded.budget = { ...theirs.loaded.budget, name: "Theirs" };
    const tied = mergeBudgetFiles(base, ours, theirs);
    expect(tied.merged.loaded.budget.name).toBe("Ours");
  });

  it("unions payee aliases learned on both machines", () => {
    const withPayees = (aliases: string[], name = "Northwind") => {
      const d = file([tx("T1")]);
      return { ...d, loaded: { ...d.loaded, payees: [{ id: f.tid("PNorthwind"), name, aliases }] } };
    };
    const base = withPayees(["as northwind bank"]);
    const ours = withPayees(["as northwind bank", "northwind insurance"]);
    const theirs = withPayees(["as northwind bank", "northwind bank tallinn"]);

    const { merged } = mergeBudgetFiles(base, ours, theirs);
    expect([...merged.loaded.payees![0]!.aliases].sort()).toEqual([
      "as northwind bank",
      "northwind bank tallinn",
      "northwind insurance",
    ]);

    // A rename still resolves this-computer-wins, and the aliases survive it.
    const renamedHere = withPayees(["as northwind bank"], "Northwind Bank");
    const renamedThere = withPayees(["as northwind bank", "learned there"], "Northwind Bank");
    const both = mergeBudgetFiles(base, renamedHere, renamedThere).merged;
    expect(both.loaded.payees![0]!.name).toBe("Northwind Bank");
    expect([...both.loaded.payees![0]!.aliases].sort()).toEqual(["as northwind bank", "learned there"]);
  });
});
