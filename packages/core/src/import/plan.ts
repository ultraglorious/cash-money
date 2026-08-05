import { newId } from "../ids.js";
import type { Cents } from "../money.js";
import { parseImportMonth, type MonthKey } from "../time.js";
import type { MonthlyAssignment } from "../model/types.js";
import type { CategoriesResult } from "./categories.js";
import type { ImportConfig } from "./config.js";
import type { NormPlan } from "./planCsv.js";

/**
 * Imports the plan's `Assigned` values only (activity/available are derived by
 * the engine, so importing them would drift after the merge). Zero-assigned
 * cells of the dense grid are skipped. Same (category, month) across sources is
 * summed. Returns the assignments plus the exported activity/available kept as a
 * reconciliation oracle.
 */
export interface PlanResult {
  assignments: MonthlyAssignment[];
  /** (categoryId, month) -> exported {activity, available} for oracle checks. */
  oracle: Map<string, { activity: Cents; available: Cents }>;
  skippedUnresolved: number;
}

export function buildAssignments(
  plan: readonly NormPlan[],
  categories: CategoriesResult,
  config: ImportConfig,
): PlanResult {
  const householdOf = new Map(config.sources.map((s) => [s.sourceKey, s.household]));
  const assignedByKey = new Map<string, { month: MonthKey; categoryId: string; assigned: number }>();
  const oracle = new Map<string, { activity: Cents; available: Cents }>();
  let skippedUnresolved = 0;

  for (const p of plan) {
    const household = householdOf.get(p.sourceKey) ?? p.sourceKey;
    const categoryId = categories.resolveCategory(household, p.groupFold, p.categoryFold);
    if (!categoryId) {
      // Income group and unknown rows have no envelope assignment.
      if (p.groupFold && p.categoryFold) skippedUnresolved++;
      continue;
    }
    const month = parseImportMonth(p.month);
    const key = `${categoryId}␟${month}`;

    // Oracle: accumulate exported activity/available across sources.
    const prev = oracle.get(key) ?? { activity: 0 as Cents, available: 0 as Cents };
    oracle.set(key, {
      activity: (prev.activity + p.activity) as Cents,
      available: (prev.available + p.available) as Cents,
    });

    if (p.assigned === 0) continue; // skip dense-grid zeros
    const acc = assignedByKey.get(key);
    if (acc) acc.assigned += p.assigned;
    else assignedByKey.set(key, { month, categoryId, assigned: p.assigned });
  }

  const assignments: MonthlyAssignment[] = [...assignedByKey.values()].map((a) => ({
    id: newId(),
    month: a.month,
    categoryId: a.categoryId as MonthlyAssignment["categoryId"],
    assigned: a.assigned as Cents,
  }));

  return { assignments, oracle, skippedUnresolved };
}
