import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Alert, Center, Loader, Stack, Text } from "@mantine/core";
import {
  BudgetRepository,
  computeProjection,
  newId,
  ops,
  type AccountType,
  type Cents,
  type CurrencyConfig,
  type LoadedBudget,
  type MonthKey,
  type Projection,
  type SavedFormat,
  type SplitLine,
  type Transaction,
  type Ulid,
} from "@cash-money/core";
import { demoBudget } from "./demo";
import { isTauri, TauriFileSystem } from "./platform/tauriFs";
import { newEmptyBudget } from "./platform/newBudget";

export type View =
  | { kind: "plan" }
  | { kind: "analytics" }
  | { kind: "all-accounts" }
  | { kind: "account"; accountId: Ulid };

type Action = { type: "set"; budget: LoadedBudget } | { type: "apply"; fn: (b: LoadedBudget) => LoadedBudget };

function reducer(state: LoadedBudget | null, action: Action): LoadedBudget | null {
  if (action.type === "set") return action.budget;
  if (action.type === "apply") return state ? action.fn(state) : state;
  return state;
}

async function saveWholeBudget(repo: BudgetRepository, b: LoadedBudget): Promise<void> {
  await repo.saveBudgetMeta(b.budget);
  await repo.saveAccounts(b.budget.id, b.accounts);
  await repo.saveCategories(b.budget.id, b.groups, b.categories);
  await repo.saveAssignments(b.budget.id, b.assignments);
  await repo.writeAllTransactions(b.budget.id, b.transactions);
  await repo.registerBudget({ id: b.budget.id, name: b.budget.name });
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
  persistent: boolean;
  accountName: (id: Ulid) => string;
  categoryName: (id: Ulid | undefined) => string;

  replaceBudget: (b: LoadedBudget) => void;
  addAccount: (args: { name: string; type: AccountType; onBudget?: boolean; household?: string }) => void;
  setAccountOrder: (orderedIds: Ulid[]) => void;
  setAccountClosed: (id: Ulid, closed: boolean) => void;
  renameAccount: (id: Ulid, name: string) => void;
  reorderCategory: (categoryId: Ulid, toGroupId: Ulid, targetIndex: number) => void;
  setCategoryOrder: (groupId: Ulid, orderedIds: Ulid[]) => void;
  setGroupOrder: (orderedGroupIds: Ulid[]) => void;
  setHouseholdOrder: (orderedHouseholds: string[]) => void;
  addGroup: (name: string, household?: string) => void;
  renameGroup: (id: Ulid, name: string) => void;
  setGroupHidden: (id: Ulid, hidden: boolean) => void;
  deleteGroup: (id: Ulid) => void;
  addCategory: (groupId: Ulid, name: string) => void;
  renameCategory: (id: Ulid, name: string) => void;
  moveCategory: (id: Ulid, toGroupId: Ulid) => void;
  setCategoryHidden: (id: Ulid, hidden: boolean) => void;
  deleteCategory: (id: Ulid) => void;
  setAssigned: (month: MonthKey, categoryId: Ulid, amount: Cents) => void;
  moveMoney: (month: MonthKey, from: Ulid, to: Ulid, amount: Cents) => void;
  coverShortfall: (month: MonthKey, from: Ulid, to: Ulid) => void;
  getAssigned: (month: MonthKey, categoryId: Ulid) => Cents;
  addTransaction: (tx: Transaction) => void;
  addTransactions: (txs: Transaction[]) => void;
  setTransactions: (txs: Transaction[]) => void;
  updateTransaction: (id: Ulid, patch: Partial<Omit<Transaction, "id">>) => void;
  deleteTransaction: (id: Ulid) => void;
  approveTransaction: (id: Ulid) => void;
  approveTransactions: (ids: Ulid[]) => void;
  setSplits: (id: Ulid, splits: SplitLine[] | undefined, categoryIdWhenUnsplit?: Ulid) => void;

  /** User-saved register formats (empty / no-op in the browser preview). */
  loadFormats: () => Promise<SavedFormat[]>;
  saveFormats: (formats: SavedFormat[]) => Promise<void>;
  /**
   * The stable statement sourceKey for an account — minted once, persisted,
   * and reused so re-imported statements identity-match earlier ones.
   */
  statementSourceKey: (accountId: Ulid, formatId: string) => Promise<string>;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [budget, dispatch] = useReducer(reducer, null);
  const repoRef = useRef<BudgetRepository | null>(null);
  const hydratedRef = useRef(false);
  const [month, setMonth] = useState<MonthKey>("");
  const [view, setView] = useState<View>({ kind: "plan" });
  const [loadError, setLoadError] = useState<string | null>(null);

  // Save lifecycle. Saves are many sequential file writes, so they must never
  // overlap (interleaved writes could leave disk with a mix of two snapshots).
  // The latest unsaved budget sits in pendingRef; every actual save is chained
  // onto saveChainRef so at most one runs at a time, always the newest snapshot.
  const pendingRef = useRef<LoadedBudget | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPending = useCallback((): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const repo = repoRef.current;
    const snapshot = pendingRef.current;
    pendingRef.current = null;
    if (repo && snapshot) {
      saveChainRef.current = saveChainRef.current
        .then(() => saveWholeBudget(repo, snapshot))
        .catch((e) => console.error("Failed to save budget:", e));
    }
    return saveChainRef.current;
  }, []);

  // Bootstrap: load from disk in Tauri, else use demo data in a plain browser.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isTauri()) {
        const repo = new BudgetRepository(new TauriFileSystem());
        repoRef.current = repo;
        try {
          const app = await repo.loadApp();
          let loaded: LoadedBudget;
          if (app.activeBudgetId) {
            loaded = await repo.loadBudget(app.activeBudgetId);
          } else {
            loaded = newEmptyBudget();
            await saveWholeBudget(repo, loaded);
          }
          if (!cancelled) dispatch({ type: "set", budget: loaded });
        } catch (e) {
          // Never fall back to a fresh empty budget here: the first edit would
          // register it as active and the real data — still on disk — would be
          // orphaned. Surface the problem instead.
          console.error("Failed to load budget:", e);
          if (!cancelled) setLoadError(String(e));
        }
      } else if (!cancelled) {
        dispatch({ type: "set", budget: demoBudget() });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist changes (debounced, serialized). Skips the initial hydration.
  useEffect(() => {
    if (!budget || !repoRef.current) return;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    pendingRef.current = budget;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flushPending(), 500);
  }, [budget, flushPending]);

  // Never lose the debounce window's edits: flush before the window closes,
  // and opportunistically when it goes to the background.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlisten = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        await flushPending();
        await win.destroy();
      });
    })();
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flushPending();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      unlisten?.();
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, [flushPending]);

  const projection = useMemo(() => (budget ? computeProjection(budget) : null), [budget]);
  const accById = useMemo(() => new Map((budget?.accounts ?? []).map((a) => [a.id, a.name])), [budget]);
  const catById = useMemo(() => new Map((budget?.categories ?? []).map((c) => [c.id, c.name])), [budget]);

  if (loadError) {
    return (
      <Center h="100vh" p="xl">
        <Alert color="red" title="Couldn't read your budget" maw={560}>
          <Text size="sm">
            Your data is still on disk, but it couldn't be loaded, so editing is disabled to
            avoid overwriting anything. Fix the cause (or restore the data folder from a backup)
            and reopen the app.
          </Text>
          <Text size="xs" c="dimmed" mt="sm" style={{ fontFamily: "monospace" }}>
            {loadError}
          </Text>
        </Alert>
      </Center>
    );
  }

  if (!budget || !projection) {
    return (
      <Center h="100vh">
        <Stack align="center" gap="xs">
          <Loader />
          <Text size="sm" c="dimmed">
            Loading your budget…
          </Text>
        </Stack>
      </Center>
    );
  }

  const apply = (fn: (b: LoadedBudget) => LoadedBudget) => dispatch({ type: "apply", fn });
  const months = projection.months;
  const activeMonth = months.includes(month) ? month : months[months.length - 1] ?? month;

  const value: AppState = {
    budget,
    projection,
    currency: budget.budget.currency,
    months,
    month: activeMonth,
    setMonth,
    view,
    setView,
    persistent: repoRef.current !== null,
    accountName: (id) => accById.get(id) ?? "—",
    categoryName: (id) => (id ? catById.get(id) ?? "—" : ""),

    replaceBudget: (b) => dispatch({ type: "set", budget: b }),
    addAccount: (args) => apply((b) => ops.addAccount(b, args)),
    setAccountOrder: (orderedIds) => apply((b) => ops.setAccountOrder(b, orderedIds)),
    setAccountClosed: (id, closed) => apply((b) => ops.setAccountClosed(b, id, closed)),
    renameAccount: (id, name) => apply((b) => ops.renameAccount(b, id, name)),
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
    coverShortfall: (m, from, to) => apply((b) => ops.coverShortfall(b, m, from, to)),
    getAssigned: (m, categoryId) => ops.getAssigned(budget, m, categoryId),
    addTransaction: (tx) => apply((b) => ops.addTransaction(b, tx)),
    addTransactions: (txs) => apply((b) => ops.addTransactions(b, txs)),
    setTransactions: (txs) => apply((b) => ops.setTransactions(b, txs)),
    updateTransaction: (id, patch) => apply((b) => ops.updateTransaction(b, id, patch)),
    deleteTransaction: (id) => apply((b) => ops.deleteTransaction(b, id)),
    approveTransaction: (id) => apply((b) => ops.approveTransaction(b, id)),
    approveTransactions: (ids) => apply((b) => ops.approveTransactions(b, ids)),
    setSplits: (id, splits, categoryIdWhenUnsplit) => apply((b) => ops.setSplits(b, id, splits, categoryIdWhenUnsplit)),

    loadFormats: () => repoRef.current?.loadFormats() ?? Promise.resolve([]),
    saveFormats: (formats) => repoRef.current?.saveFormats(formats) ?? Promise.resolve(),
    statementSourceKey: async (accountId, formatId) => {
      const repo = repoRef.current;
      // Browser preview: deterministic per-account key, nothing persisted.
      if (!repo) return `stmt:${accountId}`;
      const budgetId = budget.budget.id;
      const entries = await repo.loadImportSources(budgetId);
      const existing = entries.find((e) => e.accountId === accountId);
      if (existing) return existing.sourceKey;
      const sourceKey = newId();
      await repo.saveImportSources(budgetId, [...entries, { accountId, formatId, sourceKey }]);
      return sourceKey;
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used within AppProvider");
  return v;
}
