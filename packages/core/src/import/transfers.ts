import { fingerprint } from "../ids.js";
import type { StagedTxn } from "./staged.js";

/**
 * Turns transfer rows into linked transfer legs.
 *
 * Within a budget, the CSV export writes a transfer as two mirrored `Transfer : X` rows;
 * we pair them and give both a shared pairId.
 *
 * Money moving BETWEEN budgets (recorded as a plain payee on each side) is
 * deliberately NOT stitched into one transfer. The source budgets fund each
 * other through a category — the sender assigns to a funding envelope and
 * spends from it, the receiver books the inflow as income. Collapsing the two
 * sides into a transfer makes both claim the same money and collapses
 * Ready-to-Assign to a large negative under the conservation-based engine.
 * (A stitch implementation existed and was removed; see the git history and
 * issue #8 before reintroducing anything like it.)
 */

export interface TransferReport {
  withinPairs: number;
  /** Within-budget transfer legs that couldn't be paired (kept one-sided). */
  withinUnpaired: number;
}

function linkLegs(a: StagedTxn, b: StagedTxn, prefix: string): void {
  const pairId = fingerprint([
    prefix,
    ...[`${a.sourceKey}:${a.sourceRows.join(",")}`, `${b.sourceKey}:${b.sourceRows.join(",")}`].sort(),
  ]);
  a.kind = "transfer";
  a.lines = [];
  a.transfer = {
    counterSourceKey: b.sourceKey,
    counterAccount: b.account,
    counterAccountFold: b.accountFold,
    pairId,
  };
  b.kind = "transfer";
  b.lines = [];
  b.transfer = {
    counterSourceKey: a.sourceKey,
    counterAccount: a.account,
    counterAccountFold: a.accountFold,
    pairId,
  };
}

export function dedupeWithinTransfers(staged: StagedTxn[]): {
  pairs: number;
  unpaired: number;
} {
  const legs = staged.filter((t) => t.kind === "withinTransfer");
  const groups = new Map<string, StagedTxn[]>();
  for (const leg of legs) {
    // The counterpart account name is stamped on the leg by the parser
    // (format-specific recognition happens there, never here).
    const counter = leg.counterAccountFold ?? "";
    const accounts = [leg.accountFold, counter].sort().join("~");
    const key = `${leg.sourceKey}|${leg.date}|${accounts}|${Math.abs(leg.amount)}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(leg);
  }

  let pairs = 0;
  let unpaired = 0;
  for (const group of groups.values()) {
    const outs = group.filter((t) => t.amount < 0).sort((a, b) => a.sourceRows[0]! - b.sourceRows[0]!);
    const ins = group.filter((t) => t.amount > 0).sort((a, b) => a.sourceRows[0]! - b.sourceRows[0]!);
    const n = Math.min(outs.length, ins.length);
    for (let i = 0; i < n; i++) {
      linkLegs(outs[i]!, ins[i]!, "PAIR");
      pairs++;
    }
    // Leftover one-sided legs: keep as a transfer leg with the stamped counter.
    for (const leg of [...outs.slice(n), ...ins.slice(n)]) {
      leg.kind = "transfer";
      leg.lines = [];
      leg.transfer = {
        counterSourceKey: leg.sourceKey,
        counterAccount: leg.counterAccount ?? "",
        counterAccountFold: leg.counterAccountFold ?? "",
        pairId: fingerprint(["PAIR-ORPHAN", leg.sourceKey, leg.sourceRows.join(",")]),
      };
      leg.warnings = [...(leg.warnings ?? []), "unpaired within-budget transfer leg"];
      unpaired++;
    }
  }
  return { pairs, unpaired };
}

/** Runs within-budget transfer dedupe across all sources. */
export function reconstructTransfers(staged: StagedTxn[]): TransferReport {
  const within = dedupeWithinTransfers(staged);
  return {
    withinPairs: within.pairs,
    withinUnpaired: within.unpaired,
  };
}
