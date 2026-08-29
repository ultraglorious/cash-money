import type { Payee, Transaction } from "../model/types.js";
import { stableJson } from "./serialize.js";
import type { BudgetFileData } from "./budgetFile.js";

/**
 * Three-way merge of two divergent copies of the budget file — what makes
 * "accidentally open on both computers" resolve smoothly instead of one side
 * clobbering the other. `base` is the last state this app knew to be in sync,
 * `ours` is what's in memory here, `theirs` is what's on disk now.
 *
 * Every collection merges independently by a stable key:
 *  - additions from either side are kept (both, when both added);
 *  - an edit on exactly one side wins over no-edit;
 *  - a deletion propagates unless the other side edited that record —
 *    an edit is never lost to a delete;
 *  - the same record edited differently on BOTH sides is the only true
 *    conflict: OURS wins (the user is at this machine) and it's counted so
 *    the UI can say so.
 *
 * Assignments key by (month, categoryId) rather than record id — each machine
 * can mint a different id for the same envelope slot, and two records for one
 * slot would double-count. Transactions get a post-pass deduping rows that
 * share import provenance: both machines importing the same statement mint
 * different ULIDs for identical rows.
 */

export interface MergeReport {
  addedFromFile: number;
  updatedFromFile: number;
  deletedFromFile: number;
  /** Records edited on both sides where this machine's version was kept. */
  tiesKeptLocal: number;
  /** Same imported row arrived from both sides under different ids. */
  dedupedImports: number;
}

/** Anything at all taken from the file's side (drives whether the UI mentions the merge). */
export function reportTookFromFile(r: MergeReport): boolean {
  return r.addedFromFile + r.updatedFromFile + r.deletedFromFile + r.dedupedImports > 0;
}

const eq = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b);

/**
 * Payees merge by id like everything else, EXCEPT their aliases, which are a
 * growing set rather than a value: an alias learned on the laptop and another
 * learned on the desktop are both true, and ours-wins would silently drop one.
 * Union them, then let the ordinary rules settle the name.
 */
function mergePayees(base: readonly Payee[], ours: readonly Payee[], theirs: readonly Payee[], report: MergeReport): Payee[] {
  const theirsById = new Map(theirs.map((p) => [p.id, p]));
  const merged = mergeCollection(base, ours, theirs, (p) => p.id, report);
  return merged.map((p) => {
    const other = theirsById.get(p.id);
    if (!other) return p;
    const aliases = [...new Set([...p.aliases, ...other.aliases])];
    return aliases.length === p.aliases.length ? p : { ...p, aliases };
  });
}

function mergeCollection<T>(
  base: readonly T[],
  ours: readonly T[],
  theirs: readonly T[],
  key: (t: T) => string,
  report: MergeReport,
): T[] {
  const bm = new Map(base.map((t) => [key(t), t]));
  const om = new Map(ours.map((t) => [key(t), t]));
  const tm = new Map(theirs.map((t) => [key(t), t]));
  const keys: string[] = [...om.keys()];
  for (const k of tm.keys()) if (!om.has(k)) keys.push(k);

  const out: T[] = [];
  for (const k of keys) {
    const b = bm.get(k);
    const o = om.get(k);
    const t = tm.get(k);
    if (o !== undefined && t !== undefined) {
      if (eq(o, t)) out.push(o);
      else if (b !== undefined && eq(o, b)) {
        out.push(t); // only the file's side changed it
        report.updatedFromFile++;
      } else if (b !== undefined && eq(t, b)) {
        out.push(o); // only we changed it
      } else {
        out.push(o); // both changed it differently (or both added under one key)
        report.tiesKeptLocal++;
      }
    } else if (o !== undefined) {
      if (b === undefined) out.push(o); // we added it
      else if (eq(o, b)) report.deletedFromFile++; // file deleted it, we hadn't touched it
      else out.push(o); // file deleted it but we edited it: the edit survives
    } else if (t !== undefined) {
      if (b === undefined) {
        out.push(t); // file added it
        report.addedFromFile++;
      } else if (!eq(t, b)) {
        out.push(t); // we deleted it but the file edited it: the edit survives
        report.updatedFromFile++;
      }
      // else: we deleted an untouched record — it stays deleted
    }
  }
  return out;
}

/** Single-object variant (the budget meta). */
function mergeOne<T>(base: T, ours: T, theirs: T, report: MergeReport): T {
  if (eq(ours, theirs)) return ours;
  if (eq(ours, base)) {
    report.updatedFromFile++;
    return theirs;
  }
  if (eq(theirs, base)) return ours;
  report.tiesKeptLocal++;
  return ours;
}

function dedupeImportedTransactions(txs: readonly Transaction[], report: MergeReport): Transaction[] {
  const seen = new Set<string>();
  const out: Transaction[] = [];
  for (const t of txs) {
    const s = t.source;
    if (!s?.identity) {
      out.push(t);
      continue;
    }
    const k = `${s.sourceBudget}|${s.identity}|${s.occurrenceIndex}`;
    if (seen.has(k)) {
      report.dedupedImports++;
      continue; // ours come first in merge order, so ours is the one kept
    }
    seen.add(k);
    out.push(t);
  }
  return out;
}

export function mergeBudgetFiles(
  base: BudgetFileData,
  ours: BudgetFileData,
  theirs: BudgetFileData,
): { merged: BudgetFileData; report: MergeReport } {
  const report: MergeReport = {
    addedFromFile: 0,
    updatedFromFile: 0,
    deletedFromFile: 0,
    tiesKeptLocal: 0,
    dedupedImports: 0,
  };
  const byId = (x: { id: string }): string => x.id;
  const merged: BudgetFileData = {
    loaded: {
      budget: mergeOne(base.loaded.budget, ours.loaded.budget, theirs.loaded.budget, report),
      accounts: mergeCollection(base.loaded.accounts, ours.loaded.accounts, theirs.loaded.accounts, byId, report),
      groups: mergeCollection(base.loaded.groups, ours.loaded.groups, theirs.loaded.groups, byId, report),
      categories: mergeCollection(base.loaded.categories, ours.loaded.categories, theirs.loaded.categories, byId, report),
      assignments: mergeCollection(
        base.loaded.assignments,
        ours.loaded.assignments,
        theirs.loaded.assignments,
        (a) => `${a.month}|${a.categoryId}`,
        report,
      ),
      transactions: dedupeImportedTransactions(
        mergeCollection(base.loaded.transactions, ours.loaded.transactions, theirs.loaded.transactions, byId, report),
        report,
      ),
      payees: mergePayees(base.loaded.payees ?? [], ours.loaded.payees ?? [], theirs.loaded.payees ?? [], report),
    },
    savedFormats: mergeCollection(base.savedFormats, ours.savedFormats, theirs.savedFormats, (f) => f.format.id, report),
    importSources: mergeCollection(base.importSources, ours.importSources, theirs.importSources, (s) => s.accountId, report),
    // Skips are a growing set, like payee aliases: a row skipped on either
    // machine was skipped, so additions from both sides are kept.
    skippedRows: mergeCollection(base.skippedRows, ours.skippedRows, theirs.skippedRows, (r) => r.identity, report),
  };
  return { merged, report };
}
