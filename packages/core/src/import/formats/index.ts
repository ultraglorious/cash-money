import { validateFormat, type RegisterFormat } from "../format.js";
import budgetExportRegister from "./budget-export-register.json";

/**
 * The repo's format library: one JSON file per known CSV shape, validated at
 * module load so a malformed entry fails tests immediately, never a user's
 * import. To contribute a format: add a `<slug>.json` conforming to
 * `RegisterFormat` (id `lib:<slug>`), import it here, and append it below —
 * `formats.test.ts` picks it up automatically.
 */
export const builtinFormats: readonly RegisterFormat[] = [
  validateFormat(budgetExportRegister),
];

/** Look up a library format by id (e.g. "lib:budget-export-register"). */
export function builtinFormat(id: string): RegisterFormat | undefined {
  return builtinFormats.find((f) => f.id === id);
}
