import type { Fingerprint } from "../ids.js";
import type { ISODate } from "../time.js";
import type { CategoryGroupKind, ClearedStatus, FlagColor } from "../model/types.js";

/**
 * Intermediate "staged" representation between normalized CSV rows and final
 * domain records. Still keyed by source strings (account/category names); the
 * resolve stage turns these into `Transaction`s with real ids. Format
 * vocabulary never reaches this layer — meaning is carried by the stamps
 * (`groupKind`, `groupHidden`, `counterAccount`) set at normalize time.
 */

export interface StagedLine {
  group: string;
  groupFold: string;
  category: string;
  categoryFold: string;
  /** Kind of this line's group, stamped at normalize time. */
  groupKind?: CategoryGroupKind;
  /** Whether this line's group imports hidden. */
  groupHidden?: boolean;
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
  /** The source's booking date, when `date` is an extracted true date. */
  bookDate?: ISODate;
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
  /** For an unlinked within-budget transfer leg: the counterpart account's name. */
  counterAccount?: string;
  counterAccountFold?: string;
  transfer?: StagedTransfer;
  /** Source-file line numbers that were folded into this txn (provenance). */
  sourceRows: number[];
  naturalKey?: Fingerprint;
  occurrenceIndex?: number;
  identity?: Fingerprint;
  /** Diagnostics attached during staging (e.g. incomplete split). */
  warnings?: string[];
}
