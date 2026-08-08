import type { Cents } from "./money.js";
import type { Ulid } from "./ids.js";
import type { ISODate } from "./time.js";
import type { LoadedBudget, Transaction } from "./model/types.js";
import { fold } from "./import/text.js";

/**
 * Finding the transfers hiding in imported data.
 *
 * A transfer between two budgets arrives as two unrelated rows: a categorised
 * expense in the sending budget's export and an income row in the receiving
 * one. Nothing links them, so the register calls them by whatever payee the
 * source wrote. This finds those pairs so they can be linked in one go instead
 * of edited by hand.
 *
 * Only pairs that CROSS a budget scope are offered — different households, or
 * one side an off-budget tracking account. Transfers inside one budget already
 * arrive linked from the export (see import/transfers.ts), and pairing two rows
 * within one scope would be a change of meaning rather than a repair.
 *
 * Linking is deliberately NOT the old cross-budget "stitch" that was removed:
 * nothing is merged or dropped. Both rows stay, the sending leg keeps its
 * funding envelope, and the receiving leg keeps its cash. Every number the
 * engine derives is identical before and after (see ops.linkTransfers).
 */

export type PairConfidence = "high" | "medium" | "low";

export interface TransferCandidate {
  /** The leg money left (negative amount). */
  outflowId: Ulid;
  /** The leg money arrived on (positive amount). */
  inflowId: Ulid;
  outflowAccountId: Ulid;
  inflowAccountId: Ulid;
  /** Magnitude; both legs are exactly this far apart from zero. */
  amount: Cents;
  outflowDate: ISODate;
  inflowDate: ISODate;
  /** Whole days between the two legs. */
  dayGap: number;
  confidence: PairConfidence;
  /** Why it matched, shown in the review list. */
  reason: string;
}

export interface PairingOptions {
  /** How far apart the two legs may be dated. */
  maxDays?: number;
}

const DEFAULT_MAX_DAYS = 10;
/** Beyond this, a match is only as good as its supporting evidence. */
const CLOSE_DAYS = 3;

const epochDay = (iso: ISODate): number => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86_400_000);

/** A budget scope: one household's on-budget accounts. Tracking accounts are in none. */
function scopeOf(a: { onBudget: boolean; household?: string }): string {
  return a.onBudget ? `hh:${a.household ?? ""}` : "no-budget";
}

/** Does either leg's text name the other account, or the household it sits in? */
function namesTheOtherSide(a: Transaction, aScope: { name: string; household?: string }, b: Transaction, bScope: { name: string; household?: string }): boolean {
  const mentions = (t: Transaction, other: { name: string; household?: string }): boolean => {
    const hay = fold(`${t.payee} ${t.memo}`);
    const needles = [other.name, other.household].filter((s): s is string => !!s && s.trim().length > 2);
    return needles.some((n) => hay.includes(fold(n)));
  };
  return mentions(a, bScope) || mentions(b, aScope);
}

/**
 * Every equal-and-opposite pair that crosses a budget scope, best matches
 * first, each row used at most once.
 *
 * Confidence is about evidence, not arithmetic — two unrelated rows of the same
 * size a day apart look exactly like a transfer, so a same-size coincidence
 * alone never reaches `high`:
 *  - **high** — one leg names the other account or household, or the receiving
 *    account is off-budget (money you moved to yourself).
 *  - **medium** — the cross-budget funding shape: a categorised outflow meeting
 *    an income row within a few days.
 *  - **low** — same amount, opposite directions, nothing else to go on.
 */
export function findTransferCandidates(b: LoadedBudget, opts: PairingOptions = {}): TransferCandidate[] {
  const maxDays = opts.maxDays ?? DEFAULT_MAX_DAYS;
  const accounts = new Map(b.accounts.map((a) => [a.id, a]));
  const incomeGroups = new Set(b.groups.filter((g) => g.kind === "income").map((g) => g.id));
  const incomeCats = new Set(b.categories.filter((c) => incomeGroups.has(c.groupId)).map((c) => c.id));

  // A leg on a credit card is never offered: the engine reads money arriving on
  // a card as a payment and draws down that card's payment envelope, so linking
  // one would move money rather than just describe it.
  const eligible = (t: Transaction): boolean =>
    t.approved && !t.transfer && !t.splits && accounts.get(t.accountId)?.type !== "creditCard";
  const outflows = b.transactions.filter((t) => eligible(t) && t.amount < 0);

  // Inflows indexed by magnitude: the only pairs worth scoring are exact matches.
  const inflowsByAmount = new Map<number, Transaction[]>();
  for (const t of b.transactions) {
    if (!eligible(t) || t.amount <= 0) continue;
    // Money arriving against a spending envelope is a REFUND, not a transfer:
    // the category is the whole point of the row, and treating it as an arriving
    // leg would strip it and hand the money back to Ready-to-Assign. Only bare
    // inflows and income ones can be the receiving half of a transfer.
    if (t.categoryId && !incomeCats.has(t.categoryId)) continue;
    const list = inflowsByAmount.get(t.amount) ?? [];
    list.push(t);
    inflowsByAmount.set(t.amount, list);
  }

  const scored: (TransferCandidate & { rank: number })[] = [];
  for (const out of outflows) {
    const outAcc = accounts.get(out.accountId)!;
    const outDay = epochDay(out.date);
    for (const inn of inflowsByAmount.get(-out.amount) ?? []) {
      const inAcc = accounts.get(inn.accountId)!;
      if (inAcc.id === outAcc.id) continue;
      if (scopeOf(outAcc) === scopeOf(inAcc)) continue; // same budget: already linked at import
      const dayGap = Math.abs(epochDay(inn.date) - outDay);
      if (dayGap > maxDays) continue;

      const named = namesTheOtherSide(out, outAcc, inn, inAcc);
      const toSelfOffBudget = !inAcc.onBudget || !outAcc.onBudget;
      const fundingShape =
        !!out.categoryId && !incomeCats.has(out.categoryId) && !!inn.categoryId && incomeCats.has(inn.categoryId);

      let confidence: PairConfidence;
      let reason: string;
      if (named) {
        confidence = "high";
        reason = "one side names the other account";
      } else if (toSelfOffBudget && dayGap <= CLOSE_DAYS) {
        confidence = "high";
        reason = "moved to an account outside the budget";
      } else if (fundingShape && dayGap <= CLOSE_DAYS) {
        confidence = "medium";
        reason = "spent from an envelope here, arrived as income there";
      } else if (fundingShape || toSelfOffBudget) {
        confidence = "medium";
        reason = `${dayGap} days apart, but the shape fits`;
      } else {
        confidence = "low";
        reason = "same amount, opposite directions — nothing else to go on";
      }

      const rank = ({ high: 0, medium: 1, low: 2 } as const)[confidence] * 1000 + dayGap;
      scored.push({
        outflowId: out.id,
        inflowId: inn.id,
        outflowAccountId: out.accountId,
        inflowAccountId: inn.accountId,
        amount: -out.amount as Cents,
        outflowDate: out.date,
        inflowDate: inn.date,
        dayGap,
        confidence,
        reason,
        rank,
      });
    }
  }

  // Best first, then greedily hand out rows — a row belongs to one transfer.
  // Ties (two equally good partners) are demoted: which one is right is exactly
  // the judgement a person should make, so it must not be pre-ticked.
  scored.sort((x, y) => x.rank - y.rank || x.outflowDate.localeCompare(y.outflowDate) || x.outflowId.localeCompare(y.outflowId));
  const tiedRank = new Set<string>();
  for (const [key, count] of countBy(scored, (c) => `${c.outflowId}|${c.rank}`)) if (count > 1) tiedRank.add(key);
  for (const [key, count] of countBy(scored, (c) => `${c.inflowId}|${c.rank}`)) if (count > 1) tiedRank.add(key);

  const used = new Set<Ulid>();
  const out: TransferCandidate[] = [];
  for (const c of scored) {
    if (used.has(c.outflowId) || used.has(c.inflowId)) continue;
    used.add(c.outflowId);
    used.add(c.inflowId);
    const ambiguous = tiedRank.has(`${c.outflowId}|${c.rank}`) || tiedRank.has(`${c.inflowId}|${c.rank}`);
    const { rank: _rank, ...rest } = c;
    out.push(
      ambiguous && c.confidence === "high"
        ? { ...rest, confidence: "medium", reason: `${c.reason} — but another row matches just as well` }
        : rest,
    );
  }
  return out;
}

function countBy<T>(items: readonly T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of items) m.set(key(t), (m.get(key(t)) ?? 0) + 1);
  return m;
}
