import { newId } from "../ids.js";
import type { ISODate } from "../time.js";
import { SCHEMA_VERSION, type Budget, type LoadedBudget } from "../model/types.js";
import type { Cents } from "../money.js";
import type { ImportConfig } from "./config.js";
import { builtinFormat } from "./formats/index.js";
import { mapRegisterRows, parseCsv } from "./register.js";
import { parsePlan, type NormPlan } from "./planCsv.js";
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
  /** Assigned-amounts CSV; only zip-register-plan packaged sources have one. */
  planCsv?: string;
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
  /** Net signed balance across all accounts (an integrity checksum). */
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
  const sourceCfg = new Map(config.sources.map((s) => [s.sourceKey, s]));
  const defaultFormat = builtinFormat("lib:budget-export-register")!;

  const staged: StagedTxn[] = [];
  const plan: NormPlan[] = [];
  const sourcesMeta: ImportReport["sources"] = [];
  const warnings: string[] = [];
  let splitsReconstructed = 0;

  for (const input of inputs) {
    const cfg = sourceCfg.get(input.sourceKey);
    const format = cfg?.format ?? defaultFormat;
    const mapped = mapRegisterRows(parseCsv(input.registerCsv), format, {
      sourceKey: input.sourceKey,
      currency: config.currency,
      exportDate: cfg?.exportDate ?? config.exportDate,
    });
    if (mapped.errors.length > 0) {
      // A snapshot import must be perfect; surface the first problems and stop.
      throw new Error(`[${input.sourceKey}] ${mapped.errors.slice(0, 3).join("; ")}`);
    }
    const planRows = input.planCsv
      ? parsePlan(input.planCsv, {
          sourceKey: input.sourceKey,
          currency: config.currency,
          semantics: format.semantics,
        })
      : [];
    const stagedForSource = buildStagedTransactions(mapped.rows);
    for (const t of stagedForSource) {
      if (t.sourceRows.length > 1) splitsReconstructed++;
      if (t.warnings) warnings.push(...t.warnings.map((w) => `[${input.sourceKey}] ${w}`));
    }
    staged.push(...stagedForSource);
    plan.push(...planRows);
    sourcesMeta.push({
      sourceKey: input.sourceKey,
      label: cfg?.label ?? input.sourceKey,
      registerRows: mapped.rows.length,
      planRows: planRows.length,
    });
  }

  const transfers = reconstructTransfers(staged);
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
