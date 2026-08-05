import type { MonthKey } from "../time.js";

/**
 * Relative paths within the data root. No absolute paths are ever stored, so the
 * whole root can be relocated (e.g. into a synced cloud folder) without rewrites.
 */

export const APP_FILE = "app.json";
/** User-saved register formats (column mappings), app-wide. */
export const FORMATS_FILE = "formats.json";

export function budgetDir(budgetId: string): string {
  return `budgets/${budgetId}`;
}
export function budgetFile(budgetId: string): string {
  return `${budgetDir(budgetId)}/budget.json`;
}
export function accountsFile(budgetId: string): string {
  return `${budgetDir(budgetId)}/accounts.json`;
}
export function categoriesFile(budgetId: string): string {
  return `${budgetDir(budgetId)}/categories.json`;
}
export function assignmentsFile(budgetId: string): string {
  return `${budgetDir(budgetId)}/assignments.json`;
}
export function transactionsDir(budgetId: string): string {
  return `${budgetDir(budgetId)}/transactions`;
}
export function transactionShard(budgetId: string, month: MonthKey): string {
  return `${transactionsDir(budgetId)}/${month}.ndjson`;
}
export function importDir(budgetId: string): string {
  return `${budgetDir(budgetId)}/import`;
}
/** Per-budget registry of statement sources: which account uses which format. */
export function importSourcesFile(budgetId: string): string {
  return `${importDir(budgetId)}/sources.json`;
}

const SHARD_RE = /^(\d{4}-\d{2})\.ndjson$/;

/** Extract the MonthKey from a shard filename, or null if it isn't one. */
export function shardMonth(fileName: string): MonthKey | null {
  const m = SHARD_RE.exec(fileName);
  return m ? m[1]! : null;
}
