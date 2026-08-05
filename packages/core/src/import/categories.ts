import { newId, type Ulid } from "../ids.js";
import type { Account, Category, CategoryGroup, CategoryGroupKind } from "../model/types.js";
import type { AccountsResult } from "./accounts.js";
import { householdBySource, type ImportConfig } from "./config.js";
import type { NormPlan } from "./planCsv.js";
import type { StagedTxn } from "./staged.js";
import { SEP } from "./text.js";

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
  report: { groupsCreated: number; categoriesCreated: number; creditCardLinks: number };
}

/**
 * Builds the unified category tree. Same-named groups from different households
 * are kept separate (tagged by household). Group kind and hiddenness come from
 * the semantics stamps set at normalize time — no format vocabulary lives here.
 * Each credit-card payment category is linked to its card account via the
 * category's linkedAccountId.
 */
export function buildCategories(
  staged: readonly StagedTxn[],
  plan: readonly NormPlan[],
  config: ImportConfig,
  accounts: AccountsResult,
): CategoriesResult {
  const householdOf = householdBySource(config);
  const sourcesByHousehold = new Map<string, string[]>();
  for (const s of config.sources) {
    (sourcesByHousehold.get(s.household) ?? sourcesByHousehold.set(s.household, []).get(s.household)!).push(s.sourceKey);
  }

  const groupSeeds = new Map<string, GroupSeed>();
  const catSeeds = new Map<string, CatSeed>();

  const noteGroup = (
    household: string,
    groupFold: string,
    name: string,
    kind: CategoryGroupKind,
    hidden: boolean,
  ): void => {
    if (!groupFold) return;
    const key = household + SEP + groupFold;
    if (!groupSeeds.has(key)) {
      groupSeeds.set(key, { household, groupFold, name, kind, hidden });
    }
  };
  const noteCat = (
    household: string,
    groupFold: string,
    catFold: string,
    name: string,
    hidden: boolean,
  ): void => {
    if (!groupFold || !catFold) return;
    const key = household + SEP + groupFold + SEP + catFold;
    if (!catSeeds.has(key)) {
      catSeeds.set(key, { household, groupFold, categoryFold: catFold, name, hidden });
    }
  };

  // From transactions (each categorized line) ...
  for (const t of staged) {
    const household = householdOf.get(t.sourceKey) ?? t.sourceKey;
    for (const line of t.lines) {
      noteGroup(household, line.groupFold, line.group, line.groupKind ?? "normal", line.groupHidden ?? false);
      noteCat(household, line.groupFold, line.categoryFold, line.category, line.groupHidden ?? false);
    }
  }
  // ... and from the plan grid (dense: every category × month).
  for (const p of plan) {
    const household = householdOf.get(p.sourceKey) ?? p.sourceKey;
    noteGroup(household, p.groupFold, p.group, p.groupKind ?? "normal", p.groupHidden ?? false);
    noteCat(household, p.groupFold, p.categoryFold, p.category, p.groupHidden ?? false);
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
    if (groupSeeds.get(s.household + SEP + s.groupFold)?.kind === "creditCardPayments") {
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
    report: {
      groupsCreated: groups.length,
      categoriesCreated: categories.length,
      creditCardLinks,
    },
  };
}
