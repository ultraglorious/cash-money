import { fingerprint } from "../ids.js";
import { fold } from "./normalize.js";
import type { StagedTxn } from "./staged.js";
import type { StitchRule } from "./config.js";

/**
 * Turns transfer rows into linked transfer legs.
 *
 * Within a budget, the CSV export writes a transfer as two mirrored `Transfer : X` rows;
 * we pair them and give both a shared pairId. Across budgets, money movements are
 * recorded independently on each side as a plain payee (named in a StitchRule);
 * we pair those by equal-and-opposite amount and nearest date within a window,
 * mutually exclusively, and collapse each pair into one linked transfer. Rows
 * whose payee is not named in a rule are never stitched (the false-positive
 * guard), and unmatched rows are left as ordinary transactions.
 */

export interface TransferReport {
  withinPairs: number;
  /** Within-budget transfer legs that couldn't be paired (kept one-sided). */
  withinUnpaired: number;
  crossMatched: number;
  crossUnmatched: number;
  /** Δdays -> count for matched cross-budget pairs. */
  crossDeltaHistogram: Record<number, number>;
}

function counterFromPayee(payee: string): string {
  return payee.replace(/^transfer\s*:/i, "").trim();
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
    const counter = fold(counterFromPayee(leg.payee));
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
    // Leftover one-sided legs: keep as a transfer leg with the payee-named counter.
    for (const leg of [...outs.slice(n), ...ins.slice(n)]) {
      leg.kind = "transfer";
      leg.lines = [];
      const counter = counterFromPayee(leg.payee);
      leg.transfer = {
        counterSourceKey: leg.sourceKey,
        counterAccount: counter,
        counterAccountFold: fold(counter),
        pairId: fingerprint(["PAIR-ORPHAN", leg.sourceKey, leg.sourceRows.join(",")]),
      };
      leg.warnings = [...(leg.warnings ?? []), "unpaired within-budget transfer leg"];
      unpaired++;
    }
  }
  return { pairs, unpaired };
}

export function stitchCrossBudget(
  staged: StagedTxn[],
  rules: readonly StitchRule[],
): { matched: number; unmatched: number; deltaHistogram: Record<number, number> } {
  let matched = 0;
  const deltaHistogram: Record<number, number> = {};
  const stitchable = (t: StagedTxn): boolean => t.kind === "normal" || t.kind === "income";
  const usedA = new Set<StagedTxn>();
  const usedB = new Set<StagedTxn>();

  for (const rule of rules) {
    const aFold = fold(rule.aLinkPayee);
    const bFold = fold(rule.bLinkPayee);
    const aCands = staged.filter(
      (t) => t.sourceKey === rule.aSourceKey && stitchable(t) && t.payeeFold === aFold,
    );
    const bByAmount = new Map<number, StagedTxn[]>();
    for (const t of staged) {
      if (t.sourceKey === rule.bSourceKey && stitchable(t) && t.payeeFold === bFold) {
        (bByAmount.get(t.amount) ?? bByAmount.set(t.amount, []).get(t.amount)!).push(t);
      }
    }

    // Eligible pairs: equal-and-opposite amount, date within window.
    const eligible: Array<{ a: StagedTxn; b: StagedTxn; delta: number }> = [];
    for (const a of aCands) {
      for (const b of bByAmount.get(-a.amount) ?? []) {
        const delta = Math.abs(a.epochDay - b.epochDay);
        if (delta <= rule.windowDays) eligible.push({ a, b, delta });
      }
    }
    // Prefer smallest date gap; deterministic tie-break by source rows.
    eligible.sort(
      (x, y) =>
        x.delta - y.delta ||
        x.a.sourceRows[0]! - y.a.sourceRows[0]! ||
        x.b.sourceRows[0]! - y.b.sourceRows[0]!,
    );
    for (const { a, b, delta } of eligible) {
      if (usedA.has(a) || usedB.has(b)) continue;
      usedA.add(a);
      usedB.add(b);
      linkLegs(a, b, "XPAIR");
      deltaHistogram[delta] = (deltaHistogram[delta] ?? 0) + 1;
      matched++;
    }
  }

  // Count candidates that were named by a rule but never matched.
  const namedA = new Set<StagedTxn>();
  const namedB = new Set<StagedTxn>();
  for (const rule of rules) {
    const aFold = fold(rule.aLinkPayee);
    const bFold = fold(rule.bLinkPayee);
    for (const t of staged) {
      if (t.transfer) continue;
      if (t.sourceKey === rule.aSourceKey && t.payeeFold === aFold) namedA.add(t);
      if (t.sourceKey === rule.bSourceKey && t.payeeFold === bFold) namedB.add(t);
    }
  }
  const unmatched = namedA.size + namedB.size;
  return { matched, unmatched, deltaHistogram };
}

/** Runs within-budget dedupe (all sources) then cross-budget stitch. */
export function reconstructTransfers(
  staged: StagedTxn[],
  rules: readonly StitchRule[],
): TransferReport {
  const within = dedupeWithinTransfers(staged);
  const cross = stitchCrossBudget(staged, rules);
  return {
    withinPairs: within.pairs,
    withinUnpaired: within.unpaired,
    crossMatched: cross.matched,
    crossUnmatched: cross.unmatched,
    crossDeltaHistogram: cross.deltaHistogram,
  };
}
