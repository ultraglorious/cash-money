import { createContext, useContext, useMemo, useReducer, useState, type ReactNode } from "react";
import {
  computeProjection,
  ops,
  type AccountType,
  type Cents,
  type CurrencyConfig,
  type LoadedBudget,
  type MonthKey,
  type Projection,
  type SplitLine,
  type Transaction,
  type Ulid,
} from "@cash-money/core";
import { demoBudget } from "./demo";

export type View =
  | { kind: "plan" }
  | { kind: "analytics" }
  | { kind: "all-accounts" }
  | { kind: "account"; accountId: Ulid };

type Action = { apply: (b: LoadedBudget) => LoadedBudget };

function reducer(state: LoadedBudget, action: Action): LoadedBudget {
  return action.apply(state);
}

interface AppState {
  budget: LoadedBudget;
  projection: Projection;
  currency: CurrencyConfig;
  months: MonthKey[];
  month: MonthKey;
  setMonth: (m: MonthKey) => void;
  view: View;
  setView: (v: View) => void;
  accountName: (id: Ulid) => string;
  categoryName: (id: Ulid | undefined) => string;

  // account ops
  addAccount: (args: { name: string; type: AccountType; onBudget?: boolean; household?: string }) => void;
  setAccountOrder: (orderedIds: Ulid[]) => void;
  // ordering
  reorderCategory: (categoryId: Ulid, toGroupId: Ulid, targetIndex: number) => void;
  setCategoryOrder: (groupId: Ulid, orderedIds: Ulid[]) => void;
  setGroupOrder: (orderedGroupIds: Ulid[]) => void;
  setHouseholdOrder: (orderedHouseholds: string[]) => void;
  // section ops
  addGroup: (name: string, household?: string) => void;
  renameGroup: (id: Ulid, name: string) => void;
  setGroupHidden: (id: Ulid, hidden: boolean) => void;
  deleteGroup: (id: Ulid) => void;
  // category ops
  addCategory: (groupId: Ulid, name: string) => void;
  renameCategory: (id: Ulid, name: string) => void;
  moveCategory: (id: Ulid, toGroupId: Ulid) => void;
  setCategoryHidden: (id: Ulid, hidden: boolean) => void;
  deleteCategory: (id: Ulid) => void;
  // assignment ops
  setAssigned: (month: MonthKey, categoryId: Ulid, amount: Cents) => void;
  moveMoney: (month: MonthKey, from: Ulid, to: Ulid, amount: Cents) => void;
  getAssigned: (month: MonthKey, categoryId: Ulid) => Cents;
  // transaction ops
  addTransaction: (tx: Transaction) => void;
  updateTransaction: (id: Ulid, patch: Partial<Omit<Transaction, "id">>) => void;
  deleteTransaction: (id: Ulid) => void;
  approveTransaction: (id: Ulid) => void;
  setSplits: (id: Ulid, splits: SplitLine[] | undefined, categoryIdWhenUnsplit?: Ulid) => void;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [budget, dispatch] = useReducer(reducer, undefined, () => demoBudget());
  const apply = (fn: (b: LoadedBudget) => LoadedBudget) => dispatch({ apply: fn });

  const projection = useMemo(() => computeProjection(budget), [budget]);
  const months = projection.months;
  const [month, setMonth] = useState<MonthKey>(() => months[months.length - 1] ?? "2026-01");
  const [view, setView] = useState<View>({ kind: "plan" });

  const accById = useMemo(() => new Map(budget.accounts.map((a) => [a.id, a.name])), [budget]);
  const catById = useMemo(() => new Map(budget.categories.map((c) => [c.id, c.name])), [budget]);

  const value: AppState = {
    budget,
    projection,
    currency: budget.budget.currency,
    months,
    month: months.includes(month) ? month : months[months.length - 1] ?? month,
    setMonth,
    view,
    setView,
    accountName: (id) => accById.get(id) ?? "—",
    categoryName: (id) => (id ? catById.get(id) ?? "—" : ""),

    addAccount: (args) => apply((b) => ops.addAccount(b, args)),
    setAccountOrder: (orderedIds) => apply((b) => ops.setAccountOrder(b, orderedIds)),
    reorderCategory: (categoryId, toGroupId, targetIndex) => apply((b) => ops.reorderCategory(b, categoryId, toGroupId, targetIndex)),
    setCategoryOrder: (groupId, orderedIds) => apply((b) => ops.setCategoryOrder(b, groupId, orderedIds)),
    setGroupOrder: (orderedGroupIds) => apply((b) => ops.setGroupOrder(b, orderedGroupIds)),
    setHouseholdOrder: (orderedHouseholds) => apply((b) => ops.setHouseholdOrder(b, orderedHouseholds)),
    addGroup: (name, household) => apply((b) => ops.addGroup(b, { name, household })),
    renameGroup: (id, name) => apply((b) => ops.renameGroup(b, id, name)),
    setGroupHidden: (id, hidden) => apply((b) => ops.setGroupHidden(b, id, hidden)),
    deleteGroup: (id) => apply((b) => ops.deleteGroup(b, id)),

    addCategory: (groupId, name) => apply((b) => ops.addCategory(b, { groupId, name })),
    renameCategory: (id, name) => apply((b) => ops.renameCategory(b, id, name)),
    moveCategory: (id, toGroupId) => apply((b) => ops.moveCategory(b, id, toGroupId)),
    setCategoryHidden: (id, hidden) => apply((b) => ops.setCategoryHidden(b, id, hidden)),
    deleteCategory: (id) => apply((b) => ops.deleteCategory(b, id)),

    setAssigned: (m, categoryId, amount) => apply((b) => ops.setAssigned(b, m, categoryId, amount)),
    moveMoney: (m, from, to, amount) => apply((b) => ops.moveMoney(b, m, from, to, amount)),
    getAssigned: (m, categoryId) => ops.getAssigned(budget, m, categoryId),

    addTransaction: (tx) => apply((b) => ops.addTransaction(b, tx)),
    updateTransaction: (id, patch) => apply((b) => ops.updateTransaction(b, id, patch)),
    deleteTransaction: (id) => apply((b) => ops.deleteTransaction(b, id)),
    approveTransaction: (id) => apply((b) => ops.approveTransaction(b, id)),
    setSplits: (id, splits, categoryIdWhenUnsplit) =>
      apply((b) => ops.setSplits(b, id, splits, categoryIdWhenUnsplit)),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used within AppProvider");
  return v;
}
