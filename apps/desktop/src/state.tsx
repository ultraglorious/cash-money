import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Alert, Button, Center, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  BudgetRepository,
  computeProjection,
  mergeBudgetFiles,
  newId,
  ops,
  parseBudgetFile,
  reportTookFromFile,
  serializeBudgetFile,
  type AccountType,
  type BudgetFileData,
  type Cents,
  type CurrencyConfig,
  type ImportSourceEntry,
  type LoadedBudget,
  type MonthKey,
  type Projection,
  type SavedFormat,
  type SplitLine,
  type Transaction,
  type Ulid,
} from "@cash-money/core";
import { demoBudget } from "./demo";
import {
  backupBudgetFile,
  isConflictError,
  isTauri,
  readBudgetFile,
  statBudgetFile,
  TauriFileSystem,
  writeBudgetFile,
} from "./platform/tauriFs";
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

/** A filesystem-friendly file name for a budget. */
function budgetFileName(name: string): string {
  return `${name.replace(/[^\w\- ]+/g, "").trim() || "Budget"}.cashmoney`;
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
  /** Absolute path of the .cashmoney file this app follows (null in the browser preview). */
  budgetFilePath: string | null;
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
  /** Record money moving between two accounts (creates both linked legs). */
  addTransfer: (args: ops.TransferArgs) => void;
  /** Edit one transfer leg; the other mirrors (amount/date/memo/accounts). */
  updateTransfer: (id: Ulid, patch: { accountId?: Ulid; counterAccountId?: Ulid; date?: string; amount?: Cents; memo?: string; cleared?: "cleared" | "uncleared" | "reconciled" }) => void;
  setTransactions: (txs: Transaction[]) => void;
  updateTransaction: (id: Ulid, patch: Partial<Omit<Transaction, "id">>) => void;
  deleteTransaction: (id: Ulid) => void;
  deleteTransactions: (ids: Ulid[]) => void;
  approveTransaction: (id: Ulid) => void;
  approveTransactions: (ids: Ulid[]) => void;
  /** Bulk cleared-status change (multi-select "mark cleared/uncleared"). */
  setClearedStatus: (ids: Ulid[], cleared: "cleared" | "uncleared" | "reconciled") => void;
  /** Rename every transaction with this exact payee. */
  renamePayee: (from: string, to: string) => void;
  setSplits: (id: Ulid, splits: SplitLine[] | undefined, categoryIdWhenUnsplit?: Ulid) => void;
  /** Mark statement-confirmed rows reconciled and advance the account's reconciled-through date. */
  reconcileAccount: (accountId: Ulid, txIds: Ulid[], through: string) => void;

  /** User-saved register formats (travel inside the budget file; empty in the browser preview). */
  loadFormats: () => Promise<SavedFormat[]>;
  saveFormats: (formats: SavedFormat[]) => Promise<void>;
  /** Which account was last reconciled with which format (newest first). */
  listStatementSources: () => Promise<ImportSourceEntry[]>;
  /**
   * The stable statement sourceKey for an account — minted once, persisted,
   * and reused so re-imported statements identity-match earlier ones. Every
   * call also records the format used and the date, which is what lets the
   * wizard recall the right account + mapping next time.
   */
  statementSourceKey: (accountId: Ulid, formatId: string) => Promise<string>;

  /** Write the budget to a new .cashmoney path and follow it from now on. */
  moveBudgetFile: (newPath: string) => Promise<void>;
  /** Open an existing .cashmoney file, replacing the in-memory budget. */
  openBudgetFile: (path: string) => Promise<void>;
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
  // Brand-new machine: nothing local yet. Ask "create or open?" instead of
  // silently minting an empty budget — the second computer of a synced pair
  // should OPEN the synced file, not start from scratch.
  const [needsSetup, setNeedsSetup] = useState(false);

  // Mirror of the current budget for the stable action closures below.
  const budgetRef = useRef<LoadedBudget | null>(null);
  budgetRef.current = budget;

  // ---- Single-file persistence ----------------------------------------------
  // The whole budget lives in ONE .cashmoney file (JSON), typically in a
  // cloud-synced folder. Saves rewrite the file atomically, debounced and
  // serialized; the mtime we last saw guards against another device's sync
  // having changed the file underneath us — a refused write surfaces a
  // conflict banner instead of clobbering.
  const filePathRef = useRef<string | null>(null);
  const fileMtimeRef = useRef<number | undefined>(undefined);
  const formatsRef = useRef<SavedFormat[]>([]);
  const sourcesRef = useRef<ImportSourceEntry[]>([]);
  const backedUpRef = useRef(false);
  const conflictRef = useRef(false);
  /** The last state known to be in sync with the file — the base for three-way merges. */
  const baseRef = useRef<BudgetFileData | null>(null);
  /** Set when a dispatch reflects what's ALREADY on disk (adopt/merge) — don't save it back. */
  const skipPersistRef = useRef(false);
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileConflict, setFileConflict] = useState(false);

  const pendingRef = useRef<LoadedBudget | null>(null);
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushPendingRef = useRef<() => Promise<void>>(() => Promise.resolve());
  flushPendingRef.current = (): Promise<void> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const snapshot = pendingRef.current;
    const path = filePathRef.current;
    if (!snapshot || !path || conflictRef.current || !isTauri()) return saveChainRef.current;
    pendingRef.current = null;
    saveChainRef.current = saveChainRef.current.then(async () => {
      try {
        // Once per session, keep the file's state at open as a .bak sibling.
        if (!backedUpRef.current) {
          backedUpRef.current = true;
          await backupBudgetFile(path).catch(() => undefined);
        }
        const data: BudgetFileData = { loaded: snapshot, savedFormats: formatsRef.current, importSources: sourcesRef.current };
        const text = serializeBudgetFile(data, new Date().toISOString());
        fileMtimeRef.current = await writeBudgetFile(path, text, fileMtimeRef.current);
        baseRef.current = data;
      } catch (e) {
        if (isConflictError(e)) {
          // Another device wrote in between: keep the unsaved snapshot and
          // fold both sides together instead of asking or clobbering.
          pendingRef.current = pendingRef.current ?? snapshot;
          void mergeFromDiskRef.current();
        } else {
          console.error("Failed to save budget:", e);
        }
      }
    });
    return saveChainRef.current;
  };

  /** Adopt freshly-read file contents as the app's state. */
  const adoptRef = useRef<(path: string, contents: string, mtimeMs: number) => void>(() => {});
  adoptRef.current = (path, contents, mtimeMs) => {
    const data = parseBudgetFile(contents); // throws on anything invalid
    filePathRef.current = path;
    fileMtimeRef.current = mtimeMs;
    formatsRef.current = data.savedFormats;
    sourcesRef.current = data.importSources;
    baseRef.current = data;
    pendingRef.current = null;
    backedUpRef.current = false;
    conflictRef.current = false;
    skipPersistRef.current = true; // this state IS the file; nothing to save back
    setFileConflict(false);
    setFilePath(path);
    setLoadError(null);
    setNeedsSetup(false);
    dispatch({ type: "set", budget: data.loaded });
  };

  /**
   * The file changed while we hold local edits: three-way merge instead of a
   * dialog. base = last synced state, ours = memory, theirs = disk. Ours wins
   * genuine ties (same record edited on both sides); a toast reports the rest.
   * Falls back to the conflict banner only when merging itself fails.
   */
  const mergeFromDiskRef = useRef<() => Promise<void>>(async () => {});
  mergeFromDiskRef.current = async () => {
    const path = filePathRef.current;
    const b = budgetRef.current;
    if (!path || !b || conflictRef.current) return;
    try {
      const { contents, mtimeMs } = await readBudgetFile(path);
      const theirs = parseBudgetFile(contents);
      const ours: BudgetFileData = { loaded: b, savedFormats: formatsRef.current, importSources: sourcesRef.current };
      const base = baseRef.current ?? theirs; // no base (shouldn't happen): treat the file as base
      const { merged, report } = mergeBudgetFiles(base, ours, theirs);

      if (!reportTookFromFile(report) && report.tiesKeptLocal === 0) {
        // The file's changes are already part of our state (e.g. our own write
        // raced the watcher, or only savedAt differs): just resync the clock
        // and let any pending edits save normally.
        fileMtimeRef.current = mtimeMs;
        baseRef.current = theirs;
        return;
      }

      formatsRef.current = merged.savedFormats;
      sourcesRef.current = merged.importSources;
      pendingRef.current = null;
      skipPersistRef.current = true; // we persist the merge explicitly below
      dispatch({ type: "set", budget: merged.loaded });

      const text = serializeBudgetFile(merged, new Date().toISOString());
      fileMtimeRef.current = await writeBudgetFile(path, text, mtimeMs);
      baseRef.current = merged;

      const parts: string[] = [];
      if (report.addedFromFile) parts.push(`${report.addedFromFile} added`);
      if (report.updatedFromFile) parts.push(`${report.updatedFromFile} updated`);
      if (report.deletedFromFile) parts.push(`${report.deletedFromFile} removed`);
      if (report.dedupedImports) parts.push(`${report.dedupedImports} duplicate import${report.dedupedImports === 1 ? "" : "s"} dropped`);
      const ties = report.tiesKeptLocal
        ? `${parts.length > 0 ? " · " : ""}${report.tiesKeptLocal} conflicting edit${report.tiesKeptLocal === 1 ? "" : "s"} kept from this computer`
        : "";
      notifications.show({
        title: "Merged changes from another computer",
        message: `${parts.join(", ")}${ties}`,
        color: "blue",
      });
    } catch (e) {
      if (isConflictError(e)) {
        // The file moved again between our read and write — go around once more.
        setTimeout(() => void mergeFromDiskRef.current(), 500);
        return;
      }
      console.error("Automatic merge failed:", e);
      conflictRef.current = true;
      setFileConflict(true);
    }
  };

  /** Write `loaded` to a fresh default-location file and follow it. */
  const followNewFileRef = useRef<(loaded: LoadedBudget) => Promise<void>>(async () => {});
  followNewFileRef.current = async (loaded) => {
    const repo = repoRef.current;
    if (!repo) return;
    const { appDataDir, join } = await import("@tauri-apps/api/path");
    const path = await join(await appDataDir(), budgetFileName(loaded.budget.name));
    const text = serializeBudgetFile(
      { loaded, savedFormats: formatsRef.current, importSources: sourcesRef.current },
      new Date().toISOString(),
    );
    const mtime = await writeBudgetFile(path, text);
    const app = await repo.loadApp();
    await repo.saveApp({ ...app, budgetFilePath: path });
    filePathRef.current = path;
    fileMtimeRef.current = mtime;
    backedUpRef.current = true; // just written; nothing older to preserve
    baseRef.current = { loaded, savedFormats: formatsRef.current, importSources: sourcesRef.current };
    skipPersistRef.current = true;
    setFilePath(path);
    setNeedsSetup(false);
    dispatch({ type: "set", budget: loaded });
  };

  const resolveConflictRef = useRef<(choice: "reload" | "overwrite") => Promise<void>>(async () => {});
  resolveConflictRef.current = async (choice) => {
    const path = filePathRef.current;
    if (!path) return;
    if (choice === "overwrite") {
      conflictRef.current = false;
      setFileConflict(false);
      fileMtimeRef.current = undefined; // skip the guard once, on purpose
      pendingRef.current = budgetRef.current;
      await flushPendingRef.current();
    } else {
      try {
        const { contents, mtimeMs } = await readBudgetFile(path);
        adoptRef.current(path, contents, mtimeMs);
      } catch (e) {
        setLoadError(String(e));
      }
    }
  };

  // Bootstrap: follow the configured budget file; on first run assemble one
  // from the legacy multi-file layout (left untouched) or start fresh. In a
  // plain browser, demo data.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTauri()) {
        if (!cancelled) dispatch({ type: "set", budget: demoBudget() });
        return;
      }
      const repo = new BudgetRepository(new TauriFileSystem());
      repoRef.current = repo;
      try {
        const app = await repo.loadApp();
        if (app.budgetFilePath) {
          const { contents, mtimeMs } = await readBudgetFile(app.budgetFilePath);
          if (!cancelled) adoptRef.current(app.budgetFilePath, contents, mtimeMs);
          return;
        }
        // First run on the single-file format: migrate legacy data if present;
        // on a truly fresh machine, ask create-or-open instead of assuming.
        if (app.activeBudgetId) {
          const loaded = await repo.loadBudget(app.activeBudgetId);
          formatsRef.current = await repo.loadFormats().catch(() => []);
          sourcesRef.current = await repo.loadImportSources(app.activeBudgetId).catch(() => []);
          if (!cancelled) await followNewFileRef.current(loaded);
        } else if (!cancelled) {
          setNeedsSetup(true);
        }
      } catch (e) {
        // Never fall back to a fresh empty budget here: the real data — still
        // on disk or in the file — would be orphaned. Surface the problem.
        console.error("Failed to load budget:", e);
        if (!cancelled) setLoadError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Persist changes (debounced, serialized). Skips the initial hydration and
  // dispatches that merely mirror what's already on disk (adopt/merge) — saving
  // those back would bump the file's mtime and ping-pong between two open apps.
  useEffect(() => {
    if (!budget || !filePathRef.current) return;
    const skip = skipPersistRef.current;
    skipPersistRef.current = false;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    if (skip) return;
    pendingRef.current = budget;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flushPendingRef.current(), 500);
  }, [budget]);

  // Watch the file for changes made by ANOTHER computer (or its sync agent).
  // Poll + check on refocus; an idle app simply follows along, an app holding
  // unsaved edits merges. Checks ride the save chain so they never race a
  // write of our own.
  useEffect(() => {
    if (!isTauri()) return;
    let stopped = false;
    const check = () => {
      if (stopped || !filePathRef.current || conflictRef.current) return;
      saveChainRef.current = saveChainRef.current.then(async () => {
        if (stopped || conflictRef.current) return;
        const path = filePathRef.current;
        const known = fileMtimeRef.current;
        if (!path || known === undefined) return;
        try {
          const mtime = await statBudgetFile(path);
          if (mtime === null || Math.abs(mtime - known) <= 2) return;
          const idle = pendingRef.current === null && timerRef.current === null;
          if (idle) {
            const { contents, mtimeMs } = await readBudgetFile(path);
            adoptRef.current(path, contents, mtimeMs);
            notifications.show({
              title: "Updated from the synced file",
              message: "Another computer saved changes; this window refreshed.",
              color: "blue",
            });
          } else {
            await mergeFromDiskRef.current();
          }
        } catch (e) {
          console.error("Sync check failed:", e);
        }
      });
    };
    const interval = setInterval(check, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);

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
    /** Formats/sources changed without a budget edit: schedule a file save anyway. */
    const scheduleSave = () => {
      if (!budgetRef.current) return;
      pendingRef.current = budgetRef.current;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flushPendingRef.current(), 500);
    };

    return {
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
      addTransaction: (tx) => apply((b) => ops.addTransaction(b, tx)),
      addTransactions: (txs) => apply((b) => ops.addTransactions(b, txs)),
      addTransfer: (args) => apply((b) => ops.addTransfer(b, args)),
      updateTransfer: (id, patch) => apply((b) => ops.updateTransfer(b, id, patch)),
      setTransactions: (txs) => apply((b) => ops.setTransactions(b, txs)),
      updateTransaction: (id, patch) => apply((b) => ops.updateTransaction(b, id, patch)),
      deleteTransaction: (id) => apply((b) => ops.deleteTransaction(b, id)),
      deleteTransactions: (ids) => apply((b) => ops.deleteTransactions(b, ids)),
      approveTransaction: (id) => apply((b) => ops.approveTransaction(b, id)),
      approveTransactions: (ids) => apply((b) => ops.approveTransactions(b, ids)),
      setClearedStatus: (ids, cleared) => apply((b) => ops.setClearedStatus(b, ids, cleared)),
      renamePayee: (from, to) => apply((b) => ops.renamePayee(b, from, to)),
      setSplits: (id, splits, categoryIdWhenUnsplit) => apply((b) => ops.setSplits(b, id, splits, categoryIdWhenUnsplit)),
      reconcileAccount: (accountId, txIds, through) => apply((b) => ops.reconcileAccount(b, accountId, txIds, through)),

      loadFormats: () => Promise.resolve([...formatsRef.current]),
      saveFormats: (formats) => {
        formatsRef.current = formats;
        scheduleSave();
        return Promise.resolve();
      },
      listStatementSources: () =>
        Promise.resolve([...sourcesRef.current].sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""))),
      statementSourceKey: async (accountId, formatId) => {
        if (!isTauri()) return `stmt:${accountId}`; // browser preview: nothing persists
        const lastUsed = new Date().toISOString().slice(0, 10);
        const existing = sourcesRef.current.find((e) => e.accountId === accountId);
        if (existing) {
          sourcesRef.current = sourcesRef.current.map((e) => (e === existing ? { ...e, formatId, lastUsed } : e));
          scheduleSave();
          return existing.sourceKey;
        }
        const sourceKey = newId();
        sourcesRef.current = [...sourcesRef.current, { accountId, formatId, sourceKey, lastUsed }];
        scheduleSave();
        return sourceKey;
      },

      moveBudgetFile: async (newPath) => {
        const b = budgetRef.current;
        const repo = repoRef.current;
        if (!b || !repo) throw new Error("No budget loaded");
        const data: BudgetFileData = { loaded: b, savedFormats: formatsRef.current, importSources: sourcesRef.current };
        const text = serializeBudgetFile(data, new Date().toISOString());
        const mtime = await writeBudgetFile(newPath, text); // save dialog already confirmed any overwrite
        const app = await repo.loadApp();
        await repo.saveApp({ ...app, budgetFilePath: newPath });
        filePathRef.current = newPath;
        fileMtimeRef.current = mtime;
        backedUpRef.current = true;
        baseRef.current = data;
        conflictRef.current = false;
        setFileConflict(false);
        setFilePath(newPath);
      },
      openBudgetFile: async (path) => {
        const repo = repoRef.current;
        if (!repo) throw new Error("Only available in the desktop app");
        const { contents, mtimeMs } = await readBudgetFile(path);
        // Parse BEFORE committing to the path, so a bad pick changes nothing.
        parseBudgetFile(contents);
        const app = await repo.loadApp();
        await repo.saveApp({ ...app, budgetFilePath: path });
        adoptRef.current(path, contents, mtimeMs);
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
      budgetFilePath: filePath,
    };
  }, [budget, projection, activeMonth, view, accById, catById, filePath]);

  if (loadError) {
    return (
      <Center h="100vh" p="xl">
        <Alert color="red" title="Couldn't read your budget" maw={560}>
          <Text size="sm">
            Your data is still on disk, but it couldn't be loaded, so editing is disabled to avoid
            overwriting anything. If the budget file moved (or hasn't synced down yet), locate it below;
            otherwise fix the cause and reopen the app.
          </Text>
          <Text size="xs" c="dimmed" mt="sm" style={{ fontFamily: "monospace", wordBreak: "break-all" }}>
            {loadError}
          </Text>
          <Group mt="md">
            <Button
              size="xs"
              variant="light"
              onClick={() => {
                void (async () => {
                  const { open } = await import("@tauri-apps/plugin-dialog");
                  const picked = await open({ multiple: false, filters: [{ name: "Budget", extensions: ["cashmoney"] }] });
                  if (!picked || Array.isArray(picked)) return;
                  try {
                    await actions.openBudgetFile(picked);
                  } catch (e) {
                    setLoadError(String(e));
                  }
                })();
              }}
            >
              Locate budget file…
            </Button>
          </Group>
        </Alert>
      </Center>
    );
  }

  if (needsSetup) {
    return (
      <Center h="100vh" p="xl">
        <Stack align="center" gap="md" maw={440}>
          <Text size="xl" fw={700}>Welcome</Text>
          <Text size="sm" c="dimmed" ta="center">
            Start a new budget, or — if you already use the app on another computer — open your
            synced <Text span ff="monospace" inherit>.cashmoney</Text> file (e.g. from iCloud Drive).
          </Text>
          <Group>
            <Button
              onClick={() => void followNewFileRef.current(newEmptyBudget()).catch((e) => setLoadError(String(e)))}
            >
              Create a new budget
            </Button>
            <Button
              variant="default"
              onClick={() => {
                void (async () => {
                  const { open } = await import("@tauri-apps/plugin-dialog");
                  const picked = await open({ multiple: false, filters: [{ name: "Budget", extensions: ["cashmoney"] }] });
                  if (!picked || Array.isArray(picked)) return;
                  try {
                    await actions.openBudgetFile(picked);
                  } catch (e) {
                    setLoadError(String(e));
                  }
                })();
              }}
            >
              Open an existing budget file…
            </Button>
          </Group>
        </Stack>
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
      <DataCtx.Provider value={data}>
        {fileConflict && (
          <Alert
            color="orange"
            title="Couldn't merge the budget file automatically"
            style={{ position: "fixed", top: 12, left: "50%", transform: "translateX(-50%)", zIndex: 1000, maxWidth: 560, boxShadow: "var(--mantine-shadow-md)" }}
          >
            <Text size="sm">
              The file changed outside this app and the automatic merge failed (it may be unreadable or
              from a newer app version). Saving is paused so nothing gets clobbered.
            </Text>
            <Group mt="sm" gap="xs">
              <Button size="xs" color="orange" variant="light" onClick={() => void resolveConflictRef.current("reload")}>
                Load the file's version
              </Button>
              <Button size="xs" color="red" variant="light" onClick={() => void resolveConflictRef.current("overwrite")}>
                Keep this app's version
              </Button>
            </Group>
          </Alert>
        )}
        {children}
      </DataCtx.Provider>
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
