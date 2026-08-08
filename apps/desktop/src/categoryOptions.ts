import type { LoadedBudget } from "@cash-money/core";

export interface GroupedCategoryOptions {
  group: string;
  items: { value: string; label: string }[];
}

/**
 * Non-income categories grouped for a Select. Group labels must be UNIQUE —
 * they double as React keys inside Mantine's dropdown — and two households
 * routinely have same-named sections ("Everyday Expenses"), so collisions get
 * the household appended (and a counter as the last resort).
 */
export function categoryOptions(budget: LoadedBudget): GroupedCategoryOptions[] {
  const groups = budget.groups.filter((g) => g.kind !== "income");
  const nameCount = new Map<string, number>();
  for (const g of groups) nameCount.set(g.name, (nameCount.get(g.name) ?? 0) + 1);

  const used = new Set<string>();
  return groups
    .map((g) => {
      let label = (nameCount.get(g.name) ?? 0) > 1 && g.household ? `${g.name} (${g.household})` : g.name;
      for (let n = 2; used.has(label); n++) label = `${g.name} (${n})`;
      used.add(label);
      return {
        group: label,
        items: budget.categories.filter((c) => c.groupId === g.id).map((c) => ({ value: c.id, label: c.name })),
      };
    })
    .filter((grp) => grp.items.length > 0);
}

/**
 * The income categories — "Ready to Assign" and friends — tagged with the
 * household they belong to. Money can legitimately come straight out of
 * unbudgeted money instead of an envelope (funding investments, an unplanned
 * contribution), but that should be a choice you *made*, not what happens when
 * you leave the category blank. Offering them in the picker makes the drain
 * explicit; it's also how you record income by hand.
 */
export function incomeCategoryOptions(budget: LoadedBudget): { value: string; label: string; household?: string }[] {
  const income = new Map(budget.groups.filter((g) => g.kind === "income").map((g) => [g.id, g]));
  return budget.categories
    .filter((c) => income.has(c.groupId))
    .map((c) => ({ value: c.id, label: c.name, household: income.get(c.groupId)!.household }));
}
