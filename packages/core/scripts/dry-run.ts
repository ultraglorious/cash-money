/**
 * Dry-run import against the real exports + plan-oracle validation.
 *
 * Reads the export ZIPs and a runtime config (kept OUT of the repo — it names
 * real payees/accounts), runs the full pipeline WITHOUT persisting, then:
 *   1. prints the import report (counts, stitch histogram, net across accounts);
 *   2. compares the engine's derived activity/available per (category, month)
 *      against the exported plan numbers (the oracle), summarizing mismatches;
 *   3. re-runs the import and reconciles it to prove idempotency.
 *
 * The report is written outside the repo. Nothing is ever committed.
 *
 * Usage: tsx scripts/dry-run.ts <importDir> <configJson> <outFile>
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { computeProjection } from "../src/engine/compute.js";
import { stageImport, type SourceInput } from "../src/import/pipeline.js";
import { reconcileTransactions } from "../src/import/reconcile.js";
import type { ImportConfig } from "../src/import/config.js";
import type { Ulid } from "../src/ids.js";

interface DryRunConfig extends ImportConfig {
  sources: Array<ImportConfig["sources"][number] & { fileMatch: string }>;
}

function loadInputs(dir: string, config: DryRunConfig): SourceInput[] {
  const zips = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".zip"));
  return config.sources.map((s) => {
    const zip = zips.find((z) => z.toLowerCase().includes(s.fileMatch.toLowerCase()));
    if (!zip) throw new Error(`No ZIP matching "${s.fileMatch}" for source ${s.sourceKey}`);
    const files = unzipSync(readFileSync(join(dir, zip)));
    let registerCsv = "";
    let planCsv = "";
    for (const [name, bytes] of Object.entries(files)) {
      const text = new TextDecoder().decode(bytes);
      if (/register\.csv$/i.test(name)) registerCsv = text;
      else if (/plan\.csv$/i.test(name)) planCsv = text;
    }
    return { sourceKey: s.sourceKey, registerCsv, planCsv };
  });
}

function euro(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

function main(): void {
  const dir = resolve(process.argv[2]!);
  const configPath = resolve(process.argv[3]!);
  const outFile = resolve(process.argv[4]!);
  const config = JSON.parse(readFileSync(configPath, "utf-8")) as DryRunConfig;

  const inputs = loadInputs(dir, config);
  const { staging, oracle, report } = stageImport(inputs, config, config.exportDate);
  const p = computeProjection(staging);

  const lines: string[] = [];
  const log = (s = ""): void => {
    lines.push(s);
  };

  log(`# Dry-run import report`);
  log();
  log(`## Import summary`);
  for (const s of report.sources) log(`- ${s.label}: ${s.registerRows} register rows, ${s.planRows} plan rows`);
  log(`- Transactions: ${report.transactions} (unapproved/scheduled: ${report.unapproved})`);
  log(`- Accounts: ${report.accounts}; groups: ${report.groups}; categories: ${report.categories}; card links: ${report.creditCardLinks}`);
  log(`- Assignments (non-zero): ${report.assignments}; splits reconstructed: ${report.splitsReconstructed}`);
  log(`- Within-budget transfer pairs: ${report.transfers.withinPairs} (unpaired: ${report.transfers.withinUnpaired})`);
  log(`- Cross-budget stitched: ${report.transfers.crossMatched}; unmatched (left as txns): ${report.transfers.crossUnmatched}`);
  log(`- Cross-budget Δdays histogram: ${JSON.stringify(report.transfers.crossDeltaHistogram)}`);
  log(`- Net across accounts (approved): ${euro(report.netAcrossAccounts)}`);
  log(`- Unresolved accounts: ${report.unresolvedAccounts}; unresolved categories: ${report.unresolvedCategories}`);
  if (report.warnings.length) {
    log(`- Warnings (${report.warnings.length}): ${report.warnings.slice(0, 10).join("; ")}${report.warnings.length > 10 ? " …" : ""}`);
  }
  log();

  // Oracle: compare derived activity/available to exported plan numbers.
  const catName = new Map(staging.categories.map((c) => [c.id, c.name]));
  const incomeGroupIds = new Set(staging.groups.filter((g) => g.kind === "income").map((g) => g.id));
  const incomeCatIds = new Set(staging.categories.filter((c) => incomeGroupIds.has(c.groupId)).map((c) => c.id));

  let cells = 0;
  let activityMatch = 0;
  let availableMatch = 0;
  const activityDiffByCat = new Map<string, { count: number; magnitude: number }>();
  const availableDiffByCat = new Map<string, { count: number; magnitude: number }>();

  for (const [key, exported] of oracle) {
    const sep = key.indexOf("␟");
    const categoryId = key.slice(0, sep) as Ulid;
    const month = key.slice(sep + 1);
    if (incomeCatIds.has(categoryId)) continue;
    cells++;
    const derivedActivity = p.activityOf(categoryId, month);
    const derivedAvailable = p.availableOf(categoryId, month);
    if (derivedActivity === exported.activity) activityMatch++;
    else bump(activityDiffByCat, catName.get(categoryId) ?? categoryId, Math.abs(derivedActivity - exported.activity));
    if (derivedAvailable === exported.available) availableMatch++;
    else bump(availableDiffByCat, catName.get(categoryId) ?? categoryId, Math.abs(derivedAvailable - exported.available));
  }

  log(`## Oracle: derived vs exported plan (${cells} category-month cells)`);
  log(`- Activity matches exactly: ${activityMatch}/${cells} (${pct(activityMatch, cells)})`);
  log(`- Available matches exactly: ${availableMatch}/${cells} (${pct(availableMatch, cells)})`);
  log();
  log(`### Top activity mismatches by category (name, cells, total €)`);
  for (const [name, d] of topBy(activityDiffByCat, 15)) log(`- ${name}: ${d.count} cells, ${euro(d.magnitude)}`);
  log();
  log(`### Top available mismatches by category (name, cells, total €)`);
  for (const [name, d] of topBy(availableDiffByCat, 15)) log(`- ${name}: ${d.count} cells, ${euro(d.magnitude)}`);
  log();

  // Idempotency on real data.
  const second = stageImport(inputs, config, config.exportDate).staging.transactions;
  const rec = reconcileTransactions(staging.transactions, second);
  log(`## Idempotency (re-import the same export)`);
  log(`- added=${rec.report.added}, changed=${rec.report.changed}, unchanged=${rec.report.unchanged}, deleted=${rec.report.deleted}`);
  log(rec.report.added === 0 && rec.report.changed === 0 && rec.report.deleted === 0 ? "- ✅ idempotent" : "- ⚠️ NOT idempotent");

  writeFileSync(outFile, lines.join("\n") + "\n", "utf-8");
  console.log(`Transactions: ${report.transactions}, accounts: ${report.accounts}, categories: ${report.categories}`);
  console.log(`Cross-stitched: ${report.transfers.crossMatched}, net: ${euro(report.netAcrossAccounts)}`);
  console.log(`Oracle activity match: ${pct(activityMatch, cells)}, available: ${pct(availableMatch, cells)}`);
  console.log(`Idempotent: ${rec.report.added === 0 && rec.report.changed === 0 && rec.report.deleted === 0}`);
  console.log(`Report: ${outFile}`);
}

function bump(m: Map<string, { count: number; magnitude: number }>, key: string, mag: number): void {
  const e = m.get(key) ?? { count: 0, magnitude: 0 };
  e.count++;
  e.magnitude += mag;
  m.set(key, e);
}
function topBy(m: Map<string, { count: number; magnitude: number }>, n: number) {
  return [...m.entries()].sort((a, b) => b[1].magnitude - a[1].magnitude).slice(0, n);
}
function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${Math.round((100 * n) / d)}%`;
}

main();
