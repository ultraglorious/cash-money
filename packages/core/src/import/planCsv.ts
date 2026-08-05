import { parseMoney, type CurrencyConfig } from "../money.js";
import type { CategoryGroupKind } from "../model/types.js";
import type { FormatSemantics } from "./format.js";
import { parseCsv, requireColumns } from "./register.js";
import { fold, trimN } from "./text.js";

/**
 * The plan (Assigned amounts) side of a "zip-register-plan" packaged export.
 * Unlike registers, plan CSVs have exactly one known shape, so the columns are
 * fixed rather than format-mapped. Only `Assigned` is imported; the exported
 * activity/available are retained purely as a reconciliation oracle for tests.
 */

export const PLAN_COLUMNS = ["Month", "Category Group", "Category", "Assigned", "Activity", "Available"] as const;

export interface NormPlan {
  sourceKey: string;
  /** Raw source month label; parsed to a MonthKey in the plan stage. */
  month: string;
  group: string;
  groupFold: string;
  category: string;
  categoryFold: string;
  /** Semantics stamps, mirroring NormTxn's (see register.ts). */
  groupKind?: CategoryGroupKind;
  groupHidden?: boolean;
  assigned: number;
  /** Exported activity/available, retained only as a reconciliation oracle. */
  activity: number;
  available: number;
  sourceRow: number;
}

export interface ParsePlanOptions {
  sourceKey: string;
  currency: CurrencyConfig;
  semantics?: FormatSemantics;
}

/** Parse + normalize a plan CSV. Throws when the expected columns are missing. */
export function parsePlan(text: string, opts: ParsePlanOptions): NormPlan[] {
  const parsed = parseCsv(text);
  const missing = requireColumns(parsed.headers, PLAN_COLUMNS);
  if (missing.length > 0) {
    throw new Error(`Plan CSV is missing column(s): ${missing.join(", ")}`);
  }

  const sem = opts.semantics;
  const incomeGroupFold = sem?.incomeGroup ? fold(sem.incomeGroup) : undefined;
  const hiddenGroupFold = sem?.hiddenGroup ? fold(sem.hiddenGroup) : undefined;
  const ccGroupFold = sem?.creditCardPaymentsGroup ? fold(sem.creditCardPaymentsGroup) : undefined;

  return parsed.rows.map((r, i) => {
    const groupFold = fold(r["Category Group"] ?? "");
    const money = (cell: string | undefined): number =>
      cell && cell.trim() ? parseMoney(cell, opts.currency) : 0;
    const groupKind: CategoryGroupKind | undefined = !groupFold
      ? undefined
      : groupFold === incomeGroupFold
        ? "income"
        : groupFold === ccGroupFold
          ? "creditCardPayments"
          : "normal";
    return {
      sourceKey: opts.sourceKey,
      month: r["Month"] ?? "",
      group: trimN(r["Category Group"] ?? ""),
      groupFold,
      category: trimN(r["Category"] ?? ""),
      categoryFold: fold(r["Category"] ?? ""),
      groupKind,
      groupHidden: groupFold ? groupFold === hiddenGroupFold : undefined,
      assigned: money(r["Assigned"]),
      activity: money(r["Activity"]),
      available: money(r["Available"]),
      sourceRow: i + 2, // row 1 is the header
    };
  });
}
