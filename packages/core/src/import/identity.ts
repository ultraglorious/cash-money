import { fingerprint, type Fingerprint } from "../ids.js";

/**
 * Content-based identity for imported rows. Because the export has no stable IDs,
 * two rows are "the same transaction" iff their natural key matches; genuine
 * duplicates (identical natural key) are told apart by a stable occurrence index
 * — the rank among same-key rows in source-file order, which is reproducible
 * across full re-exports. This is what makes re-import idempotent.
 */

export interface NaturalKeyFields {
  sourceKey: string;
  accountFold: string;
  date: string;
  amount: number;
  payeeFold: string;
  categoryFold: string;
  memoFold: string;
}

export function naturalKeyOf(f: NaturalKeyFields): Fingerprint {
  return fingerprint([
    "TXN",
    f.sourceKey,
    f.accountFold,
    f.date,
    f.amount,
    f.payeeFold,
    f.categoryFold,
    f.memoFold,
  ]);
}

export function identityOf(naturalKey: Fingerprint, occurrenceIndex: number): Fingerprint {
  return fingerprint([naturalKey, occurrenceIndex]);
}

export interface Identified {
  naturalKey: Fingerprint;
  occurrenceIndex: number;
  identity: Fingerprint;
}

/**
 * Assigns a stable occurrence index and identity to each item. Items sharing a
 * natural key are ranked by source-file order, so the same snapshot always
 * yields the same identities regardless of the order items are passed in.
 */
export function assignIdentities<T extends { naturalKey: Fingerprint; sourceRow: number }>(
  items: readonly T[],
): Array<T & Identified> {
  const byKey = new Map<string, T[]>();
  for (const it of items) {
    const list = byKey.get(it.naturalKey);
    if (list) list.push(it);
    else byKey.set(it.naturalKey, [it]);
  }

  const index = new Map<T, number>();
  for (const list of byKey.values()) {
    list.sort((a, b) => a.sourceRow - b.sourceRow);
    list.forEach((it, i) => index.set(it, i));
  }

  return items.map((it) => {
    const occurrenceIndex = index.get(it)!;
    return { ...it, occurrenceIndex, identity: identityOf(it.naturalKey, occurrenceIndex) };
  });
}
