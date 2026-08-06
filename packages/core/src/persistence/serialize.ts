/**
 * Deterministic serialization. Object keys are emitted in sorted order and
 * collections are sorted by id by the callers, so the same data always produces
 * byte-identical output. That is what makes file diffs meaningful and a future
 * three-way sync merge tractable.
 */

/** Recursively sort object keys so JSON output is stable. Arrays keep order. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue; // omit undefined for stable output
      out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Pretty, stable JSON for small slowly-changing collections. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

/** Compact, stable single-line JSON (one NDJSON record). */
function stableJsonLine(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/** Serialize an array of records as NDJSON (one stable line each). */
export function toNdjson(records: readonly unknown[]): string {
  if (records.length === 0) return "";
  return records.map(stableJsonLine).join("\n") + "\n";
}

/** Parse NDJSON into raw objects, skipping blank lines. Throws on malformed JSON. */
export function fromNdjson(text: string): unknown[] {
  const out: unknown[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch (err) {
      throw new Error(`Malformed NDJSON on line ${i + 1}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Stable sort a copy of records by their `id` field. */
export function byId<T extends { id: string }>(records: readonly T[]): T[] {
  return [...records].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
