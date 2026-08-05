import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateFormat } from "../format.js";
import { builtinFormat, builtinFormats } from "./index.js";

/**
 * Guardrail for the contributable format library: every JSON file in this
 * directory must validate against RegisterFormatSchema, carry a lib: id
 * matching its filename, and be registered in index.ts.
 */

const dir = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith(".json"));

describe("format library", () => {
  it("contains at least the budget-export format", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(builtinFormat("lib:budget-export-register")).toBeDefined();
  });

  it.each(files)("%s validates and matches its filename", (file) => {
    const data: unknown = JSON.parse(readFileSync(join(dir, file), "utf-8"));
    const format = validateFormat(data); // throws with a readable message on failure
    expect(format.id).toBe(`lib:${file.replace(/\.json$/, "")}`);
  });

  it("registers every file in the index, with unique ids", () => {
    expect(builtinFormats).toHaveLength(files.length);
    const ids = builtinFormats.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("rejects a malformed format with a readable error", () => {
    expect(() => validateFormat({ id: "lib:x", name: "X" })).toThrow(/Invalid register format at date/);
    expect(() =>
      validateFormat({
        id: "lib:x",
        name: "X",
        date: { column: "Date", format: "dmy" },
        amount: { mode: "signed", column: "Amount" },
        payeeColumn: "Payee",
        transfer: { mode: "payeePattern", pattern: "([unclosed" },
      }),
    ).toThrow(/regular expression/);
  });
});
