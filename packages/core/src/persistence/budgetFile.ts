import { z } from "zod";
import type { LoadedBudget } from "../model/types.js";
import {
  AccountSchema,
  BudgetSchema,
  CategoryGroupSchema,
  CategorySchema,
  MonthlyAssignmentSchema,
  TransactionSchema,
} from "../model/schema.js";
import { RegisterFormatSchema } from "../import/format.js";
import { byId, stableJson } from "./serialize.js";
import type { ImportSourceEntry, SavedFormat } from "./repository.js";

/**
 * The single-file budget container (`.cashmoney`): one self-contained JSON
 * document holding the whole budget PLUS the user's saved statement mappings
 * and per-account statement sources, so a synced file carries everything the
 * app knows. Written with stable key order and id-sorted collections, so two
 * saves of the same data are byte-identical and cloud-sync diffs stay
 * meaningful. Designed to live in a cloud-synced folder (e.g. iCloud Drive)
 * and be edited by ONE device at a time — the app guards against concurrent
 * writers by file mtime, not by merging.
 */

export const BUDGET_FILE_VERSION = 1;

export interface BudgetFileData {
  loaded: LoadedBudget;
  savedFormats: SavedFormat[];
  importSources: ImportSourceEntry[];
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const SavedFormatSchema = z.object({
  format: RegisterFormatSchema,
  lastUsed: isoDate.optional(),
});

const ImportSourceEntrySchema = z.object({
  accountId: z.string(),
  formatId: z.string(),
  sourceKey: z.string(),
  lastUsed: isoDate.optional(),
});

const BudgetFileSchema = z.object({
  fileVersion: z.number().int().min(1),
  /** Informational: when and by which app version the file was written. */
  savedAt: z.string(),
  budget: BudgetSchema,
  accounts: z.array(AccountSchema),
  groups: z.array(CategoryGroupSchema),
  categories: z.array(CategorySchema),
  assignments: z.array(MonthlyAssignmentSchema),
  transactions: z.array(TransactionSchema),
  savedFormats: z.array(SavedFormatSchema).default([]),
  importSources: z.array(ImportSourceEntrySchema).default([]),
});

export function serializeBudgetFile(data: BudgetFileData, savedAt: string): string {
  const { loaded } = data;
  return stableJson({
    fileVersion: BUDGET_FILE_VERSION,
    savedAt,
    budget: loaded.budget,
    accounts: byId(loaded.accounts),
    groups: byId(loaded.groups),
    categories: byId(loaded.categories),
    assignments: byId(loaded.assignments),
    transactions: byId(loaded.transactions),
    savedFormats: data.savedFormats,
    importSources: data.importSources,
  });
}

/** Parse + validate a budget file. Throws with a readable message on any mismatch. */
export function parseBudgetFile(text: string): BudgetFileData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not a valid budget file (broken JSON): ${(e as Error).message}`);
  }
  const parsed = BudgetFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Not a valid budget file: ${issue ? `${issue.path.join(".")}: ${issue.message}` : parsed.error.message}`,
    );
  }
  const f = parsed.data;
  if (f.fileVersion > BUDGET_FILE_VERSION) {
    throw new Error(
      `This budget file was written by a newer app version (file v${f.fileVersion}, app supports v${BUDGET_FILE_VERSION}). Update the app before opening it.`,
    );
  }
  return {
    loaded: {
      budget: f.budget,
      accounts: f.accounts,
      groups: f.groups,
      categories: f.categories,
      assignments: f.assignments,
      transactions: f.transactions,
    } as LoadedBudget,
    savedFormats: f.savedFormats as SavedFormat[],
    importSources: f.importSources as ImportSourceEntry[],
  };
}
