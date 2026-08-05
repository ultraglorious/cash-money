import type { CurrencyConfig } from "../money.js";
import type { ISODate } from "../time.js";
import type { AccountType } from "../model/types.js";

/**
 * Import configuration. This type carries NO real values — the concrete config
 * (source labels, link-payee names, exclusions) is supplied at runtime from a
 * file kept out of the repo, so no personal data is ever committed.
 */

export interface SourceConfig {
  /** Stable key for this source, used in provenance + re-import matching. */
  sourceKey: string;
  /** User-facing label (e.g. a household name). Shown in the UI; not committed. */
  label: string;
  /** Household tag applied to this source's category groups to keep them distinct. */
  household: string;
}

export interface ImportConfig {
  currency: CurrencyConfig;
  /** Name for the merged budget. */
  budgetName?: string;
  sources: SourceConfig[];
  /** "as of" date from the export; rows dated after this import as unapproved. */
  exportDate: ISODate;
  /** Optional account-name → type overrides; otherwise inferred from the name. */
  accountTypeOverrides?: Record<string, AccountType>;
  /**
   * Substrings (case-insensitive) of account names to treat as off-budget
   * tracking accounts when not otherwise overridden (e.g. investment/deposit).
   */
  trackingAccountHints?: string[];
}
