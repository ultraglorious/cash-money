import { z } from "zod";
import type { ClearedStatus, FlagColor } from "../model/types.js";

/**
 * A register format describes how to read one CSV shape into transactions: which
 * columns hold what, how dates and amounts are written, and which names carry
 * special meaning. Formats are plain JSON (regexes stored as strings) so they
 * can ship in the repo's format library (`formats/`), be saved by the user, and
 * be contributed without code changes. The import pipeline itself is
 * format-agnostic — everything source-specific lives in one of these.
 */

/** Day-month order of a date cell. All parsers accept `-`, `/`, or `.` separators. */
export type ImportDateFormat = "iso" | "dmy" | "mdy";

export type AmountMapping =
  /** One signed column. `outflowPositive` flips the sign (statements that print debits as positive). */
  | { mode: "signed"; column: string; outflowPositive?: boolean }
  /** Separate inflow/outflow columns, both non-negative; signed amount = inflow − outflow. */
  | { mode: "inOut"; inflowColumn: string; outflowColumn: string };

export type CategoryMapping =
  /** Separate group + category columns (group optional: flat category lists). */
  | { mode: "columns"; groupColumn?: string; categoryColumn: string }
  /** One combined column, split on the FIRST occurrence of `separator`. */
  | { mode: "combined"; column: string; separator: string };

export type TransferMapping =
  /**
   * A payee matching `pattern` (capture group 1 = counterpart account name)
   * marks a within-budget transfer leg. `onlyWhenUncategorized` restricts it to
   * rows without a category (sources where a categorized "transfer" is really
   * a movement across the budget boundary).
   */
  | { mode: "payeePattern"; pattern: string; onlyWhenUncategorized?: boolean }
  /** A non-empty cell in `column` names the counterpart account. */
  | { mode: "column"; column: string };

/** Folded (trimmed, case-insensitive) names that carry special meaning. */
export interface FormatSemantics {
  /** Group whose rows are income (fund Ready-to-Assign). */
  incomeGroup?: string;
  /** Category treated as income regardless of group. */
  incomeCategory?: string;
  /** Group imported with its categories hidden. */
  hiddenGroup?: string;
  /** Group whose categories are credit-card payment envelopes, linked to the same-named account. */
  creditCardPaymentsGroup?: string;
}

export interface RegisterFormat {
  /** Stable identifier: `lib:<slug>` for library formats, a ULID for saved ones. */
  id: string;
  /** Display name shown in the import wizard. */
  name: string;
  date: { column: string; format: ImportDateFormat };
  amount: AmountMapping;
  payeeColumn: string;
  memoColumn?: string;
  /** Column naming the account. Absent = single-account file (bank statement). */
  accountColumn?: string;
  /** How rows are categorized. Absent = rows import uncategorized. */
  category?: CategoryMapping;
  clearedColumn?: string;
  /** Folded cell value -> status; unmapped values become "uncleared". */
  clearedValues?: Record<string, ClearedStatus>;
  flagColumn?: string;
  /** Folded cell value -> flag; unmapped values mean no flag. */
  flagValues?: Record<string, FlagColor>;
  /** How within-budget transfers are recognized. Absent for bank statements. */
  transfer?: TransferMapping;
  /** Regex over the memo with (n)(m) groups; enables split-run reconstruction. */
  splitMemoPattern?: string;
  /**
   * Some banks book a card purchase days after it happened but embed the TRUE
   * transaction date in the description. A regex over the memo cell whose
   * capture group 1 is that date; when it matches, it replaces the date-column
   * value (which is kept as `bookDate`). Rows without a match keep the column.
   */
  trueDate?: { pattern: string; format: ImportDateFormat };
  semantics?: FormatSemantics;
  /**
   * Packaging hint for the wizard: "zip-register-plan" formats arrive as a zip
   * whose members include a register CSV and an optional plan (Assigned) CSV.
   */
  packaging?: "csv" | "zip-register-plan";
}

// ---- Runtime validation ------------------------------------------------------

const nonEmpty = z.string().min(1);
const clearedStatus = z.enum(["cleared", "uncleared", "reconciled"]);
const flagColor = z.enum(["blue", "green", "purple", "red", "yellow"]);

/** A string that must compile as a RegExp (formats are data; fail softly). */
const regexString = nonEmpty.refine(
  (s) => {
    try {
      new RegExp(s, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a valid regular expression" },
);

export const RegisterFormatSchema: z.ZodType<RegisterFormat> = z.object({
  id: nonEmpty,
  name: nonEmpty,
  date: z.object({ column: nonEmpty, format: z.enum(["iso", "dmy", "mdy"]) }),
  amount: z.union([
    z.object({ mode: z.literal("signed"), column: nonEmpty, outflowPositive: z.boolean().optional() }),
    z.object({ mode: z.literal("inOut"), inflowColumn: nonEmpty, outflowColumn: nonEmpty }),
  ]),
  payeeColumn: nonEmpty,
  memoColumn: nonEmpty.optional(),
  accountColumn: nonEmpty.optional(),
  category: z
    .union([
      z.object({ mode: z.literal("columns"), groupColumn: nonEmpty.optional(), categoryColumn: nonEmpty }),
      z.object({ mode: z.literal("combined"), column: nonEmpty, separator: nonEmpty }),
    ])
    .optional(),
  clearedColumn: nonEmpty.optional(),
  clearedValues: z.record(z.string(), clearedStatus).optional(),
  flagColumn: nonEmpty.optional(),
  flagValues: z.record(z.string(), flagColor).optional(),
  transfer: z
    .union([
      z.object({ mode: z.literal("payeePattern"), pattern: regexString, onlyWhenUncategorized: z.boolean().optional() }),
      z.object({ mode: z.literal("column"), column: nonEmpty }),
    ])
    .optional(),
  splitMemoPattern: regexString.optional(),
  trueDate: z
    .object({ pattern: regexString, format: z.enum(["iso", "dmy", "mdy"]) })
    .optional(),
  semantics: z
    .object({
      incomeGroup: nonEmpty.optional(),
      incomeCategory: nonEmpty.optional(),
      hiddenGroup: nonEmpty.optional(),
      creditCardPaymentsGroup: nonEmpty.optional(),
    })
    .optional(),
  packaging: z.enum(["csv", "zip-register-plan"]).optional(),
});

/**
 * Validate untrusted format data (a library file, a saved mapping, wizard
 * input). Throws with a readable message on the first problem.
 */
export function validateFormat(data: unknown): RegisterFormat {
  const result = RegisterFormatSchema.safeParse(data);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    throw new Error(`Invalid register format at ${path}: ${issue?.message ?? "unknown error"}`);
  }
  return result.data;
}
