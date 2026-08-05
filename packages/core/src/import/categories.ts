import { newId, type Ulid } from "../ids.js";
import type { Account, Category, CategoryGroup, CategoryGroupKind } from "../model/types.js";
import type { AccountsResult } from "./accounts.js";
import type { ImportConfig } from "./config.js";
import type { NormPlan } from "./normalize.js";
import type { StagedTxn } from "./staged.js";

const SEP = "␟";
const HIDDEN_GROUP_FOLD = "hidden categories";
const INCOME_GROUP_FOLD = "inflow";
const CC_GROUP_FOLD = "credit card payments";

function groupKindOf(groupFold: string): CategoryGroupKind {
  if (groupFold === INCOME_GROUP_FOLD) return "income";
  if (groupFold === CC_GROUP_FOLD) return "creditCardPayments";
  return "normal";
}

interface GroupSeed {
  household: string;
  groupFold: string;
  name: string;
  kind: CategoryGroupKind;
  hidden: boolean;
}
interface CatSeed {
  household: string;
  groupFold: string;
  categoryFold: string;
  name: string;
  hidden: boolean;
}

export interface CategoriesResult {
  groups: CategoryGroup[];
  categories: Category[];
  resolveCategory(household: string, groupFold: string, categoryFold: string): Ulid | undefined;
  resolveIncome(household: string): Ulid | undefined;
  report: { groupsCreated: number; categoriesCreated: number; creditCardLinks: number };
}

/**
 * Builds the unified category tree. Same-named groups from different households
 * are kept separate (tagged by household); "Hidden Categories" becomes a hidden
 * flag; the income group hosts the inflow bucket; and each credit-card payment
 * category is linked to its card account via the category's linkedAccountId.
 */
export function buildCategories(
  staged: readonly StagedTxn[],
  plan: readonly NormPlan[],
  config: ImportConfig,
  accounts: AccountsResult,
): CategoriesResult {
  const householdOf = new Map<string, string>();
  const sourcesByHousehold = new Map<string, string[]>();
  for (const s of config.sources) {
    householdOf.set(s.sourceKey, s.household);
    (sourcesByHousehold.get(s.household) ?? sourcesByHousehold.set(s.household, []).get(s.household)!).push(s.sourceKey);
  }

  const groupSeeds = new Map<string, GroupSeed>();
  const catSeeds = new Map<string, CatSeed>();

  const noteGroup = (household: string, groupFold: string, name: string): void => {
    if (!groupFold) return;
    const key = household + SEP + groupFold;
    if (!groupSeeds.has(key)) {
      groupSeeds.set(key, {
        household,
        groupFold,
        name,
        kind: groupKindOf(groupFold),
        hidden: groupFold === HIDDEN_GROUP_FOLD,
      });
    }
  };
  const noteCat = (household: string, groupFold: string, catFold: string, name: string): void => {
    if (!groupFold || !catFold) return;
    const key = household + SEP + groupFold + SEP + catFold;
    if (!catSeeds.has(key)) {
      catSeeds.set(key, {
        household,
        groupFold,
        categoryFold: catFold,
        name,
        hidden: groupFold === HIDDEN_GROUP_FOLD,
      });
    }
  };

  // From transactions (each categorized line) ...
  for (const t of staged) {
    const household = householdOf.get(t.sourceKey) ?? t.sourceKey;
    for (const line of t.lines) {
      noteGroup(household, line.groupFold, line.group);
      noteCat(household, line.groupFold, line.categoryFold, line.category);
    }
  }
  // ... and from the plan grid (dense: every category × month).
  for (const p of plan) {
    const household = householdOf.get(p.sourceKey) ?? p.sourceKey;
    noteGroup(household, p.groupFold, p.group);
    noteCat(household, p.groupFold, p.categoryFold, p.category);
  }

  // Materialize groups.
  const groupIdByKey = new Map<string, Ulid>();
  const groups: CategoryGroup[] = [];
  let gOrder = 0;
  for (const key of [...groupSeeds.keys()].sort()) {
    const s = groupSeeds.get(key)!;
    const id = newId();
    groupIdByKey.set(key, id);
    groups.push({
      id,
      name: s.name || s.groupFold,
      household: s.household,
      kind: s.kind,
      sortOrder: gOrder++,
      hidden: s.hidden,
    });
  }

  // Materialize categories.
  const catIdByKey = new Map<string, Ulid>();
  const categories: Category[] = [];
  let cOrder = 0;
  let creditCardLinks = 0;
  for (const key of [...catSeeds.keys()].sort()) {
    const s = catSeeds.get(key)!;
    const groupId = groupIdByKey.get(s.household + SEP + s.groupFold)!;
    const id = newId();
    catIdByKey.set(key, id);

    // Link credit-card payment categories to their card account.
    let linkedAccountId: Ulid | undefined;
    if (groupKindOf(s.groupFold) === "creditCardPayments") {
      for (const sourceKey of sourcesByHousehold.get(s.household) ?? []) {
        const acc = accounts.resolve(sourceKey, s.categoryFold);
        if (acc) {
          linkedAccountId = acc;
          break;
        }
      }
    }

    categories.push({
      id,
      groupId,
      name: s.name || s.categoryFold,
      sortOrder: cOrder++,
      hidden: s.hidden,
      ...(linkedAccountId ? { linkedAccountId } : {}),
    });
    if (linkedAccountId) creditCardLinks++;
  }

  // Set the payment-category back-reference on the card accounts. An account a
  // payment category points at is, by definition, a credit card — so ensure its
  // type reflects that even if the name didn't signal it.
  const accountById = new Map<Ulid, Account>(accounts.accounts.map((a) => [a.id, a]));
  for (const c of categories) {
    if (c.linkedAccountId) {
      const acc = accountById.get(c.linkedAccountId);
      if (acc) {
        acc.type = "creditCard";
        acc.onBudget = true;
      }
    }
  }

  const catKey = (household: string, groupFold: string, categoryFold: string): string =>
    household + SEP + groupFold + SEP + categoryFold;

  return {
    groups,
    categories,
    resolveCategory: (household, groupFold, categoryFold) =>
      catIdByKey.get(catKey(household, groupFold, categoryFold)),
    resolveIncome: (household) => catIdByKey.get(catKey(household, INCOME_GROUP_FOLD, "ready to assign")),
    report: {
      groupsCreated: groups.length,
      categoriesCreated: categories.length,
      creditCardLinks,
    },
  };
}
