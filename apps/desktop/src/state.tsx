import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Alert, Center, Loader, Stack, Text } from "@mantine/core";
import {
  BudgetRepository,
  computeProjection,
  monthKeyOf,
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

/**
 * Which on-disk slices the edits since the last save touched. Every action
 * marks what it changed, so a save writes only those files — a category rename
 * no longer rewrites years of transaction shards. `txAll` covers edits whose
 * reach isn't known per-month (imports, cascade deletes).
 */
interface DirtySlices {
  meta: boolean;
  accounts: boolean;
  categories: boolean;
  assignments: boolean;
  txMonths: Set<MonthKey>;
  txAll: boolean;
}
const cleanSlices = (): DirtySlices => ({
  meta: false,
  accounts: false,
  categories: false,
  assignments: false,
  txMonths: new Set(),
  txAll: false,
});
const isClean = (d: DirtySlices): boolean =>
  !d.meta && !d.accounts && !d.categories && !d.assignments && !d.txAll && d.txMonths.size === 0;

async function saveDirty(repo: BudgetRepository, b: LoadedBudget, dirty: DirtySlices): Promise<void> {
  // Safety net: an unmarked edit must never be dropped — write everything.
  if (isClean(dirty)) return saveWholeBudget(repo, b);
  if (dirty.meta) {
    await repo.saveBudgetMeta(b.budget);
    await repo.registerBudget({ id: b.budget.id, name: b.budget.name });
  }
  if (dirty.accounts) await repo.saveAccounts(b.budget.id, b.accounts);
  if (dirty.categories) await repo.saveCategories(b.budget.id, b.groups, b.categories);
  if (dirty.assignments) await repo.saveAssignments(b.budget.id, b.assignments);
  if (dirty.txAll) await repo.writeAllTransactions(b.budget.id, b.transactions);
  else if (dirty.txMonths.size > 0) await repo.writeTransactionMonths(b.budget.id, b.transactions, dirty.txMonths);
}

/** Everything that changes as the user works: the budget, its projection, navigation. */
interface BudgetState {
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
}

/**
 * Every mutation, as a stable object (identity never changes across renders) —
 * a component that only dispatches can subscribe via useActions() and be
 * memoized without re-rendering on data changes.
 */
interface Actions {
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

export type AppState = BudgetState & Actions;

const DataCtx = createContext<BudgetState | null>(null);
const ActionsCtx = createContext<Actions | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [budget, dispatch] = useReducer(reducer, null);
  const repoRef = useRef<BudgetRepository | null>(null);
  const hydratedRef = useRef(false);
  const [month, setMonth] = useState<MonthKey>("");
  const [view, setView] = useState<View>({ kind: "plan" });
  const [loadError, setLoadError] = useState<string | null>(null);

  // Mirror of the current budget for the stable action closures below.
  const budgetRef = useRef<LoadedBudget | null>(null);
  budgetRef.current = budget;

  // Save lifecycle. Saves are many sequential file writes, so they must never
  // overlap (interleaved writes could leave disk with a mix of two snapshots).
  // The latest unsaved budget sits in pendingRef; every actual save is chained
  // onto saveChainRef so at most one runs at a time, always the newest snapshot.
  const pendingRef = useRef<LoadedBudget | null>(null);
  const dirtyRef = useRef<DirtySlices>(cleanSlices());
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingRef = useRef<() => Promise<void>>(() => Promise.resolve());
  flushPendingRef.current = (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const repo = repoRef.current;
    const snapshot = pendingRef.current;
    const dirty = dirtyRef.current;
    pendingRef.current = null;
    dirtyRef.current = cleanSlices();
    if (repo && snapshot) {
      saveChainRef.current = saveChainRef.current
        .then(() => saveDirty(repo, snapshot, dirty))
        .catch((e) => console.error("Failed to save budget:", e));
    }
    return saveChainRef.current;
  };

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
    timerRef.current = setTimeout(() => void flushPendingRef.current(), 500);
  }, [budget]);

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
        await flushPendingRef.current();
        await win.destroy();
      });
    })();
    const onHidden = () => {
      if (document.visibilityState === "hidden") void flushPendingRef.current();
    };
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      unlisten?.();
      document.removeEventListener("visibilitychange", onHidden);
    };
  }, []);

  const projection = useMemo(() => (budget ? computeProjection(budget) : null), [budget]);
  const accById = useMemo(() => new Map((budget?.accounts ?? []).map((a) => [a.id, a.name])), [budget]);
  const catById = useMemo(() => new Map((budget?.categories ?? []).map((c) => [c.id, c.name])), [budget]);

  // The actions object is created ONCE — everything it needs flows through
  // dispatch and refs, so its identity is stable for the app's lifetime.
  const actions = useMemo<Actions>(() => {
    const apply = (fn: (b: LoadedBudget) => LoadedBudget) => dispatch({ type: "apply", fn });
    const mark = (patch: Partial<Omit<DirtySlices, "txMonths">> & { txMonths?: Array<MonthKey | undefined> }) => {
      const d = dirtyRef.current;
      if (patch.meta) d.meta = true;
      if (patch.accounts) d.accounts = true;
      if (patch.categories) d.categories = true;
      if (patch.assignments) d.assignments = true;
      if (patch.txAll) d.txAll = true;
      for (const m of patch.txMonths ?? []) if (m) d.txMonths.add(m);
    };
    /** Month of an existing transaction (for shard-precise saves). */
    const txMonth = (id: Ulid): MonthKey | undefined => {
      const t = budgetRef.current?.transactions.find((x) => x.id === id);
      return t ? monthKeyOf(t.date) : undefined;
    };
    const markAll = () => mark({ meta: true, accounts: true, categories: true, assignments: true, txAll: true });

    return {
      replaceBudget: (b) => {
        markAll();
        dispatch({ type: "set", budget: b });
      },
      addAccount: (args) => { mark({ accounts: true }); apply((b) => ops.addAccount(b, args)); },
      setAccountOrder: (orderedIds) => { mark({ accounts: true }); apply((b) => ops.setAccountOrder(b, orderedIds)); },
      setAccountClosed: (id, closed) => { mark({ accounts: true }); apply((b) => ops.setAccountClosed(b, id, closed)); },
      renameAccount: (id, name) => { mark({ accounts: true }); apply((b) => ops.renameAccount(b, id, name)); },
      reorderCategory: (categoryId, toGroupId, targetIndex) => { mark({ categories: true }); apply((b) => ops.reorderCategory(b, categoryId, toGroupId, targetIndex)); },
      setCategoryOrder: (groupId, orderedIds) => { mark({ categories: true }); apply((b) => ops.setCategoryOrder(b, groupId, orderedIds)); },
      setGroupOrder: (orderedGroupIds) => { mark({ categories: true }); apply((b) => ops.setGroupOrder(b, orderedGroupIds)); },
      setHouseholdOrder: (orderedHouseholds) => { mark({ meta: true }); apply((b) => ops.setHouseholdOrder(b, orderedHouseholds)); },
      addGroup: (name, household) => { mark({ categories: true }); apply((b) => ops.addGroup(b, { name, household })); },
      renameGroup: (id, name) => { mark({ categories: true }); apply((b) => ops.renameGroup(b, id, name)); },
      setGroupHidden: (id, hidden) => { mark({ categories: true }); apply((b) => ops.setGroupHidden(b, id, hidden)); },
      // Cascade deletes clear category refs on transactions in unknown months.
      deleteGroup: (id) => { mark({ categories: true, assignments: true, txAll: true }); apply((b) => ops.deleteGroup(b, id)); },
      addCategory: (groupId, name) => { mark({ categories: true }); apply((b) => ops.addCategory(b, { groupId, name })); },
      renameCategory: (id, name) => { mark({ categories: true }); apply((b) => ops.renameCategory(b, id, name)); },
      moveCategory: (id, toGroupId) => { mark({ categories: true }); apply((b) => ops.moveCategory(b, id, toGroupId)); },
      setCategoryHidden: (id, hidden) => { mark({ categories: true }); apply((b) => ops.setCategoryHidden(b, id, hidden)); },
      deleteCategory: (id) => { mark({ categories: true, assignments: true, txAll: true }); apply((b) => ops.deleteCategory(b, id)); },
      setAssigned: (m, categoryId, amount) => { mark({ assignments: true }); apply((b) => ops.setAssigned(b, m, categoryId, amount)); },
      moveMoney: (m, from, to, amount) => { mark({ assignments: true }); apply((b) => ops.moveMoney(b, m, from, to, amount)); },
      coverShortfall: (m, from, to) => { mark({ assignments: true }); apply((b) => ops.coverShortfall(b, m, from, to)); },
      addTransaction: (tx) => { mark({ txMonths: [monthKeyOf(tx.date)] }); apply((b) => ops.addTransaction(b, tx)); },
      addTransactions: (txs) => { mark({ txMonths: txs.map((t) => monthKeyOf(t.date)) }); apply((b) => ops.addTransactions(b, txs)); },
      setTransactions: (txs) => { mark({ txAll: true }); apply((b) => ops.setTransactions(b, txs)); },
      // A date edit can move the row across shards: mark old AND new months.
      updateTransaction: (id, patch) => {
        mark({ txMonths: [txMonth(id), patch.date ? monthKeyOf(patch.date) : undefined] });
        apply((b) => ops.updateTransaction(b, id, patch));
      },
      deleteTransaction: (id) => { mark({ txMonths: [txMonth(id)] }); apply((b) => ops.deleteTransaction(b, id)); },
      approveTransaction: (id) => { mark({ txMonths: [txMonth(id)] }); apply((b) => ops.approveTransaction(b, id)); },
      approveTransactions: (ids) => { mark({ txMonths: ids.map(txMonth) }); apply((b) => ops.approveTransactions(b, ids)); },
      setSplits: (id, splits, categoryIdWhenUnsplit) => { mark({ txMonths: [txMonth(id)] }); apply((b) => ops.setSplits(b, id, splits, categoryIdWhenUnsplit)); },

      loadFormats: () => repoRef.current?.loadFormats() ?? Promise.resolve([]),
      saveFormats: (formats) => repoRef.current?.saveFormats(formats) ?? Promise.resolve(),
      statementSourceKey: async (accountId, formatId) => {
        const repo = repoRef.current;
        const budgetId = budgetRef.current?.budget.id;
        // Browser preview: deterministic per-account key, nothing persisted.
        if (!repo || !budgetId) return `stmt:${accountId}`;
        const entries = await repo.loadImportSources(budgetId);
        const existing = entries.find((e) => e.accountId === accountId);
        if (existing) return existing.sourceKey;
        const sourceKey = newId();
        await repo.saveImportSources(budgetId, [...entries, { accountId, formatId, sourceKey }]);
        return sourceKey;
      },
    };
  }, []);

  const months = projection?.months ?? [];
  const activeMonth = months.includes(month) ? month : months[months.length - 1] ?? month;

  const data = useMemo<BudgetState | null>(() => {
    if (!budget || !projection) return null;
    return {
      budget,
      projection,
      currency: budget.budget.currency,
      months: projection.months,
      month: activeMonth,
      setMonth,
      view,
      setView,
      accountName: (id) => accById.get(id) ?? "—",
      categoryName: (id) => (id ? catById.get(id) ?? "—" : ""),
    };
  }, [budget, projection, activeMonth, view, accById, catById]);

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

  if (!data) {
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

  return (
    <ActionsCtx.Provider value={actions}>
      <DataCtx.Provider value={data}>{children}</DataCtx.Provider>
    </ActionsCtx.Provider>
  );
}

/** Budget data + navigation. Re-renders subscribers when the budget changes. */
export function useBudgetState(): BudgetState {
  const v = useContext(DataCtx);
  if (!v) throw new Error("useBudgetState must be used within AppProvider");
  return v;
}

/** Mutations only — a stable object, safe to depend on in memoized components. */
export function useActions(): Actions {
  const v = useContext(ActionsCtx);
  if (!v) throw new Error("useActions must be used within AppProvider");
  return v;
}

/** Convenience for components that need both (most of the app today). */
export function useApp(): AppState {
  const data = useBudgetState();
  const actions = useActions();
  return useMemo(() => ({ ...data, ...actions }), [data, actions]);
}
