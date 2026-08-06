// Public surface of @cash-money/core.

export const CORE_VERSION = "0.0.0";

export * from "./money.js";
export * from "./time.js";
export * from "./ids.js";
export * from "./model/types.js";
export * from "./model/schema.js";
export * as layout from "./persistence/layout.js";
export * from "./persistence/serialize.js";
export * from "./persistence/repository.js";
export { BUDGET_FILE_VERSION, parseBudgetFile, serializeBudgetFile, type BudgetFileData } from "./persistence/budgetFile.js";
export { InMemoryFileSystem } from "./persistence/memoryFs.js";
export * from "./engine/index.js";
export * as ops from "./ops.js";
export { deduceInvoiceCoverage, type InvoiceCoverage } from "./invoices.js";
export * from "./import/format.js";
export { builtinFormat, builtinFormats } from "./import/formats/index.js";
export { guessFormat, type FormatGuess } from "./import/guess.js";
export { formatFitsHeaders, parseCsv, parseDateAs, mapRegisterRows, type ParsedCsv, type NormTxn, type MapRegisterOptions, type MapRegisterResult } from "./import/register.js";
export * from "./import/config.js";
export { stageImport, type SourceInput, type ImportReport, type StagingResult } from "./import/pipeline.js";
export { mergeImport, type MergeImportReport, type MergeImportResult } from "./import/merge.js";
export {
  buildStatementTransactions,
  reconcileStatement,
  type ChurnPair,
  type MatchKind,
  type StatementMatch,
  type StatementOptions,
  type StatementReconcile,
  type StatementRow,
} from "./import/statement.js";
export { reconcileTransactions, type ReconcileReport, type ReconcileResult } from "./import/reconcile.js";
