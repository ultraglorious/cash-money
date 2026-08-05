import { newId, type Ulid } from "./ids.js";
import type { Cents } from "./money.js";
import type { MonthKey } from "./time.js";
import type {
  Account,
  AccountType,
  Category,
  CategoryGroup,
  LoadedBudget,
  MonthlyAssignment,
  SplitLine,
  Transaction,
} from "./model/types.js";

/**
 * Pure budget operations: every user action that mutates a budget is a
 * `(budget, args) => budget` transform here, returning a new immutable copy.
 * The React layer only dispatches these, so feature behavior is unit-tested
 * directly (and verified through the engine) without any DOM.
 */

function replace<T extends { id: Ulid }>(arr: readonly T[], id: Ulid, fn: (t: T) => T): T[] {
  return arr.map((t) => (t.id === id ? fn(t) : t));
}

// ---- Accounts --------------------------------------------------------------

export function addAccount(
  b: LoadedBudget,
  args: { name: string; type: AccountType; onBudget?: boolean; household?: string },
): LoadedBudget {
  const sortOrder = Math.max(-1, ...b.accounts.map((a) => a.sortOrder)) + 1;
  const account: Account = {
    id: newId(),
    name: args.name,
    type: args.type,
    onBudget: args.onBudget ?? args.type !== "tracking",
    closed: false,
    sortOrder,
    ...(args.household ? { household: args.household } : {}),
  };
  return { ...b, accounts: [...b.accounts, account] };
}

/** Set the display order of household panels in the Plan. */
export function setHouseholdOrder(b: LoadedBudget, orderedHouseholds: readonly string[]): LoadedBudget {
  return { ...b, budget: { ...b.budget, householdOrder: [...orderedHouseholds] } };
}

/** Set the explicit order of accounts (drag reorder in the sidebar). */
export function setAccountOrder(b: LoadedBudget, orderedIds: readonly Ulid[]): LoadedBudget {
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  return {
    ...b,
    accounts: b.accounts.map((a) => (pos.has(a.id) ? { ...a, sortOrder: pos.get(a.id)! } : a)),
  };
}

// ---- Sections (category groups) --------------------------------------------

export function addGroup(
  b: LoadedBudget,
  args: { name: string; household?: string; kind?: CategoryGroup["kind"] },
): LoadedBudget {
  const sortOrder = Math.max(-1, ...b.groups.map((g) => g.sortOrder)) + 1;
  const group: CategoryGroup = {
    id: newId(),
    name: args.name,
    kind: args.kind ?? "normal",
    sortOrder,
    hidden: false,
    ...(args.household ? { household: args.household } : {}),
  };
  return { ...b, groups: [...b.groups, group] };
}

export function renameGroup(b: LoadedBudget, groupId: Ulid, name: string): LoadedBudget {
  return { ...b, groups: replace(b.groups, groupId, (g) => ({ ...g, name })) };
}

export function setGroupHidden(b: LoadedBudget, groupId: Ulid, hidden: boolean): LoadedBudget {
  return { ...b, groups: replace(b.groups, groupId, (g) => ({ ...g, hidden })) };
}

/** Set the explicit order of sections (drag reorder within a household). */
export function setGroupOrder(b: LoadedBudget, orderedGroupIds: readonly Ulid[]): LoadedBudget {
  const pos = new Map(orderedGroupIds.map((id, i) => [id, i]));
  return {
    ...b,
    groups: b.groups.map((g) => (pos.has(g.id) ? { ...g, sortOrder: pos.get(g.id)! } : g)),
  };
}

/** Delete a section and all its categories (transactions in them become uncategorized). */
export function deleteGroup(b: LoadedBudget, groupId: Ulid): LoadedBudget {
  const catIds = b.categories.filter((c) => c.groupId === groupId).map((c) => c.id);
  let next = b;
  for (const id of catIds) next = deleteCategory(next, id);
  return { ...next, groups: next.groups.filter((g) => g.id !== groupId) };
}

// ---- Categories ------------------------------------------------------------

export function addCategory(b: LoadedBudget, args: { groupId: Ulid; name: string }): LoadedBudget {
  const sortOrder = Math.max(-1, ...b.categories.map((c) => c.sortOrder)) + 1;
  const category: Category = {
    id: newId(),
    groupId: args.groupId,
    name: args.name,
    sortOrder,
    hidden: false,
  };
  return { ...b, categories: [...b.categories, category] };
}

export function renameCategory(b: LoadedBudget, categoryId: Ulid, name: string): LoadedBudget {
  return { ...b, categories: replace(b.categories, categoryId, (c) => ({ ...c, name })) };
}

export function moveCategory(b: LoadedBudget, categoryId: Ulid, toGroupId: Ulid): LoadedBudget {
  return { ...b, categories: replace(b.categories, categoryId, (c) => ({ ...c, groupId: toGroupId })) };
}

/**
 * Move a category into a group at a specific position, renumbering that group's
 * categories 0..n. Handles both within-section reordering (same group) and
 * cross-section drops.
 */
export function reorderCategory(
  b: LoadedBudget,
  categoryId: Ulid,
  toGroupId: Ulid,
  targetIndex: number,
): LoadedBudget {
  if (!b.categories.some((c) => c.id === categoryId)) return b;
  const siblings = b.categories
    .filter((c) => c.groupId === toGroupId && c.id !== categoryId)
    .sort((a, c) => a.sortOrder - c.sortOrder);
  const i = Math.max(0, Math.min(targetIndex, siblings.length));
  const orderedIds = [...siblings.slice(0, i).map((c) => c.id), categoryId, ...siblings.slice(i).map((c) => c.id)];
  const pos = new Map(orderedIds.map((id, idx) => [id, idx]));
  return {
    ...b,
    categories: b.categories.map((c) => {
      if (c.id === categoryId) return { ...c, groupId: toGroupId, sortOrder: pos.get(c.id)! };
      if (pos.has(c.id)) return { ...c, sortOrder: pos.get(c.id)! };
      return c;
    }),
  };
}

/** Set the explicit order of a group's categories (e.g. from a sort preset). */
export function setCategoryOrder(b: LoadedBudget, groupId: Ulid, orderedIds: readonly Ulid[]): LoadedBudget {
  const pos = new Map(orderedIds.map((id, i) => [id, i]));
  return {
    ...b,
    categories: b.categories.map((c) => (c.groupId === groupId && pos.has(c.id) ? { ...c, sortOrder: pos.get(c.id)! } : c)),
  };
}

export function setCategoryHidden(b: LoadedBudget, categoryId: Ulid, hidden: boolean): LoadedBudget {
  return { ...b, categories: replace(b.categories, categoryId, (c) => ({ ...c, hidden })) };
}

/** Delete a category: drop its assignments and clear it from any txn/split lines. */
export function deleteCategory(b: LoadedBudget, categoryId: Ulid): LoadedBudget {
  const clearCat = (t: Transaction): Transaction => {
    let changed = false;
    let categoryId2 = t.categoryId;
    if (t.categoryId === categoryId) {
      categoryId2 = undefined;
      changed = true;
    }
    let splits = t.splits;
    if (splits?.some((s) => s.categoryId === categoryId)) {
      splits = splits.map((s) => (s.categoryId === categoryId ? { ...s, categoryId: undefined } : s));
      changed = true;
    }
    if (!changed) return t;
    return { ...t, categoryId: categoryId2, ...(splits ? { splits } : {}) };
  };
  return {
    ...b,
    categories: b.categories.filter((c) => c.id !== categoryId),
    assignments: b.assignments.filter((a) => a.categoryId !== categoryId),
    transactions: b.transactions.map(clearCat),
  };
}

// ---- Assignments -----------------------------------------------------------

export function getAssigned(b: LoadedBudget, month: MonthKey, categoryId: Ulid): Cents {
  return (b.assignments.find((a) => a.month === month && a.categoryId === categoryId)?.assigned ?? 0) as Cents;
}

export function setAssigned(
  b: LoadedBudget,
  month: MonthKey,
  categoryId: Ulid,
  amount: Cents,
): LoadedBudget {
  const idx = b.assignments.findIndex((a) => a.month === month && a.categoryId === categoryId);
  if (idx >= 0) {
    const next = b.assignments.slice();
    next[idx] = { ...next[idx]!, assigned: amount };
    return { ...b, assignments: next };
  }
  const created: MonthlyAssignment = { id: newId(), month, categoryId, assigned: amount };
  return { ...b, assignments: [...b.assignments, created] };
}

/** Reallocate `amount` from one category to another within a month. */
export function moveMoney(
  b: LoadedBudget,
  month: MonthKey,
  fromCategoryId: Ulid,
  toCategoryId: Ulid,
  amount: Cents,
): LoadedBudget {
  const from = getAssigned(b, month, fromCategoryId);
  const to = getAssigned(b, month, toCategoryId);
  let next = setAssigned(b, month, fromCategoryId, (from - amount) as Cents);
  next = setAssigned(next, month, toCategoryId, (to + amount) as Cents);
  return next;
}

// ---- Transactions ----------------------------------------------------------

export function addTransaction(b: LoadedBudget, tx: Transaction): LoadedBudget {
  return { ...b, transactions: [...b.transactions, tx] };
}

/** Append many transactions at once (e.g. a bank-statement import). */
export function addTransactions(b: LoadedBudget, txs: readonly Transaction[]): LoadedBudget {
  return { ...b, transactions: [...b.transactions, ...txs] };
}

export function updateTransaction(
  b: LoadedBudget,
  txId: Ulid,
  patch: Partial<Omit<Transaction, "id">>,
): LoadedBudget {
  return { ...b, transactions: replace(b.transactions, txId, (t) => ({ ...t, ...patch })) };
}

export function deleteTransaction(b: LoadedBudget, txId: Ulid): LoadedBudget {
  return { ...b, transactions: b.transactions.filter((t) => t.id !== txId) };
}

export function approveTransaction(b: LoadedBudget, txId: Ulid): LoadedBudget {
  return updateTransaction(b, txId, { approved: true });
}

/**
 * Set (or clear) a transaction's splits. Splits must sum to the transaction
 * amount; when set, the top-level categoryId is cleared. Passing undefined
 * unsplits back to a single categoryId.
 */
export function setSplits(
  b: LoadedBudget,
  txId: Ulid,
  splits: SplitLine[] | undefined,
  categoryIdWhenUnsplit?: Ulid,
): LoadedBudget {
  return {
    ...b,
    transactions: replace(b.transactions, txId, (t) => {
      if (!splits) {
        const { splits: _drop, ...rest } = t;
        return { ...rest, ...(categoryIdWhenUnsplit ? { categoryId: categoryIdWhenUnsplit } : {}) };
      }
      const sum = splits.reduce((s, l) => s + l.amount, 0);
      if (sum !== t.amount) {
        throw new Error(`Split lines (${sum}) must sum to the transaction amount (${t.amount})`);
      }
      const { categoryId: _c, ...rest } = t;
      return { ...rest, splits };
    }),
  };
}
