import { fold } from "./normalize.js";
import { newId, type Ulid } from "../ids.js";
import type { Cents } from "../money.js";
import type { SplitLine, Transaction } from "../model/types.js";
import type { AccountsResult } from "./accounts.js";
import type { CategoriesResult } from "./categories.js";
import type { ImportConfig } from "./config.js";
import { assignIdentities, naturalKeyOf } from "./identity.js";
import type { StagedTxn } from "./staged.js";

export interface ResolveResult {
  transactions: Transaction[];
  unresolvedAccounts: number;
  unresolvedCategories: number;
}

/** Canonical category signature for the natural key (order-preserving for splits). */
function categorySignature(t: StagedTxn): string {
  if (t.transfer) return `xfer:${t.transfer.counterAccountFold}`;
  return t.lines.map((l) => `${l.groupFold}/${l.categoryFold}`).join("+");
}

export function resolveTransactions(
  staged: readonly StagedTxn[],
  accounts: AccountsResult,
  categories: CategoriesResult,
  config: ImportConfig,
): ResolveResult {
  const householdOf = new Map(config.sources.map((s) => [s.sourceKey, s.household]));

  // Natural keys + stable identities across the whole snapshot.
  const withKeys = staged.map((t) => ({
    t,
    naturalKey: naturalKeyOf({
      sourceKey: t.sourceKey,
      accountFold: t.accountFold,
      date: t.date,
      amount: t.amount,
      payeeFold: t.payeeFold,
      categoryFold: categorySignature(t),
      memoFold: fold(t.memo),
    }),
    sourceRow: t.sourceRows[0]!,
  }));
  const identified = assignIdentities(withKeys);

  // Map staged transfer pair keys -> a single ULID per transfer.
  const pairIdByStaged = new Map<string, Ulid>();
  const pairIdFor = (stagedPairId: string): Ulid => {
    let id = pairIdByStaged.get(stagedPairId);
    if (!id) pairIdByStaged.set(stagedPairId, (id = newId()));
    return id;
  };

  let unresolvedAccounts = 0;
  let unresolvedCategories = 0;

  const transactions: Transaction[] = identified.map(({ t, naturalKey, occurrenceIndex, identity }) => {
    const household = householdOf.get(t.sourceKey) ?? t.sourceKey;
    const accountId = accounts.resolve(t.sourceKey, t.accountFold);
    if (!accountId) unresolvedAccounts++;

    const base: Transaction = {
      id: newId(),
      accountId: accountId ?? ("" as Ulid),
      date: t.date,
      effectiveDate: t.effectiveDate,
      payee: t.payee,
      memo: t.memo,
      amount: t.amount as Cents,
      cleared: t.cleared,
      approved: t.approved,
      ...(t.flag ? { flag: t.flag } : {}),
      source: {
        sourceBudget: t.sourceKey,
        naturalKey,
        occurrenceIndex,
        identity,
        firstSeenExportTs: config.exportDate,
        lastSeenExportTs: config.exportDate,
      },
    };

    // Transfer leg.
    if (t.transfer) {
      const counterAccountId = accounts.resolve(t.transfer.counterSourceKey, t.transfer.counterAccountFold);
      if (counterAccountId) {
        base.transfer = { counterAccountId, pairId: pairIdFor(t.transfer.pairId) };
      }
      // If the counter account can't be resolved, leave it uncategorized (no transfer).
      return base;
    }

    // Categorized: single line or split.
    const resolveLine = (groupFold: string, categoryFold: string): Ulid | undefined => {
      if (!groupFold || !categoryFold) return undefined;
      const id = categories.resolveCategory(household, groupFold, categoryFold);
      if (!id) unresolvedCategories++;
      return id;
    };

    if (t.lines.length === 1) {
      const line = t.lines[0]!;
      const categoryId = resolveLine(line.groupFold, line.categoryFold);
      if (categoryId) base.categoryId = categoryId;
      return base;
    }

    if (t.lines.length > 1) {
      base.splits = t.lines.map((line): SplitLine => {
        const categoryId = resolveLine(line.groupFold, line.categoryFold);
        return {
          id: newId(),
          amount: line.amount as Cents,
          memo: line.memo,
          ...(categoryId ? { categoryId } : {}),
        };
      });
      return base;
    }

    // No lines and not a transfer => uncategorized (e.g. starting balance).
    return base;
  });

  return { transactions, unresolvedAccounts, unresolvedCategories };
}
