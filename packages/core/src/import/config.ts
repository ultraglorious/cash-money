import type { CurrencyConfig } from "../money.js";
import type { ISODate } from "../time.js";
import type { AccountType } from "../model/types.js";
import type { RegisterFormat } from "./format.js";

/**
 * Import configuration. This type carries NO real values — the concrete config
 * (source labels, household names) is supplied at runtime from a file kept out
 * of the repo, so no personal data is ever committed.
 */

export interface SourceConfig {
  /** Stable key for this source, used in provenance + re-import matching. */
  sourceKey: string;
  /** User-facing label (e.g. a household name). Shown in the UI; not committed. */
  label: string;
  /** Household tag applied to this source's category groups to keep them distinct. */
  household: string;
  /** How this source's register CSV is shaped. Default: the library budget-export format. */
  format?: RegisterFormat;
  /** This source's "as of" date; rows dated after it import as unapproved. */
  exportDate?: ISODate;
}

export interface ImportConfig {
  currency: CurrencyConfig;
  /** Name for the merged budget. */
  budgetName?: string;
  sources: SourceConfig[];
  /** Fallback "as of" date for sources that don't declare their own. */
  exportDate?: ISODate;
  /** Optional account-name → type overrides; otherwise inferred from the name. */
  accountTypeOverrides?: Record<string, AccountType>;
  /**
   * Substrings (case-insensitive) of account names to treat as off-budget
   * tracking accounts when not otherwise overridden (e.g. investment/deposit).
   */
  trackingAccountHints?: string[];
}
