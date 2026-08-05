import { describe, expect, it } from "vitest";
import { InMemoryFileSystem } from "./memoryFs.js";
import { BudgetRepository } from "./repository.js";
import * as layout from "./layout.js";
import * as f from "../../test/fixtures/factories.js";
import type { Cents } from "../money.js";
import type { LoadedBudget } from "../model/types.js";

function sampleBudget(): LoadedBudget {
  return {
    budget: f.budget(),
    accounts: [f.account(), f.account({ id: f.tid("ACC2"), name: "Card", type: "creditCard" })],
    groups: [f.group(), f.group({ id: f.tid("GRP2"), name: "Income", kind: "income" })],
    categories: [f.category(), f.category({ id: f.tid("CAT2"), name: "Rent" })],
    assignments: [f.assignment(), f.assignment({ id: f.tid("ASG2"), categoryId: f.tid("CAT2") })],
    transactions: [
      f.txn({ id: f.tid("TXN1"), date: "2026-01-15" }),
      f.txn({ id: f.tid("TXN2"), date: "2026-02-03", amount: -900 as Cents }),
      f.txn({ id: f.tid("TXN3"), date: "2026-02-20", amount: -450 as Cents }),
    ],
  };
}

async function save(repo: BudgetRepository, b: LoadedBudget): Promise<void> {
  await repo.saveBudgetMeta(b.budget);
  await repo.saveAccounts(b.budget.id, b.accounts);
  await repo.saveCategories(b.budget.id, b.groups, b.categories);
  await repo.saveAssignments(b.budget.id, b.assignments);
  await repo.writeAllTransactions(b.budget.id, b.transactions);
}

describe("BudgetRepository round-trip", () => {
  it("saves and loads a budget losslessly", async () => {
    const fs = new InMemoryFileSystem();
    const repo = new BudgetRepository(fs);
    const b = sampleBudget();

    await save(repo, b);
    const loaded = await repo.loadBudget(b.budget.id);

    // Compare as sets-by-id (load order is shard/id sorted, not insertion order).
    expect(loaded.budget).toEqual(b.budget);
    expect(sortById(loaded.accounts)).toEqual(sortById(b.accounts));
    expect(sortById(loaded.groups)).toEqual(sortById(b.groups));
    expect(sortById(loaded.categories)).toEqual(sortById(b.categories));
    expect(sortById(loaded.assignments)).toEqual(sortById(b.assignments));
    expect(sortById(loaded.transactions)).toEqual(sortById(b.transactions));
  });

  it("shards transactions by month", async () => {
    const fs = new InMemoryFileSystem();
    const repo = new BudgetRepository(fs);
    const b = sampleBudget();
    await save(repo, b);

    expect(fs.has(layout.transactionShard(b.budget.id, "2026-01"))).toBe(true);
    expect(fs.has(layout.transactionShard(b.budget.id, "2026-02"))).toBe(true);
    // Feb shard has two records.
    const febText = await fs.readTextFile(layout.transactionShard(b.budget.id, "2026-02"));
    expect(febText!.trim().split("\n")).toHaveLength(2);
  });

  it("serializes deterministically (byte-stable across two writes)", async () => {
    const a = new InMemoryFileSystem();
    const bfs = new InMemoryFileSystem();
    const b = sampleBudget();
    await save(new BudgetRepository(a), b);
    await save(new BudgetRepository(bfs), b);
    expect(a.snapshot()).toEqual(bfs.snapshot());
  });

  it("removes stale shards when a month empties out", async () => {
    const fs = new InMemoryFileSystem();
    const repo = new BudgetRepository(fs);
    const b = sampleBudget();
    await save(repo, b);
    expect(fs.has(layout.transactionShard(b.budget.id, "2026-02"))).toBe(true);

    // Rewrite with only the January transaction.
    await repo.writeAllTransactions(b.budget.id, [b.transactions[0]!]);
    expect(fs.has(layout.transactionShard(b.budget.id, "2026-01"))).toBe(true);
    expect(fs.has(layout.transactionShard(b.budget.id, "2026-02"))).toBe(false);
  });

  it("upserts a single transaction, touching only its shard", async () => {
    const fs = new InMemoryFileSystem();
    const repo = new BudgetRepository(fs);
    const b = sampleBudget();
    await save(repo, b);

    const janBefore = await fs.readTextFile(layout.transactionShard(b.budget.id, "2026-01"));
    const updated = f.txn({ id: f.tid("TXN2"), date: "2026-02-03", amount: -111 as Cents });
    await repo.upsertTransactions(b.budget.id, [updated]);

    const janAfter = await fs.readTextFile(layout.transactionShard(b.budget.id, "2026-01"));
    expect(janAfter).toBe(janBefore); // untouched

    const loaded = await repo.loadBudget(b.budget.id);
    const t2 = loaded.transactions.find((t) => t.id === f.tid("TXN2"))!;
    expect(t2.amount).toBe(-111);
  });

  it("registers budgets in the app index and tracks the active one", async () => {
    const fs = new InMemoryFileSystem();
    const repo = new BudgetRepository(fs);
    await repo.registerBudget({ id: f.tid("BUD1"), name: "Test Budget" });
    const app = await repo.loadApp();
    expect(app.budgets).toHaveLength(1);
    expect(app.activeBudgetId).toBe(f.tid("BUD1"));
  });
});

function sortById<T extends { id: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
