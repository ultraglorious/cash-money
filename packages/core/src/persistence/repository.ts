import { z } from "zod";
import { newId, type Ulid } from "../ids.js";
import { monthKeyOf, type ISODate, type MonthKey } from "../time.js";
import { RegisterFormatSchema, type RegisterFormat } from "../import/format.js";
import {
  AppIndexSchema,
  parseAccount,
  parseBudget,
  parseCategory,
  parseCategoryGroup,
  parseMonthlyAssignment,
  parseTransaction,
} from "../model/schema.js";
import type {
  Account,
  Budget,
  Category,
  CategoryGroup,
  LoadedBudget,
  MonthlyAssignment,
  Transaction,
} from "../model/types.js";
import { SCHEMA_VERSION } from "../model/types.js";
import * as layout from "./layout.js";
import { byId, fromNdjson, stableJson, toNdjson } from "./serialize.js";

/**
 * The only thing that knows how to touch the outside world. The desktop app
 * injects a Tauri-backed implementation; tests inject an in-memory one. All
 * paths are relative to the data root.
 */
export interface FileSystemPort {
  /** Read a text file, or null if it does not exist. */
  readTextFile(rel: string): Promise<string | null>;
  /** Write a text file atomically (temp + rename), creating parent dirs. */
  writeTextFileAtomic(rel: string, contents: string): Promise<void>;
  /** List the file names directly inside a directory (empty if missing). */
  listDir(rel: string): Promise<string[]>;
  /** Ensure a directory exists. */
  ensureDir(rel: string): Promise<void>;
  /** Remove a file if it exists (no error if absent). */
  remove(rel: string): Promise<void>;
}

export interface BudgetIndexEntry {
  id: Ulid;
  name: string;
}

export interface AppIndex {
  schemaVersion: number;
  activeBudgetId?: Ulid;
  budgets: BudgetIndexEntry[];
  /** Absolute path of the single-file budget (`.cashmoney`) this app follows. */
  budgetFilePath?: string;
}

const EMPTY_APP: AppIndex = { schemaVersion: SCHEMA_VERSION, budgets: [] };

/** A user-saved register format (library formats ship in code, never here). */
export interface SavedFormat {
  format: RegisterFormat;
  /** Last time the user imported with it (drives picker ordering). */
  lastUsed?: ISODate;
}

const SavedFormatSchema = z.object({
  format: RegisterFormatSchema,
  lastUsed: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}) as z.ZodType<SavedFormat>;

/** One statement source: an existing account fed by a format under a stable key. */
export interface ImportSourceEntry {
  accountId: Ulid;
  formatId: string;
  sourceKey: string;
  /** Last time a statement was reconciled into this account (drives recall). */
  lastUsed?: ISODate;
}

interface CategoriesFile {
  groups: CategoryGroup[];
  categories: Category[];
}

export class BudgetRepository {
  constructor(private readonly fs: FileSystemPort) {}

  // ---- App index -----------------------------------------------------------

  async loadApp(): Promise<AppIndex> {
    const text = await this.fs.readTextFile(layout.APP_FILE);
    if (text === null) return { ...EMPTY_APP };
    // Validate like every other file read: a corrupted index should be a clear
    // error at the boundary, not undefined-shaped state downstream.
    return AppIndexSchema.parse(JSON.parse(text)) as AppIndex;
  }

  async saveApp(app: AppIndex): Promise<void> {
    await this.fs.writeTextFileAtomic(layout.APP_FILE, stableJson(app));
  }

  /** Register a budget in the app index (idempotent by id). */
  async registerBudget(entry: BudgetIndexEntry, makeActive = true): Promise<void> {
    const app = await this.loadApp();
    const existing = app.budgets.findIndex((b) => b.id === entry.id);
    if (existing >= 0) app.budgets[existing] = entry;
    else app.budgets.push(entry);
    if (makeActive) app.activeBudgetId = entry.id;
    await this.saveApp(app);
  }

  // ---- Saved register formats (app-wide) ------------------------------------

  /** Load user-saved register formats; invalid entries are dropped, not fatal. */
  async loadFormats(): Promise<SavedFormat[]> {
    const text = await this.fs.readTextFile(layout.FORMATS_FILE);
    if (text === null) return [];
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw)) return [];
    const out: SavedFormat[] = [];
    for (const entry of raw) {
      const parsed = SavedFormatSchema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  async saveFormats(formats: readonly SavedFormat[]): Promise<void> {
    await this.fs.writeTextFileAtomic(layout.FORMATS_FILE, stableJson(formats));
  }

  // ---- Statement sources (per budget) ---------------------------------------

  /**
   * The registry of statement sources: which existing account is fed by which
   * format, under which stable sourceKey. The sourceKey is minted once per
   * account and reused for every later statement import — that stability is
   * what makes statement re-import idempotent.
   */
  async loadImportSources(budgetId: string): Promise<ImportSourceEntry[]> {
    const text = await this.fs.readTextFile(layout.importSourcesFile(budgetId));
    if (text === null) return [];
    const raw: unknown = JSON.parse(text);
    return Array.isArray(raw) ? (raw as ImportSourceEntry[]) : [];
  }

  async saveImportSources(budgetId: string, entries: readonly ImportSourceEntry[]): Promise<void> {
    await this.fs.writeTextFileAtomic(layout.importSourcesFile(budgetId), stableJson(entries));
  }

  // ---- Whole-budget save/load ----------------------------------------------

  async saveBudgetMeta(budget: Budget): Promise<void> {
    await this.fs.writeTextFileAtomic(layout.budgetFile(budget.id), stableJson(budget));
  }

  async saveAccounts(budgetId: string, accounts: readonly Account[]): Promise<void> {
    await this.fs.writeTextFileAtomic(
      layout.accountsFile(budgetId),
      stableJson(byId(accounts)),
    );
  }

  async saveCategories(
    budgetId: string,
    groups: readonly CategoryGroup[],
    categories: readonly Category[],
  ): Promise<void> {
    const payload: CategoriesFile = {
      groups: byId(groups),
      categories: byId(categories),
    };
    await this.fs.writeTextFileAtomic(layout.categoriesFile(budgetId), stableJson(payload));
  }

  async saveAssignments(
    budgetId: string,
    assignments: readonly MonthlyAssignment[],
  ): Promise<void> {
    await this.fs.writeTextFileAtomic(
      layout.assignmentsFile(budgetId),
      stableJson(byId(assignments)),
    );
  }

  /**
   * Replace the full transaction set. Groups by the real date-month, writes one
   * shard per month, and removes shards that no longer have any transactions.
   */
  async writeAllTransactions(
    budgetId: string,
    transactions: readonly Transaction[],
  ): Promise<void> {
    const byMonth = groupByMonth(transactions);
    await this.fs.ensureDir(layout.transactionsDir(budgetId));

    for (const [month, txns] of byMonth) {
      await this.fs.writeTextFileAtomic(
        layout.transactionShard(budgetId, month),
        toNdjson(byId(txns)),
      );
    }

    // Remove stale shards for months that no longer have any transactions.
    const existing = await this.listShardMonths(budgetId);
    for (const month of existing) {
      if (!byMonth.has(month)) {
        await this.fs.remove(layout.transactionShard(budgetId, month));
      }
    }
  }

  /**
   * Rewrite ONLY the given months' shards from the full in-memory transaction
   * list (deleting a shard whose month has emptied). The caller names every
   * month an edit touched — including a moved transaction's OLD month — so a
   * cross-month date change can never leave a stale copy behind.
   */
  async writeTransactionMonths(
    budgetId: string,
    transactions: readonly Transaction[],
    months: ReadonlySet<MonthKey>,
  ): Promise<void> {
    if (months.size === 0) return;
    const byMonth = groupByMonth(transactions);
    await this.fs.ensureDir(layout.transactionsDir(budgetId));
    for (const month of months) {
      const txns = byMonth.get(month);
      if (txns && txns.length > 0) {
        await this.fs.writeTextFileAtomic(
          layout.transactionShard(budgetId, month),
          toNdjson(byId(txns)),
        );
      } else {
        await this.fs.remove(layout.transactionShard(budgetId, month));
      }
    }
  }

  async loadBudget(budgetId: string): Promise<LoadedBudget> {
    const budgetText = await this.fs.readTextFile(layout.budgetFile(budgetId));
    if (budgetText === null) {
      throw new Error(`Budget not found: ${budgetId}`);
    }
    const budget = parseBudget(JSON.parse(budgetText));

    const accounts = await this.readJsonArray(layout.accountsFile(budgetId), parseAccount);

    const categoriesText = await this.fs.readTextFile(layout.categoriesFile(budgetId));
    const groups: CategoryGroup[] = [];
    const categories: Category[] = [];
    if (categoriesText !== null) {
      const raw = JSON.parse(categoriesText) as { groups?: unknown[]; categories?: unknown[] };
      for (const g of raw.groups ?? []) groups.push(parseCategoryGroup(g));
      for (const c of raw.categories ?? []) categories.push(parseCategory(c));
    }

    const assignments = await this.readJsonArray(
      layout.assignmentsFile(budgetId),
      parseMonthlyAssignment,
    );

    const transactions: Transaction[] = [];
    for (const month of await this.listShardMonths(budgetId)) {
      transactions.push(...(await this.readShard(budgetId, month)));
    }

    return { budget, accounts, groups, categories, assignments, transactions };
  }

  // ---- Helpers -------------------------------------------------------------

  private async readJsonArray<T>(rel: string, parse: (raw: unknown) => T): Promise<T[]> {
    const text = await this.fs.readTextFile(rel);
    if (text === null) return [];
    const raw = JSON.parse(text) as unknown[];
    return raw.map(parse);
  }

  private async readShard(budgetId: string, month: MonthKey): Promise<Transaction[]> {
    const text = await this.fs.readTextFile(layout.transactionShard(budgetId, month));
    if (text === null) return [];
    return fromNdjson(text).map(parseTransaction);
  }

  private async listShardMonths(budgetId: string): Promise<MonthKey[]> {
    const names = await this.fs.listDir(layout.transactionsDir(budgetId));
    const months: MonthKey[] = [];
    for (const name of names) {
      const month = layout.shardMonth(name);
      if (month) months.push(month);
    }
    return months.sort();
  }
}

function groupByMonth(
  transactions: readonly Transaction[],
): Map<MonthKey, Transaction[]> {
  const byMonth = new Map<MonthKey, Transaction[]>();
  for (const t of transactions) {
    const key = monthKeyOf(t.date);
    const list = byMonth.get(key);
    if (list) list.push(t);
    else byMonth.set(key, [t]);
  }
  return byMonth;
}

/** Convenience factory for a fresh budget's metadata record. */
export function makeBudget(name: string, currency: Budget["currency"], createdAt: ISODate): Budget {
  return {
    id: newId(),
    name,
    currency,
    createdAt,
    schemaVersion: SCHEMA_VERSION,
  };
}
