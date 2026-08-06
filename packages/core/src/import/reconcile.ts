import type { Ulid } from "../ids.js";
import type { Transaction } from "../model/types.js";
import { SEP, fold } from "./text.js";

/**
 * Reconciles a freshly-staged transaction set against what's already stored,
 * matching by content identity (not the regenerated ULID). Matched rows keep
 * their existing id and original first-seen timestamp; genuinely new rows are
 * added; rows that vanished from a re-imported source are reported as deleted.
 *
 * Because identity is derived from the value-defining fields, a source-side edit to
 * amount/date/payee/category surfaces as delete+add (correct), while edits to the
 * non-identity fields (cleared / approved / flag / effectiveDate) surface as an
 * in-place change. Re-importing the same export is a no-op (added=changed=deleted=0).
 */

export interface ReconcileReport {
  added: number;
  changed: number;
  unchanged: number;
  deleted: number;
}

export interface ReconcileResult {
  merged: Transaction[];
  report: ReconcileReport;
}

function identityOf(t: Transaction): string | undefined {
  return t.source?.identity;
}

/** Non-identity, import-authoritative fields whose change is an in-place update. */
function mutableFieldsDiffer(a: Transaction, b: Transaction): boolean {
  return (
    a.cleared !== b.cleared ||
    a.approved !== b.approved ||
    a.flag !== b.flag ||
    a.effectiveDate !== b.effectiveDate
  );
}

export function reconcileTransactions(
  existing: readonly Transaction[],
  staged: readonly Transaction[],
): ReconcileResult {
  const existingByIdentity = new Map<string, Transaction>();
  for (const t of existing) {
    const id = identityOf(t);
    if (id) existingByIdentity.set(id, t);
  }

  // Which sources does this import cover? We only claim deletions for those.
  const importedSources = new Set<string>();
  for (const t of staged) if (t.source) importedSources.add(t.source.sourceBudget);

  const merged: Transaction[] = [];
  const consumed = new Set<string>();
  let added = 0;
  let changed = 0;
  let unchanged = 0;

  for (const s of staged) {
    const id = identityOf(s);
    const ex = id ? existingByIdentity.get(id) : undefined;
    if (!ex) {
      merged.push(s);
      added++;
      continue;
    }
    consumed.add(id!);
    // Preserve the existing id and original first-seen; refresh last-seen.
    const kept: Transaction = {
      ...s,
      id: ex.id,
      source: s.source
        ? {
            ...s.source,
            firstSeenExportTs: ex.source?.firstSeenExportTs ?? s.source.firstSeenExportTs,
          }
        : undefined,
    };
    merged.push(kept);
    if (mutableFieldsDiffer(ex, s)) changed++;
    else unchanged++;
  }

  // Existing rows from a re-imported source that didn't reappear => deleted.
  let deleted = 0;
  for (const t of existing) {
    const id = identityOf(t);
    if (id && consumed.has(id)) continue;
    const fromImportedSource = t.source && importedSources.has(t.source.sourceBudget);
    if (fromImportedSource) {
      deleted++;
      // Dropped from `merged` (not carried forward).
    } else {
      // App-created or from a source not in this import: keep untouched.
      merged.push(t);
    }
  }

  return { merged, report: { added, changed, unchanged, deleted } };
}

// ---- Statement merge ---------------------------------------------------------

export interface StatementMergeReport {
  added: number;
  /** Incoming rows already present by content identity (left untouched). */
  matched: number;
  /** Incoming rows matched to provenance-less rows by content (adopted). */
  legacyMatched: number;
}

/**
 * Merge a statement's transactions into the existing set. DELIBERATELY not
 * `reconcileTransactions`: that models an authoritative snapshot (staged wins,
 * vanished rows are deletions). A statement is an append-only window of
 * actuals, so the rules here are the opposite —
 *
 *   - identity match: KEEP the existing row untouched (except a refreshed
 *     last-seen timestamp) — the user may have categorized/split it in-app;
 *   - no identity match, but a provenance-less row in the same account has the
 *     same date+amount+payee+memo: adopt the incoming provenance onto it (rows
 *     imported through the pre-identity bank path are matched, not duplicated;
 *     future imports then identity-match). Each legacy row is consumed once;
 *   - otherwise: add;
 *   - NEVER delete — an overlapping or partial statement says nothing about
 *     rows outside its window.
 */
export function mergeStatement(
  existing: readonly Transaction[],
  incoming: readonly Transaction[],
  accountId: Ulid,
): { merged: Transaction[]; report: StatementMergeReport } {
  const byIdentity = new Map<string, number>();
  const legacyByContent = new Map<string, number[]>();
  existing.forEach((t, i) => {
    if (t.source?.identity) {
      byIdentity.set(t.source.identity, i);
    } else if (t.accountId === accountId) {
      const key = [t.date, t.amount, fold(t.payee), fold(t.memo)].join(SEP);
      (legacyByContent.get(key) ?? legacyByContent.set(key, []).get(key)!).push(i);
    }
  });

  const merged = [...existing];
  let added = 0;
  let matched = 0;
  let legacyMatched = 0;

  for (const inc of incoming) {
    const identity = inc.source?.identity;
    const exIdx = identity ? byIdentity.get(identity) : undefined;
    if (exIdx !== undefined) {
      matched++;
      const ex = merged[exIdx]!;
      if (ex.source && inc.source && inc.source.lastSeenExportTs > ex.source.lastSeenExportTs) {
        merged[exIdx] = { ...ex, source: { ...ex.source, lastSeenExportTs: inc.source.lastSeenExportTs } };
      }
      continue;
    }
    const key = [inc.date, inc.amount, fold(inc.payee), fold(inc.memo)].join(SEP);
    const legacyIdx = legacyByContent.get(key)?.shift();
    if (legacyIdx !== undefined) {
      legacyMatched++;
      // Adopt the provenance so the next import identity-matches this row, but
      // keep everything the user may have edited (category, splits, memo case).
      merged[legacyIdx] = { ...merged[legacyIdx]!, source: inc.source };
      continue;
    }
    merged.push(inc);
    added++;
  }

  return { merged, report: { added, matched, legacyMatched } };
}
