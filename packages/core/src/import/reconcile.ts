import type { Transaction } from "../model/types.js";

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
