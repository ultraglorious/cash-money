import type { Cents } from "../money.js";
import type { CurrencyConfig } from "../money.js";
import type { Fingerprint, Ulid } from "../ids.js";
import type { ISODate, MonthKey, RecurrenceFreq } from "../time.js";

/** Bumped when the on-disk shape changes in a way that needs migration. */
export const SCHEMA_VERSION = 1;

export type AccountType = "checking" | "creditCard" | "tracking";
export type ClearedStatus = "cleared" | "uncleared" | "reconciled";
export type FlagColor = "blue" | "green" | "purple" | "red" | "yellow";

/**
 * `normal`  — ordinary spending/saving envelopes.
 * `income`  — hosts the inflow bucket ("ready to assign"); not an envelope.
 * `creditCardPayments` — one category per credit-card account, tracking money
 *   set aside to pay that card.
 */
export type CategoryGroupKind = "normal" | "income" | "creditCardPayments";

export interface Budget {
  id: Ulid;
  name: string;
  /** Full currency config so a budget's files are self-describing. */
  currency: CurrencyConfig;
  createdAt: ISODate;
  schemaVersion: number;
  /** Preferred display order of household panels in the Plan. */
  householdOrder?: string[];
}

export interface Account {
  id: Ulid;
  name: string;
  type: AccountType;
  /** checking + creditCard are on-budget; tracking (investments) is off-budget. */
  onBudget: boolean;
  closed: boolean;
  sortOrder: number;
  /**
   * Optional label grouping accounts into a household (e.g. "Personal",
   * "Joint"). Drives the Plan's per-household split and Ready-to-Assign
   * breakdown. A user-supplied string, never hardcoded in source.
   */
  household?: string;
  /** Last date through which a bank statement confirmed this account's rows. */
  reconciledThrough?: ISODate;
}

export interface CategoryGroup {
  id: Ulid;
  name: string;
  /**
   * Optional user-defined grouping label used to keep merged sources distinct
   * (e.g. a household name). Always a generic, user-supplied string — never a
   * value hardcoded in source.
   */
  household?: string;
  kind: CategoryGroupKind;
  sortOrder: number;
  hidden: boolean;
}

export interface Category {
  id: Ulid;
  groupId: Ulid;
  name: string;
  sortOrder: number;
  hidden: boolean;
  /** creditCardPayments categories only: the card account this envelope pays. */
  linkedAccountId?: Ulid;
}

export interface MonthlyAssignment {
  id: Ulid;
  month: MonthKey;
  categoryId: Ulid;
  /** Money the user budgeted to this category this month (an input, never derived). */
  assigned: Cents;
}

export interface SplitLine {
  id: Ulid;
  categoryId?: Ulid;
  amount: Cents;
  memo: string;
}

export interface TransferRef {
  /** The other account in the transfer. */
  counterAccountId: Ulid;
  /** Shared by the two legs of one transfer so they can be found as a pair. */
  pairId: Ulid;
}

/** Bookkeeping that makes an imported record idempotently re-importable. */
export interface ImportProvenance {
  /** Which source export this row came from (a generic label, not committed to code). */
  sourceBudget: string;
  naturalKey: Fingerprint;
  /** Stable rank among rows sharing a naturalKey (distinguishes true duplicates). */
  occurrenceIndex: number;
  identity: Fingerprint;
  firstSeenExportTs: string;
  lastSeenExportTs: string;
}

export interface Transaction {
  id: Ulid;
  accountId: Ulid;
  /** When it actually happened (drives the register and account balances). */
  date: ISODate;
  /** Which budget month it counts toward (drives envelope math). Defaults to `date`. */
  effectiveDate: ISODate;
  payee: string;
  memo: string;
  /** Signed minor units: inflow positive, outflow negative. */
  amount: Cents;
  cleared: ClearedStatus;
  /**
   * Whether this transaction counts toward the budget yet. Future-dated /
   * scheduled entries import as `false` ("unapproved") and are excluded from
   * activity, balances, and Ready-to-Assign until the user approves them.
   */
  approved: boolean;
  /**
   * Present => this scheduled transaction repeats: approving it (entering it
   * into the register) spawns the next occurrence as a new scheduled entry.
   * `anchorDay` pins monthly/yearly bills to their true day of month so a
   * short month doesn't make later occurrences drift (Jan 31 → Feb 28 → Mar 31).
   */
  recurrence?: { freq: RecurrenceFreq; anchorDay?: number };
  flag?: FlagColor;
  /** Set for a simple categorized txn. Undefined for splits, transfers, and income. */
  categoryId?: Ulid;
  /** Present => split parent; `amount` equals the sum of the split lines. */
  splits?: SplitLine[];
  /** Present => this txn is one leg of a transfer between two accounts. */
  transfer?: TransferRef;
  source?: ImportProvenance;
}

/** The fully-hydrated in-memory model handed to the store and the engine. */
export interface LoadedBudget {
  budget: Budget;
  accounts: Account[];
  groups: CategoryGroup[];
  categories: Category[];
  assignments: MonthlyAssignment[];
  transactions: Transaction[];
}
