import { newId } from "../ids.js";
import type { ISODate } from "../time.js";
import { SCHEMA_VERSION, type Budget, type LoadedBudget } from "../model/types.js";
import type { Cents } from "../money.js";
import { parsePlanCsv, parseRegisterCsv } from "./csv.js";
import type { ImportConfig } from "./config.js";
import { normalizePlan, normalizeRegister } from "./normalize.js";
import { buildStagedTransactions } from "./transactions.js";
import { reconstructTransfers, type TransferReport } from "./transfers.js";
import { buildAccounts } from "./accounts.js";
import { buildCategories } from "./categories.js";
import { resolveTransactions } from "./resolve.js";
import { buildAssignments } from "./plan.js";
import type { StagedTxn } from "./staged.js";

export interface SourceInput {
  sourceKey: string;
  registerCsv: string;
  planCsv: string;
}

export interface ImportReport {
  sources: Array<{ sourceKey: string; label: string; registerRows: number; planRows: number }>;
  transactions: number;
  transfers: TransferReport;
  accounts: number;
  groups: number;
  categories: number;
  creditCardLinks: number;
  assignments: number;
  splitsReconstructed: number;
  unapproved: number;
  unresolvedAccounts: number;
  unresolvedCategories: number;
  /** Net signed balance across all accounts (must be unchanged by stitching). */
  netAcrossAccounts: Cents;
  warnings: string[];
}

export interface StagingResult {
  staging: LoadedBudget;
  oracle: Map<string, { activity: Cents; available: Cents }>;
  report: ImportReport;
}

/**
 * The full import pipeline, producing a staging budget (in memory) and a report.
 * Writes nothing — the caller decides whether to reconcile + persist (dry-run by
 * default).
 */
export function stageImport(
  inputs: readonly SourceInput[],
  config: ImportConfig,
  createdAt: ISODate,
): StagingResult {
  const labelOf = new Map(config.sources.map((s) => [s.sourceKey, s.label]));

  const staged: StagedTxn[] = [];
  const plan: ReturnType<typeof normalizePlan> = [];
  const sourcesMeta: ImportReport["sources"] = [];
  const warnings: string[] = [];
  let splitsReconstructed = 0;

  for (const input of inputs) {
    const regRows = parseRegisterCsv(input.registerCsv);
    const planRows = parsePlanCsv(input.planCsv);
    const opts = { sourceKey: input.sourceKey, currency: config.currency, exportDate: config.exportDate };
    const norm = normalizeRegister(regRows, opts);
    const stagedForSource = buildStagedTransactions(norm);
    for (const t of stagedForSource) {
      if (t.sourceRows.length > 1) splitsReconstructed++;
      if (t.warnings) warnings.push(...t.warnings.map((w) => `[${input.sourceKey}] ${w}`));
    }
    staged.push(...stagedForSource);
    plan.push(...normalizePlan(planRows, opts));
    sourcesMeta.push({
      sourceKey: input.sourceKey,
      label: labelOf.get(input.sourceKey) ?? input.sourceKey,
      registerRows: regRows.length,
      planRows: planRows.length,
    });
  }

  const transfers = reconstructTransfers(staged, config.stitchRules);
  const accounts = buildAccounts(staged, config);
  const categories = buildCategories(staged, plan, config, accounts);
  const resolved = resolveTransactions(staged, accounts, categories, config);
  const planResult = buildAssignments(plan, categories, config);

  const budget: Budget = {
    id: newId(),
    name: config.budgetName ?? "Budget",
    currency: config.currency,
    createdAt,
    schemaVersion: SCHEMA_VERSION,
  };

  const staging: LoadedBudget = {
    budget,
    accounts: accounts.accounts,
    groups: categories.groups,
    categories: categories.categories,
    assignments: planResult.assignments,
    transactions: resolved.transactions,
  };

  const netAcrossAccounts = resolved.transactions
    .filter((t) => t.approved)
    .reduce((sum, t) => sum + t.amount, 0) as Cents;
  const unapproved = resolved.transactions.filter((t) => !t.approved).length;

  const report: ImportReport = {
    sources: sourcesMeta,
    transactions: resolved.transactions.length,
    transfers,
    accounts: accounts.accounts.length,
    groups: categories.groups.length,
    categories: categories.categories.length,
    creditCardLinks: categories.report.creditCardLinks,
    assignments: planResult.assignments.length,
    splitsReconstructed,
    unapproved,
    unresolvedAccounts: resolved.unresolvedAccounts,
    unresolvedCategories: resolved.unresolvedCategories,
    netAcrossAccounts,
    warnings,
  };

  return { staging, oracle: planResult.oracle, report };
}
