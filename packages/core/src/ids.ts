import { sha256 } from "js-sha256";
import { ulid } from "ulid";

/** Client-generated, lexicographically-sortable, collision-free unique id. */
export type Ulid = string & { readonly __brand: "Ulid" };

/** A deterministic content fingerprint (hex sha256) used for import identity. */
export type Fingerprint = string & { readonly __brand: "Fingerprint" };

export function newId(): Ulid {
  return ulid() as Ulid;
}

/** Canonical ULID shape — the single source of truth for validation (schema.ts). */
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// Unit separator — a byte that cannot appear in our field values, so joined
// parts are unambiguous and two different tuples can never collide.
const SEP = "␟";

/**
 * Deterministic fingerprint of an ordered list of fields. Stable across runs
 * and machines (pure function of the inputs), which is what makes re-import
 * idempotent despite the absence of stable source IDs in the export.
 */
export function fingerprint(parts: ReadonlyArray<string | number>): Fingerprint {
  return sha256(parts.map((p) => String(p)).join(SEP)) as Fingerprint;
}
