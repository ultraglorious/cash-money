import type { Ulid } from "../ids.js";
import type { Category, CategoryGroup, LoadedBudget } from "../model/types.js";

/**
 * Resolves the relationship between credit-card accounts and their payment
 * categories. A payment category lives in a `creditCardPayments` group and is
 * linked to exactly one credit-card account.
 */
export interface CreditCardMap {
  /** categoryIds that are credit-card payment categories. */
  paymentCategoryIds: Set<Ulid>;
  /** cardAccountId -> its payment categoryId. */
  paymentCategoryByCard: Map<Ulid, Ulid>;
  /** cardAccountId set. */
  cardAccountIds: Set<Ulid>;
}

export function mapCreditCards(budget: LoadedBudget): CreditCardMap {
  const groupKind = new Map<Ulid, CategoryGroup["kind"]>();
  for (const g of budget.groups) groupKind.set(g.id, g.kind);

  const cardAccountIds = new Set<Ulid>();
  for (const a of budget.accounts) {
    if (a.type === "creditCard") cardAccountIds.add(a.id);
  }

  const paymentCategoryIds = new Set<Ulid>();
  const paymentCategoryByCard = new Map<Ulid, Ulid>();
  for (const c of budget.categories) {
    if (groupKind.get(c.groupId) === "creditCardPayments") {
      paymentCategoryIds.add(c.id);
      if (c.linkedAccountId) paymentCategoryByCard.set(c.linkedAccountId, c.id);
    }
  }

  return { paymentCategoryIds, paymentCategoryByCard, cardAccountIds };
}

export function isPaymentCategory(cc: CreditCardMap, categoryId: Ulid): boolean {
  return cc.paymentCategoryIds.has(categoryId);
}

export function isCardAccount(cc: CreditCardMap, accountId: Ulid): boolean {
  return cc.cardAccountIds.has(accountId);
}

/** Group-kind lookup used by the engine to classify categories. */
export function groupKindByCategory(budget: LoadedBudget): Map<Ulid, CategoryGroup["kind"]> {
  const kindByGroup = new Map<Ulid, CategoryGroup["kind"]>();
  for (const g of budget.groups) kindByGroup.set(g.id, g.kind);
  const out = new Map<Ulid, CategoryGroup["kind"]>();
  for (const c of budget.categories) {
    out.set(c.id, kindByGroup.get(c.groupId) ?? "normal");
  }
  return out;
}

export function categoriesByGroup(budget: LoadedBudget): Map<Ulid, Category[]> {
  const out = new Map<Ulid, Category[]>();
  for (const c of budget.categories) {
    const list = out.get(c.groupId);
    if (list) list.push(c);
    else out.set(c.groupId, [c]);
  }
  for (const list of out.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
  return out;
}
