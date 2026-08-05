import type { Cents } from "../money.js";
import type { Ulid } from "../ids.js";
import type { MonthKey } from "../time.js";
import type { CategoryGroup } from "../model/types.js";

export interface CategoryMonthView {
  categoryId: Ulid;
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export interface GroupMonthView {
  group: CategoryGroup;
  categories: CategoryMonthView[];
  /** Sum of the group's categories for this month. */
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export interface MonthView {
  month: MonthKey;
  /** Unassigned money available to budget this month (cumulative). */
  readyToAssign: Cents;
  /** Non-income groups, in sort order (grouped projection). */
  groups: GroupMonthView[];
  /** Every non-income category, flat (the "all categories" projection). */
  flat: CategoryMonthView[];
}
