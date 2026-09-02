import { newId, type Ulid } from "./ids.js";
import { technicalKey } from "./import/payee.js";
import type { Cents } from "./money.js";
import { nextOccurrence, type ISODate, type MonthKey } from "./time.js";
import { computeProjection } from "./engine/compute.js";
import type {
  Account,
  AccountType,
  Payee,
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
  /** Present => the transfer repeats; both legs carry it, so either can spawn. */
  recurrence?: Transaction["recurrence"];
}

/**
 * Turn one existing plain transaction into a transfer leg to `counterAccountId`.
 *
 * If that account already holds the matching row — equal and opposite amount
 * within a few days, not itself a transfer, and not an arriving leg that
 * carries a spending envelope (that's a refund; the category is the point of
 * the row) — the two are LINKED and nothing is created: a leg that arrived by
 * statement import is simply recognised for what it always was. Otherwise the
 * missing leg is MINTED as uncleared, to be confirmed when that account's own
 * statement turns up and matches it.
 *
 * Unlike findTransferCandidates/linkTransfers this is not a guess — the user
 * named the counter account — so it works within one budget scope and with
 * credit cards. The card case is the whole point: invoice deduction only
 * recognises payments that are transfer legs into the card, so a card payment
 * imported as a categorised row can never settle its billing window.
 */
const COUNTERPART_MAX_DAYS = 10;

/**
 * The row `tx` would pair with in `counterAccountId`, if it already exists:
 * equal and opposite amount within a few days, not itself a transfer or a
 * split, and not an arriving leg that carries a spending envelope (a refund).
 * Nearest date wins, deterministically. Exposed so the import wizard can say
 * up front whether marking a row as a transfer will LINK or MINT.
 */
export function findTransferCounterpart(
  b: LoadedBudget,
  tx: { id?: Ulid; accountId: Ulid; date: ISODate; amount: Cents },
  counterAccountId: Ulid,
): Transaction | undefined {
  const incomeGroups = new Set(b.groups.filter((g) => g.kind === "income").map((g) => g.id));
  const incomeCats = new Set(b.categories.filter((c) => incomeGroups.has(c.groupId)).map((c) => c.id));
  const day = (iso: ISODate): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);
  return b.transactions
    .filter(
      (t) =>
        t.id !== tx.id &&
        t.accountId === counterAccountId &&
        !t.transfer &&
        !t.splits &&
        t.amount === -tx.amount &&
        Math.abs(day(t.date) - day(tx.date)) <= COUNTERPART_MAX_DAYS &&
        !(t.amount > 0 && t.categoryId && !incomeCats.has(t.categoryId)),
    )
    .sort((x, y) => {
      const gx = Math.abs(day(x.date) - day(tx.date));
      const gy = Math.abs(day(y.date) - day(tx.date));
      return gx !== gy ? gx - gy : x.id < y.id ? -1 : 1;
    })[0];
}

export function convertToTransfer(
  b: LoadedBudget,
  txId: Ulid,
  counterAccountId: Ulid,
): { budget: LoadedBudget; counterpart: "linked" | "minted" | "unchanged" } {
  const tx = b.transactions.find((t) => t.id === txId);
  const counterName = b.accounts.find((a) => a.id === counterAccountId)?.name;
  if (!tx || tx.transfer || tx.accountId === counterAccountId || !counterName) {
    return { budget: b, counterpart: "unchanged" };
  }
  const thisName = b.accounts.find((a) => a.id === tx.accountId)?.name ?? "—";
  const pairId = newId();
  // The arriving leg's income category (if any) dissolves into the link; the
  // outflow leg keeps its envelope — same rules as linkTransfers.
  const asLeg = (t: Transaction, counter: Ulid, otherName: string): Transaction => ({
    ...t,
    payee: transferPayee(t.amount, otherName),
    ...(t.amount > 0 ? { categoryId: undefined } : {}),
    transfer: { counterAccountId: counter, pairId },
  });

  const existing = findTransferCounterpart(b, tx, counterAccountId);
  const patched = new Map<Ulid, Transaction>();
  patched.set(tx.id, asLeg(tx, counterAccountId, counterName));
  if (existing) {
    patched.set(existing.id, asLeg(existing, tx.accountId, thisName));
    return {
      budget: { ...b, transactions: b.transactions.map((t) => patched.get(t.id) ?? t) },
      counterpart: "linked",
    };
  }
  const minted: Transaction = {
    id: newId(),
    accountId: counterAccountId,
    date: tx.date,
    effectiveDate: tx.date,
    payee: transferPayee(-tx.amount, thisName),
    memo: tx.memo,
    amount: -tx.amount as Cents,
    cleared: "uncleared",
    approved: tx.approved,
    transfer: { counterAccountId: tx.accountId, pairId },
  };
  return {
    budget: { ...b, transactions: [...b.transactions.map((t) => patched.get(t.id) ?? t), minted] },
    counterpart: "minted",
  };
}

/**
 * Remember that this statement string, on this account, means a transfer to
 * `counterAccountId` — so next month's row arrives already marked. One entry
 * per (account, key); marking again with a different target replaces it.
 */
export function rememberTransferAlias(b: LoadedBudget, key: string, accountId: Ulid, counterAccountId: Ulid): LoadedBudget {
  if (!key.trim() || accountId === counterAccountId) return b;
  const rest = (b.transferAliases ?? []).filter((a) => !(a.accountId === accountId && a.key === key));
  return { ...b, transferAliases: [...rest, { key, accountId, counterAccountId }] };
}

/** Forget a learned transfer meaning — the user filed the row as something else. */
export function removeTransferAlias(b: LoadedBudget, key: string, accountId: Ulid): LoadedBudget {
  const rest = (b.transferAliases ?? []).filter((a) => !(a.accountId === accountId && a.key === key));
  return rest.length === (b.transferAliases ?? []).length ? b : { ...b, transferAliases: rest };
}

/**
 * Should an incoming statement row be proposed as a transfer before the user
 * says anything? Two sources, strongest first:
 *  - a remembered transfer alias for this row's text on this account;
 *  - the card-payment shape: money arriving on a credit card whose equal and
 *    opposite twin already sits in exactly ONE other account. Twins in two
 *    accounts propose nothing — a proposal must never guess.
 */
export function proposeImportTransfer(
  b: LoadedBudget,
  row: { key: string; accountId: Ulid; date: ISODate; amount: Cents },
): Ulid | undefined {
  const learned = row.key
    ? (b.transferAliases ?? []).find((a) => a.accountId === row.accountId && a.key === row.key)
    : undefined;
  if (learned && b.accounts.some((a) => a.id === learned.counterAccountId)) return learned.counterAccountId;
  const acct = b.accounts.find((a) => a.id === row.accountId);
  if (acct?.type !== "creditCard" || row.amount <= 0) return undefined;
  const hits = b.accounts.filter(
    (a) => a.id !== row.accountId && !!findTransferCounterpart(b, { accountId: row.accountId, date: row.date, amount: row.amount }, a.id),
  );
  return hits.length === 1 ? hits[0]!.id : undefined;
}

/** Record money moving between two accounts: both legs, linked by a pair id. */
export function addTransfer(b: LoadedBudget, args: TransferArgs): LoadedBudget {
  const nameOf = (id: Ulid): string => b.accounts.find((a) => a.id === id)?.name ?? "—";
  const pairId = newId();
  const common = {
    date: args.date,
    effectiveDate: args.date,
    memo: args.memo,
    approved: args.approved,
    ...(args.recurrence ? { recurrence: args.recurrence } : {}),
  };
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
  // Entered as already-happened and repeating? Then the next occurrence belongs
  // in the schedule now — the same courtesy a plain repeating row gets, except
  // both legs have to land together, linked to each other.
  if (args.approved && args.recurrence) {
    const nextPairId = newId();
    const next = [legA, legB]
      .map((leg) => scheduledSuccessor(leg, { pairId: nextPairId }))
      .filter((t): t is Transaction => t !== null);
    return addTransactions(b, [legA, legB, ...next]);
  }
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
  patch: { accountId?: Ulid; counterAccountId?: Ulid; date?: ISODate; amount?: Cents; memo?: string; cleared?: ClearedStatus; categoryId?: Ulid; recurrence?: Transaction["recurrence"] },
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
  // A cadence belongs to the pair, not to a leg, so it is mirrored like the date.
  const recurrence = "recurrence" in patch ? patch.recurrence : t.recurrence;
  const cadence = recurrence ? { recurrence } : { recurrence: undefined };

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
        ...cadence,
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
        ...cadence,
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
 * period later. Identity and provenance belong to the original row only, so
 * neither carries over; split lines get new ids.
 *
 * A transfer is two rows, and a successor that kept the original's pair id
 * would join the pair it came from rather than start a new one. So the link is
 * dropped unless the caller supplies a fresh `pairId` — which
 * `approveTransactions` does, once per pair, so both legs land linked to each
 * other and to nothing else.
 */
export function scheduledSuccessor(t: Transaction, opts: { pairId?: Ulid } = {}): Transaction | null {
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
    ...(opts.pairId && t.transfer
      ? { transfer: { counterAccountId: t.transfer.counterAccountId, pairId: opts.pairId } }
      : {}),
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

  // Both legs of a repeating transfer spawn, and they must spawn INTO each
  // other: one fresh pair id per pair being approved. A pair with only one leg
  // in hand (a half-linked row from an import) gets no link rather than a
  // successor pointing at nothing.
  const legsPerPair = new Map<Ulid, number>();
  for (const t of b.transactions) {
    if (!ids.has(t.id) || t.approved || !t.transfer) continue;
    legsPerPair.set(t.transfer.pairId, (legsPerPair.get(t.transfer.pairId) ?? 0) + 1);
  }
  const successorPairIds = new Map<Ulid, Ulid>();
  for (const [pairId, legs] of legsPerPair) if (legs === 2) successorPairIds.set(pairId, newId());

  const successors: Transaction[] = [];
  const transactions = b.transactions.map((t) => {
    if (!ids.has(t.id) || t.approved) return t;
    const pairId = t.transfer ? successorPairIds.get(t.transfer.pairId) : undefined;
    const next = scheduledSuccessor(t, { ...(pairId ? { pairId } : {}) });
    if (next) successors.push(next);
    return { ...t, approved: true, cleared: "uncleared" as const };
  });
  return { ...b, transactions: successors.length > 0 ? [...transactions, ...successors] : transactions };
}

// ---- Payees ----------------------------------------------------------------
// Transactions carry payee TEXT; the master list carries identity, so the
// aliases that map a bank's "AS Northwind Bank" onto your "Northwind" survive you renaming
// it again tomorrow. Keeping the two in step is this section's whole job.

const payeeKey = (name: string): string => name.normalize("NFC").trim().toLowerCase();

/**
 * Mint a master-list entry for every payee spelling the transactions use.
 * Idempotent — running it on every load is the point, so a payee typed straight
 * into the register turns up in the list without ceremony. Transfer legs are
 * skipped: their payee is derived text, not a name anyone chose.
 */
export function syncPayees(b: LoadedBudget): { budget: LoadedBudget; added: number } {
  const known = new Set((b.payees ?? []).map((p) => payeeKey(p.name)));
  const minted: Payee[] = [];
  for (const t of b.transactions) {
    if (t.transfer) continue;
    const name = t.payee.trim();
    const key = payeeKey(name);
    if (!name || known.has(key)) continue;
    known.add(key);
    minted.push({ id: newId(), name, aliases: [] });
  }
  if (minted.length === 0) return { budget: b, added: 0 };
  return { budget: { ...b, payees: [...(b.payees ?? []), ...minted] }, added: minted.length };
}

/**
 * Rename every occurrence of a payee, and the master-list entry with it.
 *
 * Renaming onto a name already in use MERGES the two — that is the documented
 * behaviour of the payees screen — so the surviving entry keeps both sets of
 * aliases. Anything a bank called either one still lands on the survivor.
 *
 * The rename itself is also worth learning: the OLD spelling demonstrably meant
 * this payee, so its (noise-stripped) key becomes an alias on the survivor.
 * That is what makes "commit the import quickly, tidy the names afterwards" a
 * workflow that teaches — the next statement's identical string lands renamed
 * without the wizard ever asking again.
 */
export function renamePayee(b: LoadedBudget, from: string, to: string): LoadedBudget {
  const next = to.trim();
  if (!next || next === from) return b;
  const transactions = b.transactions.map((t) => (t.payee === from ? { ...t, payee: next } : t));

  const payees = b.payees ?? [];
  const source = payees.find((p) => payeeKey(p.name) === payeeKey(from));
  const target = payees.find((p) => payeeKey(p.name) === payeeKey(next) && p !== source);
  let nextPayees: Payee[];
  let survivorId: Ulid | undefined;
  if (source && target) {
    const aliases = [...new Set([...target.aliases, ...source.aliases])];
    nextPayees = payees.filter((p) => p !== source).map((p) => (p === target ? { ...p, aliases } : p));
    survivorId = target.id;
  } else if (source) {
    nextPayees = payees.map((p) => (p === source ? { ...p, name: next } : p));
    survivorId = source.id;
  } else if (target) {
    nextPayees = payees;
    survivorId = target.id;
  } else {
    const minted: Payee = { id: newId(), name: next, aliases: [] };
    nextPayees = [...payees, minted];
    survivorId = minted.id;
  }

  const renamed: LoadedBudget = { ...b, transactions, payees: nextPayees };
  const oldKey = technicalKey({ payee: from, memo: "" });
  // A case-only or whitespace rename teaches nothing; anything else does.
  if (oldKey && oldKey !== payeeKey(next)) return addPayeeAlias(renamed, survivorId, from);
  return renamed;
}

/**
 * Record that a technical string means this payee. A key belongs to exactly one
 * payee, so it is taken off any other entry — otherwise the winner would depend
 * on list order.
 *
 * The alias is normalized here, at the single point of entry: whatever arrives
 * (a raw bank string with a per-transaction id, a manual paste in the payees
 * screen) is reduced to its stable stem, so every stored alias is one that can
 * actually recur.
 */
export function addPayeeAlias(b: LoadedBudget, payeeId: Ulid, alias: string): LoadedBudget {
  const key = technicalKey({ payee: alias, memo: "" });
  if (!key) return b;
  const payees = (b.payees ?? []).map((p) => {
    if (p.id === payeeId) return p.aliases.includes(key) ? p : { ...p, aliases: [...p.aliases, key] };
    return p.aliases.includes(key) ? { ...p, aliases: p.aliases.filter((a) => a !== key) } : p;
  });
  return { ...b, payees };
}

export function removePayeeAlias(b: LoadedBudget, payeeId: Ulid, alias: string): LoadedBudget {
  const key = payeeKey(alias);
  return {
    ...b,
    payees: (b.payees ?? []).map((p) => (p.id === payeeId ? { ...p, aliases: p.aliases.filter((a) => a !== key) } : p)),
  };
}

/** Drop a master-list entry. Transactions keep their text; nothing is renamed. */
export function deletePayee(b: LoadedBudget, payeeId: Ulid): LoadedBudget {
  return { ...b, payees: (b.payees ?? []).filter((p) => p.id !== payeeId) };
}

/**
 * Record "call this technical string that name" in one step — minting the payee
 * if it is new. This is what the import wizard calls when you correct a row.
 */
export function rememberPayeeAlias(b: LoadedBudget, name: string, alias: string): LoadedBudget {
  const trimmed = name.trim();
  if (!trimmed || !alias.trim()) return b;
  const { budget, payee } = ensurePayee(b, trimmed);
  return addPayeeAlias(budget, payee.id, alias);
}

/** The master-list entry for a name, minting one if this is its first sighting. */
export function ensurePayee(b: LoadedBudget, name: string): { budget: LoadedBudget; payee: Payee } {
  const trimmed = name.trim();
  const existing = (b.payees ?? []).find((p) => payeeKey(p.name) === payeeKey(trimmed));
  if (existing) return { budget: b, payee: existing };
  const payee: Payee = { id: newId(), name: trimmed, aliases: [] };
  return { budget: { ...b, payees: [...(b.payees ?? []), payee] }, payee };
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
