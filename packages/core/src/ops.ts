import { newId, type Ulid } from "./ids.js";
import type { Cents } from "./money.js";
import { nextOccurrence, type ISODate, type MonthKey } from "./time.js";
import { computeProjection } from "./engine/compute.js";
import type {
  Account,
  AccountType,
  Category,
  CategoryGroup,
  ClearedStatus,
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

/** Hide (close) or show an account. Hidden accounts stay in the data but drop
 * out of the sidebar and totals. */
export function setAccountClosed(b: LoadedBudget, accountId: Ulid, closed: boolean): LoadedBudget {
  return { ...b, accounts: replace(b.accounts, accountId, (a) => ({ ...a, closed })) };
}

/** Rename an account. */
export function renameAccount(b: LoadedBudget, accountId: Ulid, name: string): LoadedBudget {
  return { ...b, accounts: replace(b.accounts, accountId, (a) => ({ ...a, name })) };
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

/**
 * Cover `toCategoryId`'s shortfall in `month` from another category, moving at
 * most what the donor actually has available — covering a €50 hole from a €5
 * envelope moves €5, never driving the donor negative. No-op when there is no
 * shortfall or the donor has nothing to spare.
 */
export function coverShortfall(
  b: LoadedBudget,
  month: MonthKey,
  fromCategoryId: Ulid,
  toCategoryId: Ulid,
): LoadedBudget {
  const p = computeProjection(b);
  const shortfall = Math.max(0, -p.availableOf(toCategoryId, month));
  const headroom = Math.max(0, p.availableOf(fromCategoryId, month));
  const amount = Math.min(shortfall, headroom);
  if (amount === 0) return b;
  return moveMoney(b, month, fromCategoryId, toCategoryId, amount as Cents);
}

// ---- Transactions ----------------------------------------------------------

export function addTransaction(b: LoadedBudget, tx: Transaction): LoadedBudget {
  return { ...b, transactions: [...b.transactions, tx] };
}

/** Append many transactions at once. */
export function addTransactions(b: LoadedBudget, txs: readonly Transaction[]): LoadedBudget {
  return { ...b, transactions: [...b.transactions, ...txs] };
}

/** Replace the whole transaction list (e.g. committing a statement merge). */
export function setTransactions(b: LoadedBudget, txs: readonly Transaction[]): LoadedBudget {
  return { ...b, transactions: [...txs] };
}

export function updateTransaction(
  b: LoadedBudget,
  txId: Ulid,
  patch: Partial<Omit<Transaction, "id">>,
): LoadedBudget {
  return { ...b, transactions: replace(b.transactions, txId, (t) => ({ ...t, ...patch })) };
}

/** Both row ids of a transfer pair (or just the id when the row isn't one). */
function pairIds(b: LoadedBudget, txId: Ulid): Ulid[] {
  const t = b.transactions.find((x) => x.id === txId);
  if (!t?.transfer) return [txId];
  const other = b.transactions.find((x) => x.id !== txId && x.transfer?.pairId === t.transfer!.pairId);
  return other ? [txId, other.id] : [txId];
}

/** A transfer's payee is derived, direction-aware text. */
function transferPayee(amount: number, counterName: string): string {
  return amount < 0 ? `Transfer to: ${counterName}` : `Transfer from: ${counterName}`;
}

/**
 * Rewrite every transfer leg's payee to the canonical direction-aware text —
 * imported transfers carry whatever the source export called them. Idempotent
 * and cosmetic only: pairing and import identities are untouched (identity is
 * stored provenance, never re-derived from the payee).
 */
export function normalizeTransferPayees(b: LoadedBudget): { budget: LoadedBudget; changed: number } {
  const nameOf = new Map(b.accounts.map((a) => [a.id, a.name]));
  let changed = 0;
  const transactions = b.transactions.map((t) => {
    if (!t.transfer) return t;
    const want = transferPayee(t.amount, nameOf.get(t.transfer.counterAccountId) ?? "—");
    if (t.payee === want) return t;
    changed++;
    return { ...t, payee: want };
  });
  return changed > 0 ? { budget: { ...b, transactions }, changed } : { budget: b, changed: 0 };
}

/**
 * Link rows that were always two halves of one transfer — the pairs
 * `findTransferCandidates` turns up in imported data — into real transfer pairs.
 *
 * Nothing is merged or deleted: both rows stay exactly where they are, for
 * exactly the amounts they had. The outflow leg KEEPS its category, because
 * that envelope is what funded the transfer and dropping it is precisely the
 * mistake the old cross-budget "stitch" made (it left the sender's envelope
 * unspent and Ready-to-Assign badly negative). The inflow leg's income category
 * goes: money arriving from another budget lands in the cash pool and raises
 * Ready-to-Assign on its own, and income categories are skipped by the engine
 * either way — so every derived number is identical before and after. What
 * changes is the payees, which become the canonical transfer text, and the fact
 * that global analytics now recognise the pair without having to guess.
 *
 * Pairs whose rows have gone missing, or that already belong to a transfer, are
 * skipped rather than treated as an error. So are the two shapes where linking
 * would move money instead of describing it, which is the one thing this must
 * never do: an arriving leg that carries a spending envelope (that's a REFUND —
 * the category is the point of the row), and a leg on a credit card (the engine
 * reads money arriving on a card as a payment against its payment envelope).
 */
export function linkTransfers(
  b: LoadedBudget,
  pairs: readonly { outflowId: Ulid; inflowId: Ulid }[],
): { budget: LoadedBudget; linked: number } {
  const byId = new Map(b.transactions.map((t) => [t.id, t]));
  const nameOf = new Map(b.accounts.map((a) => [a.id, a.name]));
  const isCard = new Set(b.accounts.filter((a) => a.type === "creditCard").map((a) => a.id));
  const incomeGroups = new Set(b.groups.filter((g) => g.kind === "income").map((g) => g.id));
  const incomeCats = new Set(b.categories.filter((c) => incomeGroups.has(c.groupId)).map((c) => c.id));
  const patch = new Map<Ulid, Transaction>();

  for (const { outflowId, inflowId } of pairs) {
    const out = byId.get(outflowId);
    const inn = byId.get(inflowId);
    if (!out || !inn || out.transfer || inn.transfer) continue;
    if (patch.has(out.id) || patch.has(inn.id)) continue;
    if (inn.categoryId && !incomeCats.has(inn.categoryId)) continue; // a refund, not an arrival
    if (isCard.has(out.accountId) || isCard.has(inn.accountId)) continue;
    const pairId = newId();
    patch.set(out.id, {
      ...out,
      payee: transferPayee(out.amount, nameOf.get(inn.accountId) ?? "—"),
      transfer: { counterAccountId: inn.accountId, pairId },
    });
    patch.set(inn.id, {
      ...inn,
      payee: transferPayee(inn.amount, nameOf.get(out.accountId) ?? "—"),
      categoryId: undefined,
      transfer: { counterAccountId: out.accountId, pairId },
    });
  }

  if (patch.size === 0) return { budget: b, linked: 0 };
  return {
    budget: { ...b, transactions: b.transactions.map((t) => patch.get(t.id) ?? t) },
    linked: patch.size / 2,
  };
}

export interface TransferArgs {
  /** The account the user is entering the transfer FROM the perspective of. */
  accountId: Ulid;
  counterAccountId: Ulid;
  date: ISODate;
  /** Signed for `accountId`'s leg: negative = money leaves it. */
  amount: Cents;
  memo: string;
  approved: boolean;
  clearedThis: ClearedStatus;
  clearedCounter: ClearedStatus;
  /**
   * Envelope funding the OUTFLOW leg — for cross-household transfers, where
   * the sender spends from an envelope while the receiver's Ready-to-Assign
   * rises through the cash pool. Same-pool transfers leave this unset.
   */
  categoryId?: Ulid;
}

/** Record money moving between two accounts: both legs, linked by a pair id. */
export function addTransfer(b: LoadedBudget, args: TransferArgs): LoadedBudget {
  const nameOf = (id: Ulid): string => b.accounts.find((a) => a.id === id)?.name ?? "—";
  const pairId = newId();
  const common = { date: args.date, effectiveDate: args.date, memo: args.memo, approved: args.approved };
  const legA: Transaction = {
    id: newId(),
    accountId: args.accountId,
    ...common,
    payee: transferPayee(args.amount, nameOf(args.counterAccountId)),
    amount: args.amount,
    cleared: args.clearedThis,
    ...(args.categoryId && args.amount < 0 ? { categoryId: args.categoryId } : {}),
    transfer: { counterAccountId: args.counterAccountId, pairId },
  };
  const legB: Transaction = {
    id: newId(),
    accountId: args.counterAccountId,
    ...common,
    payee: transferPayee(-args.amount, nameOf(args.accountId)),
    amount: -args.amount as Cents,
    cleared: args.clearedCounter,
    ...(args.categoryId && args.amount > 0 ? { categoryId: args.categoryId } : {}),
    transfer: { counterAccountId: args.accountId, pairId },
  };
  return addTransactions(b, [legA, legB]);
}

/**
 * Edit one leg of a transfer and mirror the change onto the other: date,
 * memo, and amount stay equal-and-opposite, and re-pointing either end keeps
 * the pair consistent. Cleared status stays per-leg (each side settles at its
 * own bank in its own time).
 */
export function updateTransfer(
  b: LoadedBudget,
  txId: Ulid,
  patch: { accountId?: Ulid; counterAccountId?: Ulid; date?: ISODate; amount?: Cents; memo?: string; cleared?: ClearedStatus; categoryId?: Ulid },
): LoadedBudget {
  const t = b.transactions.find((x) => x.id === txId);
  if (!t?.transfer) return b;
  const otherId = pairIds(b, txId).find((id) => id !== txId);
  const nameOf = (id: Ulid): string => b.accounts.find((a) => a.id === id)?.name ?? "—";

  const accountId = patch.accountId ?? t.accountId;
  const counterAccountId = patch.counterAccountId ?? t.transfer.counterAccountId;
  const date = patch.date ?? t.date;
  const amount = patch.amount ?? t.amount;
  const memo = patch.memo ?? t.memo;
  // The funding envelope lives on whichever leg the money LEAVES.
  const other = otherId ? b.transactions.find((x) => x.id === otherId) : undefined;
  const categoryId = "categoryId" in patch ? patch.categoryId : t.categoryId ?? other?.categoryId;

  const transactions = b.transactions.map((x) => {
    if (x.id === txId) {
      return {
        ...x,
        accountId,
        date,
        effectiveDate: x.effectiveDate === x.date ? date : x.effectiveDate,
        amount,
        memo,
        payee: transferPayee(amount, nameOf(counterAccountId)),
        cleared: patch.cleared ?? x.cleared,
        categoryId: amount < 0 ? categoryId : undefined,
        transfer: { ...x.transfer!, counterAccountId },
      };
    }
    if (otherId && x.id === otherId) {
      return {
        ...x,
        accountId: counterAccountId,
        date,
        effectiveDate: x.effectiveDate === x.date ? date : x.effectiveDate,
        amount: -amount as Cents,
        memo,
        payee: transferPayee(-amount, nameOf(accountId)),
        categoryId: -amount < 0 ? categoryId : undefined,
        transfer: { ...x.transfer!, counterAccountId: accountId },
      };
    }
    return x;
  });
  return { ...b, transactions };
}

/** Deleting one leg of a transfer removes both — a lone leg is a lie. */
export function deleteTransaction(b: LoadedBudget, txId: Ulid): LoadedBudget {
  const ids = new Set(pairIds(b, txId));
  return { ...b, transactions: b.transactions.filter((t) => !ids.has(t.id)) };
}

/**
 * The next occurrence of a repeating transaction: a fresh scheduled entry one
 * period later. Identity, provenance, and transfer pairing belong to the
 * original row only, so none of them carry over; split lines get new ids.
 */
export function scheduledSuccessor(t: Transaction): Transaction | null {
  if (!t.recurrence) return null;
  const date = nextOccurrence(t.date, t.recurrence.freq, t.recurrence.anchorDay);
  const { id: _id, source: _source, transfer: _transfer, ...rest } = t;
  return {
    ...rest,
    id: newId(),
    date,
    effectiveDate: date,
    approved: false,
    cleared: "uncleared",
    ...(t.splits ? { splits: t.splits.map((s) => ({ ...s, id: newId() })) } : {}),
  };
}

export function approveTransaction(b: LoadedBudget, txId: Ulid): LoadedBudget {
  return approveTransactions(b, [txId]);
}

/**
 * Approve many scheduled transactions in one pass (one recompute, not N).
 * An approved row enters the register as `uncleared` — it's now real and
 * counted, but not yet settled (paid at the bank / on a paid card bill); the
 * user clears it when it settles. Approving a repeating one also enters its
 * next occurrence into the schedule.
 */
export function approveTransactions(b: LoadedBudget, txIds: readonly Ulid[]): LoadedBudget {
  // A transfer pair approves as one: a half-approved pair would unbalance accounts.
  const ids = new Set(txIds.flatMap((id) => pairIds(b, id)));
  const successors: Transaction[] = [];
  const transactions = b.transactions.map((t) => {
    if (!ids.has(t.id) || t.approved) return t;
    const next = scheduledSuccessor(t);
    if (next) successors.push(next);
    return { ...t, approved: true, cleared: "uncleared" as const };
  });
  return { ...b, transactions: successors.length > 0 ? [...transactions, ...successors] : transactions };
}

/** Rename every occurrence of a payee across the budget (exact match). */
export function renamePayee(b: LoadedBudget, from: string, to: string): LoadedBudget {
  const next = to.trim();
  if (!next || next === from) return b;
  return { ...b, transactions: b.transactions.map((t) => (t.payee === from ? { ...t, payee: next } : t)) };
}

/** Set the cleared status on many transactions in one pass. */
export function setClearedStatus(b: LoadedBudget, txIds: readonly Ulid[], cleared: ClearedStatus): LoadedBudget {
  const ids = new Set(txIds);
  return {
    ...b,
    transactions: b.transactions.map((t) => (ids.has(t.id) && t.cleared !== cleared ? { ...t, cleared } : t)),
  };
}

/** Delete many transactions in one pass; transfer pairs go together. */
export function deleteTransactions(b: LoadedBudget, txIds: readonly Ulid[]): LoadedBudget {
  const ids = new Set(txIds.flatMap((id) => pairIds(b, id)));
  return { ...b, transactions: b.transactions.filter((t) => !ids.has(t.id)) };
}

/**
 * Record a statement reconciliation: the bank confirmed these rows, so they
 * become `reconciled`, and the account remembers the latest confirmed date
 * (never moving it backwards — an older statement re-run must not regress it).
 */
export function reconcileAccount(
  b: LoadedBudget,
  accountId: Ulid,
  txIds: readonly Ulid[],
  through: ISODate,
): LoadedBudget {
  const ids = new Set(txIds);
  return {
    ...b,
    accounts: b.accounts.map((a) =>
      a.id === accountId && (!a.reconciledThrough || a.reconciledThrough < through)
        ? { ...a, reconciledThrough: through }
        : a,
    ),
    transactions: b.transactions.map((t) =>
      ids.has(t.id) && t.cleared !== "reconciled" ? { ...t, cleared: "reconciled" } : t,
    ),
  };
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
