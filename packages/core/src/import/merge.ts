import type { Ulid } from "../ids.js";
import type { LoadedBudget, MonthlyAssignment, Transaction } from "../model/types.js";
import { reconcileTransactions, type ReconcileReport } from "./reconcile.js";
import { SEP, fold } from "./text.js";

/**
 * Merge a freshly-staged snapshot import into an EXISTING budget, preserving
 * what the user built in-app. `stageImport` mints new ids for every entity, so
 * the staging graph is first mapped onto the existing one:
 *
 *   - accounts match by (household, folded name); groups by (household, folded
 *     name); categories by (matched group, folded name). Matched entities KEEP
 *     the existing object — id, sort order, closed/hidden flags survive. New
 *     ones are appended; existing entities absent from the snapshot are kept
 *     (they may be app-created).
 *   - staged transactions/assignments are rewritten onto the mapped ids, then
 *     transactions go through `reconcileTransactions`: identity-matched rows
 *     keep their id, app-created rows and rows from other sources (e.g. bank
 *     statements) are untouched, rows that vanished from a re-imported source
 *     are dropped.
 *   - assignments: the snapshot wins for its own categories; assignments on
 *     categories the snapshot doesn't know (app-created) are kept.
 *   - budget identity (id, name, currency, createdAt) stays the existing one,
 *     so the on-disk folder and app index remain stable.
 *
 * Limitation (documented, by design): matching is by name, so a category or
 * account renamed in-app no longer matches its source name and the re-import
 * will create a fresh entity under the source's name. Identity-stable source
 * keys are the caller's job — reuse the same sourceKey per household across
 * imports or nothing will match.
 */

export interface MergeImportReport {
  accountsMatched: number;
  accountsAdded: number;
  groupsMatched: number;
  groupsAdded: number;
  categoriesMatched: number;
  categoriesAdded: number;
  transactions: ReconcileReport;
}

export interface MergeImportResult {
  merged: LoadedBudget;
  report: MergeImportReport;
}

export function mergeImport(existing: LoadedBudget, staging: LoadedBudget): MergeImportResult {
  // ---- Map accounts by (household, folded name) -----------------------------
  const accountKey = (a: { household?: string; name: string }): string =>
    `${a.household ?? ""}${SEP}${fold(a.name)}`;
  const existingAccountByKey = new Map(existing.accounts.map((a) => [accountKey(a), a]));
  const accountIdMap = new Map<Ulid, Ulid>(); // staging id -> final id
  const newAccounts: LoadedBudget["accounts"] = [];
  let accountsMatched = 0;
  for (const a of staging.accounts) {
    const match = existingAccountByKey.get(accountKey(a));
    if (match) {
      accountIdMap.set(a.id, match.id);
      accountsMatched++;
    } else {
      accountIdMap.set(a.id, a.id);
      newAccounts.push(a);
    }
  }

  // ---- Map groups by (household, folded name) -------------------------------
  const groupKey = (g: { household?: string; name: string }): string =>
    `${g.household ?? ""}${SEP}${fold(g.name)}`;
  const existingGroupByKey = new Map(existing.groups.map((g) => [groupKey(g), g]));
  const groupIdMap = new Map<Ulid, Ulid>();
  const newGroups: LoadedBudget["groups"] = [];
  let groupsMatched = 0;
  for (const g of staging.groups) {
    const match = existingGroupByKey.get(groupKey(g));
    if (match) {
      groupIdMap.set(g.id, match.id);
      groupsMatched++;
    } else {
      groupIdMap.set(g.id, g.id);
      newGroups.push(g);
    }
  }

  // ---- Map categories by (mapped group, folded name) ------------------------
  const catKey = (groupId: Ulid, name: string): string => `${groupId}${SEP}${fold(name)}`;
  const existingCatByKey = new Map(existing.categories.map((c) => [catKey(c.groupId, c.name), c]));
  const categoryIdMap = new Map<Ulid, Ulid>();
  const newCategories: LoadedBudget["categories"] = [];
  let categoriesMatched = 0;
  for (const c of staging.categories) {
    const mappedGroup = groupIdMap.get(c.groupId) ?? c.groupId;
    const match = existingCatByKey.get(catKey(mappedGroup, c.name));
    if (match) {
      categoryIdMap.set(c.id, match.id);
      categoriesMatched++;
    } else {
      categoryIdMap.set(c.id, c.id);
      newCategories.push({
        ...c,
        groupId: mappedGroup,
        ...(c.linkedAccountId ? { linkedAccountId: accountIdMap.get(c.linkedAccountId) ?? c.linkedAccountId } : {}),
      });
    }
  }

  // ---- Rewrite staged transactions/assignments onto the mapped ids ----------
  const mapAccount = (id: Ulid): Ulid => accountIdMap.get(id) ?? id;
  const mapCategory = (id: Ulid | undefined): Ulid | undefined =>
    id === undefined ? undefined : categoryIdMap.get(id) ?? id;

  const remappedTxns: Transaction[] = staging.transactions.map((t) => ({
    ...t,
    accountId: mapAccount(t.accountId),
    ...(t.categoryId ? { categoryId: mapCategory(t.categoryId) } : {}),
    ...(t.splits ? { splits: t.splits.map((s) => ({ ...s, categoryId: mapCategory(s.categoryId) })) } : {}),
    ...(t.transfer ? { transfer: { ...t.transfer, counterAccountId: mapAccount(t.transfer.counterAccountId) } } : {}),
  }));

  const stagedCatIds = new Set([...categoryIdMap.values()]);
  const remappedAssignments: MonthlyAssignment[] = staging.assignments.map((a) => ({
    ...a,
    categoryId: mapCategory(a.categoryId)!,
  }));
  // Snapshot wins for its own categories; app-created categories keep theirs.
  const keptAssignments = existing.assignments.filter((a) => !stagedCatIds.has(a.categoryId));

  const { merged: transactions, report } = reconcileTransactions(existing.transactions, remappedTxns);

  const merged: LoadedBudget = {
    budget: existing.budget,
    accounts: [...existing.accounts, ...newAccounts],
    groups: [...existing.groups, ...newGroups],
    categories: [...existing.categories, ...newCategories],
    assignments: [...remappedAssignments, ...keptAssignments],
    transactions,
  };

  return {
    merged,
    report: {
      accountsMatched,
      accountsAdded: newAccounts.length,
      groupsMatched,
      groupsAdded: newGroups.length,
      categoriesMatched,
      categoriesAdded: newCategories.length,
      transactions: report,
    },
  };
}
