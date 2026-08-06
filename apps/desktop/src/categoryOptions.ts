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
