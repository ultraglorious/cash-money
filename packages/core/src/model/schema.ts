import { z } from "zod";
import { ULID_RE } from "../ids.js";
import { ISO_DATE_RE, MONTH_KEY_RE } from "../time.js";
import type {
  Account,
  Budget,
  Category,
  CategoryGroup,
  MonthlyAssignment,
  Transaction,
} from "./types.js";

/**
 * Runtime schemas used to validate data read back from disk. They intentionally
 * validate *shape and invariants* (a real parser boundary), then the parsed
 * value is treated as the branded domain type. Branding is a compile-time-only
 * concern, so a structural cast at this trust boundary is correct.
 */

const ulid = z.string().regex(ULID_RE, "invalid ULID");
const cents = z.number().int();
const isoDate = z.string().regex(ISO_DATE_RE, "invalid ISO date");
const monthKey = z.string().regex(MONTH_KEY_RE, "invalid month key");
const fingerprint = z.string().regex(/^[0-9a-f]{64}$/, "invalid fingerprint");

export const CurrencyConfigSchema = z.object({
  code: z.string().min(1),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(8),
  symbolPosition: z.enum(["before", "after"]),
  decimalSeparator: z.string(),
  groupSeparator: z.string(),
});

export const BudgetSchema = z.object({
  id: ulid,
  name: z.string(),
  currency: CurrencyConfigSchema,
  createdAt: isoDate,
  schemaVersion: z.number().int(),
  householdOrder: z.array(z.string()).optional(),
});

export const AccountSchema = z.object({
  id: ulid,
  name: z.string(),
  type: z.enum(["checking", "creditCard", "tracking"]),
  onBudget: z.boolean(),
  closed: z.boolean(),
  sortOrder: z.number(),
  household: z.string().optional(),
  reconciledThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export const CategoryGroupSchema = z.object({
  id: ulid,
  name: z.string(),
  household: z.string().optional(),
  kind: z.enum(["normal", "income", "creditCardPayments"]),
  sortOrder: z.number(),
  hidden: z.boolean(),
});

export const CategorySchema = z.object({
  id: ulid,
  groupId: ulid,
  name: z.string(),
  sortOrder: z.number(),
  hidden: z.boolean(),
  linkedAccountId: ulid.optional(),
});

export const MonthlyAssignmentSchema = z.object({
  id: ulid,
  month: monthKey,
  categoryId: ulid,
  assigned: cents,
});

const SplitLineSchema = z.object({
  id: ulid,
  categoryId: ulid.optional(),
  amount: cents,
  memo: z.string(),
});

const TransferRefSchema = z.object({
  counterAccountId: ulid,
  pairId: ulid,
});

const ImportProvenanceSchema = z.object({
  sourceBudget: z.string(),
  naturalKey: fingerprint,
  occurrenceIndex: z.number().int().min(0),
  identity: fingerprint,
  firstSeenExportTs: z.string(),
  lastSeenExportTs: z.string(),
});

export const TransactionSchema = z.object({
  id: ulid,
  accountId: ulid,
  date: isoDate,
  effectiveDate: isoDate,
  payee: z.string(),
  memo: z.string(),
  amount: cents,
  cleared: z.enum(["cleared", "uncleared", "reconciled"]),
  approved: z.boolean(),
  recurrence: z
    .object({
      freq: z.enum(["weekly", "biweekly", "monthly", "yearly"]),
      anchorDay: z.number().int().min(1).max(31).optional(),
    })
    .optional(),
  flag: z.enum(["blue", "green", "purple", "red", "yellow"]).optional(),
  categoryId: ulid.optional(),
  splits: z.array(SplitLineSchema).optional(),
  transfer: TransferRefSchema.optional(),
  source: ImportProvenanceSchema.optional(),
});

/** Shape of app.json — the index of budgets. Kept here with the other parse boundaries. */
export const AppIndexSchema = z.object({
  schemaVersion: z.number().int(),
  activeBudgetId: ulid.optional(),
  budgets: z.array(z.object({ id: ulid, name: z.string() })),
});

export function parseBudget(raw: unknown): Budget {
  return BudgetSchema.parse(raw) as Budget;
}
export function parseAccount(raw: unknown): Account {
  return AccountSchema.parse(raw) as Account;
}
export function parseCategoryGroup(raw: unknown): CategoryGroup {
  return CategoryGroupSchema.parse(raw) as CategoryGroup;
}
export function parseCategory(raw: unknown): Category {
  return CategorySchema.parse(raw) as Category;
}
export function parseMonthlyAssignment(raw: unknown): MonthlyAssignment {
  return MonthlyAssignmentSchema.parse(raw) as MonthlyAssignment;
}
export function parseTransaction(raw: unknown): Transaction {
  return TransactionSchema.parse(raw) as Transaction;
}
