import { newId, type Ulid } from "../ids.js";
import type { Account, AccountType } from "../model/types.js";
import { householdBySource, type ImportConfig } from "./config.js";
import { SEP, fold } from "./text.js";
import type { StagedTxn } from "./staged.js";

/** Accounts are keyed by (sourceKey, accountFold) so each source stays distinct. */
function accountKey(sourceKey: string, accountFold: string): string {
  return `${sourceKey}${SEP}${accountFold}`;
}

const CREDIT_CARD_RE = /credit\s*card/i;

function inferType(name: string, config: ImportConfig): AccountType {
  const override = config.accountTypeOverrides?.[name];
  if (override) return override;
  if (CREDIT_CARD_RE.test(name)) return "creditCard";
  const hints = config.trackingAccountHints ?? [];
  const nameFold = fold(name);
  if (hints.some((h) => nameFold.includes(fold(h)))) return "tracking";
  return "checking";
}

export interface AccountsResult {
  accounts: Account[];
  /** Resolve a (sourceKey, accountFold) to an account id, creating none. */
  resolve(sourceKey: string, accountFold: string): Ulid | undefined;
}

/**
 * Builds the unified account list from every account name that appears as a
 * transaction account or as a transfer counterpart. Types are inferred from the
 * name (credit card / tracking / checking) unless overridden in config.
 */
export function buildAccounts(staged: readonly StagedTxn[], config: ImportConfig): AccountsResult {
  // Collect distinct (sourceKey, accountFold) -> display name.
  const names = new Map<string, { sourceKey: string; name: string; fold: string }>();
  const note = (sourceKey: string, name: string, f: string): void => {
    const key = accountKey(sourceKey, f);
    if (!names.has(key)) names.set(key, { sourceKey, name, fold: f });
  };

  for (const t of staged) {
    note(t.sourceKey, t.account, t.accountFold);
    if (t.transfer) {
      note(t.transfer.counterSourceKey, t.transfer.counterAccount, t.transfer.counterAccountFold);
    }
  }

  const householdOf = householdBySource(config);

  const idByKey = new Map<string, Ulid>();
  const accounts: Account[] = [];
  let sortOrder = 0;
  // Stable order for deterministic output.
  const sortedKeys = [...names.keys()].sort();
  for (const key of sortedKeys) {
    const { name, sourceKey } = names.get(key)!;
    const type = inferType(name, config);
    const id = newId();
    idByKey.set(key, id);
    const household = householdOf.get(sourceKey);
    accounts.push({
      id,
      name,
      type,
      onBudget: type !== "tracking",
      closed: false,
      sortOrder: sortOrder++,
      ...(household ? { household } : {}),
    });
  }

  return {
    accounts,
    resolve: (sourceKey, accountFold) => idByKey.get(accountKey(sourceKey, accountFold)),
  };
}
