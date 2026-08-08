import { computeProjection, type Projection } from "./engine/compute.js";
import type { Ulid } from "./ids.js";
import type { Cents } from "./money.js";
import type { LoadedBudget } from "./model/types.js";
import type { MonthKey } from "./time.js";

/**
 * Proving that an edit only described money rather than moving it.
 *
 * Some operations touch thousands of rows and promise to change nothing you can
 * see — linking imported transfers is the obvious one. That promise used to
 * rest on tests remembering every shape real data can take, which is a promise
 * about the author's imagination. This checks it against the data in hand: run
 * the projection before and after and compare everything a person would notice.
 *
 * Cheap enough to run inline (two projections over years of transactions is
 * milliseconds), so the caller can refuse an edit that drifts instead of
 * discovering it a week later in a wrong Ready-to-Assign.
 */
export interface Drift {
  kind: "readyToAssign" | "available" | "balance";
  /** Household, category id or account id, depending on `kind`. */
  key: string;
  month?: MonthKey;
  before: Cents;
  after: Cents;
}

/** Cap the report: a caller only needs to know THAT it drifted, plus examples. */
const MAX_DRIFT = 20;

export function projectionDrift(before: LoadedBudget, after: LoadedBudget): Drift[] {
  return compareProjections(computeProjection(before), computeProjection(after), after);
}

export function compareProjections(a: Projection, b: Projection, shape: LoadedBudget): Drift[] {
  const out: Drift[] = [];
  const add = (d: Drift) => {
    if (out.length < MAX_DRIFT) out.push(d);
  };

  const months = [...new Set([...a.months, ...b.months])].sort();
  const households = [...new Set([...a.households, ...b.households])];
  for (const month of months) {
    const ra = a.readyToAssignByHousehold(month);
    const rb = b.readyToAssignByHousehold(month);
    for (const h of households) {
      const x = ra.get(h) ?? (0 as Cents);
      const y = rb.get(h) ?? (0 as Cents);
      if (x !== y) add({ kind: "readyToAssign", key: h, month, before: x, after: y });
    }
    for (const c of shape.categories) {
      const x = a.availableOf(c.id, month);
      const y = b.availableOf(c.id, month);
      if (x !== y) add({ kind: "available", key: c.id, month, before: x, after: y });
    }
  }

  const ba = a.accountBalances();
  const bb = b.accountBalances();
  for (const id of new Set<Ulid>([...ba.keys(), ...bb.keys()])) {
    const x = ba.get(id) ?? (0 as Cents);
    const y = bb.get(id) ?? (0 as Cents);
    if (x !== y) add({ kind: "balance", key: id, before: x, after: y });
  }

  return out;
}

/**
 * Run an edit that must not move money, and hand back the drift if it did.
 * `budget` is unchanged when anything drifted — the caller decides what to say,
 * but the bad edit never reaches the app.
 */
export function applyPreservingNumbers(
  before: LoadedBudget,
  edit: (b: LoadedBudget) => LoadedBudget,
): { budget: LoadedBudget; drift: Drift[] } {
  const after = edit(before);
  const drift = projectionDrift(before, after);
  return drift.length > 0 ? { budget: before, drift } : { budget: after, drift: [] };
}
