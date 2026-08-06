import { invoke } from "@tauri-apps/api/core";
import type { FileSystemPort } from "@cash-money/core";

/** True when running inside the Tauri native shell (vs a plain browser). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** FileSystemPort backed by the native Rust commands (paths under the app data dir). */
export class TauriFileSystem implements FileSystemPort {
  readTextFile(rel: string): Promise<string | null> {
    return invoke<string | null>("read_text_file", { path: rel });
  }
  writeTextFileAtomic(rel: string, contents: string): Promise<void> {
    return invoke<void>("write_text_file", { path: rel, contents });
  }
  listDir(rel: string): Promise<string[]> {
    return invoke<string[]>("list_dir", { path: rel });
  }
  ensureDir(): Promise<void> {
    return Promise.resolve(); // write_text_file creates parent dirs
  }
  remove(rel: string): Promise<void> {
    return invoke<void>("remove_file", { path: rel });
  }
}

export interface CsvMember {
  name: string;
  content: string;
}

/** Read all `*.csv` members from a zip at an absolute path (from the file picker). */
export function readZipCsvs(zipPath: string): Promise<CsvMember[]> {
  return invoke<CsvMember[]>("read_zip_csvs", { zipPath });
}

/** Read a text file at an absolute path (e.g. a bank statement CSV). */
export function readTextAbs(path: string): Promise<string> {
  return invoke<string>("read_text_abs", { path });
}

// ---- Single-file budget (.cashmoney) ---------------------------------------

export interface BudgetFileRead {
  contents: string;
  mtimeMs: number;
}

export function readBudgetFile(path: string): Promise<BudgetFileRead> {
  return invoke<BudgetFileRead>("read_budget_file", { path });
}

/**
 * Atomically write the budget file; returns the new mtime. When
 * `expectedMtimeMs` is set and the on-disk file has moved on (another device's
 * sync), the write fails with a message starting "conflict:".
 */
export function writeBudgetFile(path: string, contents: string, expectedMtimeMs?: number): Promise<number> {
  return invoke<number>("write_budget_file", { path, contents, expectedMtimeMs: expectedMtimeMs ?? null });
}

export function statBudgetFile(path: string): Promise<number | null> {
  return invoke<number | null>("stat_budget_file", { path });
}

export function backupBudgetFile(path: string): Promise<void> {
  return invoke<void>("backup_budget_file", { path });
}

/** True when a write failure means "the file changed under us", not an IO error. */
export function isConflictError(e: unknown): boolean {
  return String(e).includes("conflict:");
}
