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
