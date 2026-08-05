/**
 * Read-only anomaly survey of the real CSV exports.
 *
 * Reads the export ZIPs from a directory, parses the register + plan CSVs, and
 * writes a human-readable anomaly report. It NEVER writes into the repo or into
 * the source directory, and by default writes its report OUTSIDE the repo so no
 * real financial data is ever committed.
 *
 * Usage:
 *   tsx scripts/survey.ts <importDir> [outFile]
 *   IMPORT_DIR=/path/to/exports SURVEY_OUT=/tmp/report.md tsx scripts/survey.ts
 *
 * The cross-budget link payees are DISCOVERED statistically (amount+date overlap
 * between the two budgets), so no real names are hardcoded here.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { parsePlanCsv, parseRegisterCsv, type RawRegisterRow } from "../src/import/csv.js";
import { EUR, parseMoney } from "../src/money.js";
import { daysBetween, parseImportDate } from "../src/time.js";

const EXPORT_DATE = "2026-08-03"; // "as of" date; anything later is future-dated
const STITCH_WINDOW_DAYS = 3;

interface Source {
  label: string;
  register: RawRegisterRow[];
  plan: ReturnType<typeof parsePlanCsv>;
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function loadSources(dir: string): Source[] {
  const zips = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".zip"));
  if (zips.length === 0) throw new Error(`No .zip exports found in ${dir}`);
  const sources: Source[] = [];
  for (const zip of zips.sort()) {
    const files = unzipSync(readFileSync(join(dir, zip)));
    let registerText = "";
    let planText = "";
    for (const [name, bytes] of Object.entries(files)) {
      if (/register\.csv$/i.test(name)) registerText = decode(bytes);
      else if (/plan\.csv$/i.test(name)) planText = decode(bytes);
    }
    if (!registerText || !planText) {
      throw new Error(`ZIP ${zip} is missing a Register.csv or Plan.csv member`);
    }
    // Label from the zip name, trimmed of the timestamp/extension noise.
    const label = zip.replace(/\.zip$/i, "").replace(/\s+as of.*$/i, "").trim();
    sources.push({
      label,
      register: parseRegisterCsv(registerText),
      plan: parsePlanCsv(planText),
    });
  }
  return sources;
}

/** Signed minor units (inflow +, outflow -), or null if the amounts don't parse. */
function signedAmount(r: RawRegisterRow): number | null {
  try {
    const inflow = r.inflow.trim() ? parseMoney(r.inflow, EUR) : 0;
    const outflow = r.outflow.trim() ? parseMoney(r.outflow, EUR) : 0;
    return inflow - outflow;
  } catch {
    return null;
  }
}

function isWithinTransfer(r: RawRegisterRow): boolean {
  return /^transfer\s*:/i.test(r.payee.trim());
}

function counter<T>(items: Iterable<T>): Map<T, number> {
  const m = new Map<T, number>();
  for (const it of items) m.set(it, (m.get(it) ?? 0) + 1);
  return m;
}

function pct(n: number, d: number): string {
  return d === 0 ? "0%" : `${Math.round((100 * n) / d)}%`;
}

// ---- Per-source anomaly analysis -------------------------------------------

function surveySource(s: Source): string[] {
  const out: string[] = [];
  const reg = s.register;
  out.push(`### Source: ${s.label}`);
  out.push("");
  out.push(`- Register rows: **${reg.length}**, Plan rows: **${s.plan.length}**`);

  // Accounts.
  const accounts = counter(reg.map((r) => r.account));
  out.push(`- Accounts (${accounts.size}):`);
  for (const [a, n] of [...accounts].sort((x, y) => y[1] - x[1])) {
    out.push(`    - ${a}: ${n}`);
  }

  // Category groups + whitespace/case collisions.
  const groupsRaw = new Set(reg.map((r) => r.group).concat(s.plan.map((p) => p.group)));
  out.push(`- Category groups (${[...groupsRaw].filter(Boolean).length}): ${[...groupsRaw].filter(Boolean).sort().join(", ")}`);
  const catRaw = new Set(
    reg.map((r) => r.category).concat(s.plan.map((p) => p.category)).filter(Boolean),
  );
  const foldMap = new Map<string, Set<string>>();
  for (const c of catRaw) {
    const fold = c.trim().toLowerCase();
    (foldMap.get(fold) ?? foldMap.set(fold, new Set()).get(fold)!).add(c);
  }
  const collisions = [...foldMap.values()].filter((set) => set.size > 1);
  out.push(`- Categories: ${catRaw.size} distinct; whitespace/case collisions: **${collisions.length}**`);
  for (const set of collisions) out.push(`    - ${[...set].map((x) => JSON.stringify(x)).join(" ⟷ ")}`);

  // Cleared / flags.
  const cleared = counter(reg.map((r) => r.cleared || "(blank)"));
  out.push(`- Cleared: ${[...cleared].map(([k, v]) => `${k}=${v}`).join(", ")}`);
  const flags = counter(reg.map((r) => r.flag).filter(Boolean));
  out.push(`- Flags: ${flags.size === 0 ? "none" : [...flags].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  // Parse failures.
  let dateFail = 0;
  let amtFail = 0;
  let future = 0;
  const exportDay = parseImportDate(`${EXPORT_DATE.slice(8)}.${EXPORT_DATE.slice(5, 7)}.${EXPORT_DATE.slice(0, 4)}`);
  for (const r of reg) {
    let iso: string | null = null;
    try {
      iso = parseImportDate(r.date);
    } catch {
      dateFail++;
    }
    if (signedAmount(r) === null) amtFail++;
    if (iso && iso > exportDay) future++;
  }
  out.push(`- Date parse failures: **${dateFail}**; amount parse failures: **${amtFail}**`);
  out.push(`- Future-dated rows (after ${EXPORT_DATE}): **${future}**`);

  // Empty-category non-transfer rows.
  const emptyCat = reg.filter((r) => !r.category.trim() && !isWithinTransfer(r));
  out.push(`- Non-transfer rows with empty category: **${emptyCat.length}**`);

  // Within-budget transfers: pairing balance + near-duplicate clusters.
  const transfers = reg.filter(isWithinTransfer);
  const xferGroups = new Map<string, RawRegisterRow[]>();
  for (const r of transfers) {
    const other = r.payee.replace(/^transfer\s*:/i, "").trim();
    const accts = [r.account.trim(), other].sort();
    const amt = signedAmount(r) ?? 0;
    const key = `${parseSafe(r.date)}|${accts.join("<->")}|${Math.abs(amt)}`;
    (xferGroups.get(key) ?? xferGroups.set(key, []).get(key)!).push(r);
  }
  let unbalanced = 0;
  let nearDupClusters = 0;
  for (const rows of xferGroups.values()) {
    const outs = rows.filter((r) => (signedAmount(r) ?? 0) < 0).length;
    const ins = rows.filter((r) => (signedAmount(r) ?? 0) > 0).length;
    if (outs !== ins) unbalanced++;
    if (rows.length > 2) nearDupClusters++;
  }
  out.push(
    `- Within-budget transfer legs: **${transfers.length}**; ` +
      `unbalanced pair-keys: **${unbalanced}**; near-duplicate clusters (>1 pair same key): **${nearDupClusters}**`,
  );

  // Duplicate transactions (identical natural key).
  const dupKeys = counter(
    reg
      .filter((r) => !isWithinTransfer(r))
      .map((r) => `${r.account}|${parseSafe(r.date)}|${r.payee}|${signedAmount(r)}|${r.memo}`),
  );
  const dupGroups = [...dupKeys.values()].filter((n) => n > 1);
  out.push(
    `- Exact-duplicate transaction keys: **${dupGroups.length}** groups, ` +
      `${dupGroups.reduce((a, b) => a + b, 0)} rows involved (need occurrence-index disambiguation)`,
  );

  out.push("");
  return out;
}

function parseSafe(date: string): string {
  try {
    return parseImportDate(date);
  } catch {
    return date;
  }
}

// ---- Cross-source stitch discovery -----------------------------------------

interface AmtIndexEntry {
  iso: string;
  payee: string;
  signed: number;
}

function analyzeCross(a: Source, b: Source): string[] {
  const out: string[] = [];
  out.push(`## Cross-source stitch discovery: ${a.label} ⟷ ${b.label}`);
  out.push("");
  out.push(
    "For each non-transfer row in one budget, we look for a row in the other budget " +
      `with the SAME absolute amount and a date within ±${STITCH_WINDOW_DAYS} days. Payees ` +
      "with a high match-rate are the real cross-budget links; low match-rate payees " +
      "(e.g. a budget's own bank) are false positives to exclude.",
  );
  out.push("");

  const indexB = buildAmtIndex(b);
  reportDirection(a, indexB, `${a.label} → ${b.label}`, out);

  const indexA = buildAmtIndex(a);
  reportDirection(b, indexA, `${b.label} → ${a.label}`, out);

  return out;
}

function buildAmtIndex(s: Source): Map<number, AmtIndexEntry[]> {
  const idx = new Map<number, AmtIndexEntry[]>();
  for (const r of s.register) {
    if (isWithinTransfer(r)) continue;
    const signed = signedAmount(r);
    if (signed === null || signed === 0) continue;
    let iso: string;
    try {
      iso = parseImportDate(r.date);
    } catch {
      continue;
    }
    const abs = Math.abs(signed);
    (idx.get(abs) ?? idx.set(abs, []).get(abs)!).push({ iso, payee: r.payee, signed });
  }
  return idx;
}

function reportDirection(
  from: Source,
  otherIndex: Map<number, AmtIndexEntry[]>,
  title: string,
  out: string[],
): void {
  // Aggregate per payee: total rows, matched rows, min date-delta histogram.
  const perPayee = new Map<string, { total: number; matched: number; deltas: number[] }>();
  for (const r of from.register) {
    if (isWithinTransfer(r)) continue;
    const signed = signedAmount(r);
    if (signed === null || signed === 0) continue;
    let iso: string;
    try {
      iso = parseImportDate(r.date);
    } catch {
      continue;
    }
    const agg = perPayee.get(r.payee) ?? { total: 0, matched: 0, deltas: [] };
    agg.total++;
    const candidates = otherIndex.get(Math.abs(signed)) ?? [];
    let best = Infinity;
    for (const c of candidates) {
      // Same sign from a shared perspective => opposite raw signs across budgets.
      const delta = daysBetween(iso, c.iso);
      if (delta < best) best = delta;
    }
    if (best <= STITCH_WINDOW_DAYS) {
      agg.matched++;
      agg.deltas.push(best);
    }
    perPayee.set(r.payee, agg);
  }

  const ranked = [...perPayee.entries()]
    .filter(([, v]) => v.matched > 0)
    .sort((x, y) => y[1].matched - x[1].matched)
    .slice(0, 10);

  out.push(`### ${title}`);
  out.push("");
  out.push("| Payee | rows | matched | match-rate | Δdays hist (0/1/2/3) |");
  out.push("|---|---:|---:|---:|---|");
  for (const [payee, v] of ranked) {
    const hist = [0, 1, 2, 3].map((d) => v.deltas.filter((x) => x === d).length).join("/");
    out.push(`| ${payee} | ${v.total} | ${v.matched} | ${pct(v.matched, v.total)} | ${hist} |`);
  }
  out.push("");
}

// ---- Main ------------------------------------------------------------------

function main(): void {
  const dir = resolve(process.argv[2] ?? process.env.IMPORT_DIR ?? "");
  if (!dir) {
    console.error("Usage: tsx scripts/survey.ts <importDir> [outFile]");
    process.exit(2);
  }
  // Default output goes to a temp dir — NEVER near the repo — so real financial
  // data can't be committed by accident. Pass an explicit path to override.
  const out = process.argv[3] ?? process.env.SURVEY_OUT ?? join(tmpdir(), "import-anomaly-report.md");

  const sources = loadSources(dir);

  const lines: string[] = [];
  lines.push(`# Import anomaly survey`);
  lines.push("");
  lines.push(`Sources: ${sources.map((s) => s.label).join(", ")}. Export "as of" ${EXPORT_DATE}.`);
  lines.push("");
  lines.push(`## Per-source anomalies`);
  lines.push("");
  for (const s of sources) lines.push(...surveySource(s));

  if (sources.length >= 2) {
    lines.push(...analyzeCross(sources[0]!, sources[1]!));
  }

  const report = lines.join("\n") + "\n";
  writeFileSync(out, report, "utf-8");

  // Terse stdout summary (no raw payee data).
  console.log(`Surveyed ${sources.length} source(s):`);
  for (const s of sources) {
    console.log(`  - ${s.label}: ${s.register.length} register rows, ${s.plan.length} plan rows`);
  }
  console.log(`Report written to: ${out}`);
}

main();
