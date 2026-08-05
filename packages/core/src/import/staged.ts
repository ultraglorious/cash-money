import type { Fingerprint } from "../ids.js";
import type { ISODate } from "../time.js";
import type { ClearedStatus, FlagColor } from "../model/types.js";

/**
 * Intermediate "staged" representation between normalized CSV rows and final
 * domain records. Still keyed by source strings (account/category names); the
 * resolve stage turns these into `Transaction`s with real ids.
 */

export interface StagedLine {
  group: string;
  groupFold: string;
  category: string;
  categoryFold: string;
  amount: number;
  memo: string;
  isIncome: boolean;
}

export type StagedKind = "normal" | "income" | "withinTransfer" | "transfer";

export interface StagedTransfer {
  /** Source key of the counterpart account (same source for within-budget). */
  counterSourceKey: string;
  counterAccount: string;
  counterAccountFold: string;
  /** Shared by both legs of one transfer. */
  pairId: string;
}

export interface StagedTxn {
  sourceKey: string;
  account: string;
  accountFold: string;
  date: ISODate;
  effectiveDate: ISODate;
  epochDay: number;
  approved: boolean;
  payee: string;
  payeeFold: string;
  memo: string;
  /** Total signed minor units (equals the sum of `lines` when categorized). */
  amount: number;
  cleared: ClearedStatus;
  flag?: FlagColor;
  kind: StagedKind;
  /** Categorized lines: length 1 for a simple txn, >1 for a split. Empty for transfers. */
  lines: StagedLine[];
  transfer?: StagedTransfer;
  /** Source-file line numbers that were folded into this txn (provenance). */
  sourceRows: number[];
  naturalKey?: Fingerprint;
  occurrenceIndex?: number;
  identity?: Fingerprint;
  /** Diagnostics attached during staging (e.g. incomplete split). */
  warnings?: string[];
}
