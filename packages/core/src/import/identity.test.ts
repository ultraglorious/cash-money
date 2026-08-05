import { describe, expect, it } from "vitest";
import { assignIdentities, naturalKeyOf } from "./identity.js";

function key(memo: string) {
  return naturalKeyOf({
    sourceKey: "s1",
    accountFold: "checking",
    date: "2026-01-15",
    amount: -500,
    payeeFold: "coffee",
    categoryFold: "everyday: dining",
    memoFold: memo,
  });
}

describe("assignIdentities", () => {
  it("gives identical rows stable, distinct occurrence indices", () => {
    const items = [
      { naturalKey: key(""), sourceRow: 10 },
      { naturalKey: key(""), sourceRow: 5 },
      { naturalKey: key("tip"), sourceRow: 7 },
    ];
    const out = assignIdentities(items);

    // The two identical-key rows get indices by source order (5 -> 0, 10 -> 1).
    const bySource = new Map(out.map((o) => [o.sourceRow, o]));
    expect(bySource.get(5)!.occurrenceIndex).toBe(0);
    expect(bySource.get(10)!.occurrenceIndex).toBe(1);
    expect(bySource.get(7)!.occurrenceIndex).toBe(0);

    // Distinct identities for the two duplicates; deterministic.
    expect(bySource.get(5)!.identity).not.toBe(bySource.get(10)!.identity);
  });

  it("is order-independent (same result regardless of input order)", () => {
    const a = assignIdentities([
      { naturalKey: key(""), sourceRow: 10 },
      { naturalKey: key(""), sourceRow: 5 },
    ]);
    const b = assignIdentities([
      { naturalKey: key(""), sourceRow: 5 },
      { naturalKey: key(""), sourceRow: 10 },
    ]);
    const idOf = (rows: typeof a, sr: number) => rows.find((r) => r.sourceRow === sr)!.identity;
    expect(idOf(a, 5)).toBe(idOf(b, 5));
    expect(idOf(a, 10)).toBe(idOf(b, 10));
  });

  it("different content yields different natural keys", () => {
    expect(key("a")).not.toBe(key("b"));
  });
});
