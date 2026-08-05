import type { FileSystemPort } from "./repository.js";

/**
 * In-memory FileSystemPort for tests. Keeps a flat map of relative path -> text
 * and derives directory listings from the key set, so it faithfully models the
 * atomic-write + listDir behavior the repository relies on.
 */
export class InMemoryFileSystem implements FileSystemPort {
  private files = new Map<string, string>();

  async readTextFile(rel: string): Promise<string | null> {
    return this.files.has(rel) ? this.files.get(rel)! : null;
  }

  async writeTextFileAtomic(rel: string, contents: string): Promise<void> {
    this.files.set(rel, contents);
  }

  async listDir(rel: string): Promise<string[]> {
    const prefix = rel.endsWith("/") ? rel : rel + "/";
    const names = new Set<string>();
    for (const path of this.files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      names.add(slash === -1 ? rest : rest.slice(0, slash));
    }
    return [...names];
  }

  async ensureDir(_rel: string): Promise<void> {
    // No directories to create in a flat map.
  }

  async remove(rel: string): Promise<void> {
    this.files.delete(rel);
  }

  // Test-only introspection.
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort());
  }
  has(rel: string): boolean {
    return this.files.has(rel);
  }
}
