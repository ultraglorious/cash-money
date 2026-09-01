import { useEffect, useMemo, useState } from "react";
import {
  Accordion,
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Collapse,
  Divider,
  Group,
  Modal,
  Paper,
  Radio,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
  TextInput,
  Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconFileImport, IconTrash } from "@tabler/icons-react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  buildStatementTransactions,
  deduceInvoiceCoverage,
  findTransferCandidates,
  formatFitsHeaders,
  lastCategoryByPayee,
  nameIncomingRow,
  technicalKey,
  guessFormat,
  mergeImport,
  newId,
  parseCsv,
  reconcileStatement,
  stageImport,
  type CurrencyConfig,
  type ImportConfig,
  type InvoiceCoverage,
  type RegisterFormat,
  type ProposedName,
  type SavedFormat,
  type StagingResult,
  type StatementReconcile,
  type Transaction,
  type Ulid,
} from "@cash-money/core";
import { useApp } from "../../state";
import { LinkTransfersModal } from "../transactions/LinkTransfersModal";
import { categoryOptions, incomeCategoryOptions } from "../../categoryOptions";
import { money } from "../../format";
import { isTauri, readTextAbs, readZipCsvs } from "../../platform/tauriFs";
import {
  buildFormat,
  EMPTY_MAPPING,
  FormatMappingForm,
  mappingComplete,
  stateFromFormat,
  stateFromGuess,
  type MappingState,
} from "./FormatMappingForm";

const IMPORT_LINK_NOTIFICATION = "import-link-transfers";

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "src";
const today = () => new Date().toISOString().slice(0, 10);
function parseAsOf(name: string): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name);
  return m ? m[1]! : today();
}

/** One wizard for both import kinds: full budget exports and bank statements. */
export function ImportWizard({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const app = useApp();
  const [mode, setMode] = useState<"export" | "statement">("export");
  const [resetSeq, setResetSeq] = useState(0);
  const [linkOpen, linkCtrl] = useDisclosure(false);
  // An import is exactly when the other half of a transfer arrives, so it is
  // the moment to offer linking — not a sidebar entry visited weeks later.
  // The check waits for the budget to actually carry the imported rows.
  const [checkForPairs, setCheckForPairs] = useState(false);
  const close = () => {
    setResetSeq((n) => n + 1); // remount panes so nothing leaks between sessions
    onClose();
  };
  const done = () => {
    setCheckForPairs(true);
    close();
  };

  useEffect(() => {
    if (!checkForPairs) return;
    setCheckForPairs(false);
    const found = findTransferCandidates(app.budget);
    if (found.length === 0) return;
    const confident = found.filter((c) => c.confidence === "high").length;
    notifications.show({
      id: IMPORT_LINK_NOTIFICATION,
      color: "blue",
      autoClose: false,
      title: `${found.length} possible transfer${found.length === 1 ? "" : "s"} to link`,
      message: (
        <Group gap="xs" align="center">
          <Text size="sm">
            {confident > 0
              ? `${confident} look confident — money moved between your own accounts, recorded twice.`
              : "None are confident, so they're worth a look before anything happens."}
          </Text>
          <Button size="compact-xs" variant="light" onClick={() => { notifications.hide(IMPORT_LINK_NOTIFICATION); linkCtrl.open(); }}>
            Review
          </Button>
        </Group>
      ),
    });
  }, [checkForPairs, app.budget, linkCtrl]);

  return (
    <>
    <Modal opened={opened} onClose={close} title="Import" size="xl" centered>
      <Stack>
        {!isTauri() && (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
            Importing reads files from disk, so it's only available in the desktop app (not this browser preview).
          </Alert>
        )}
        <SegmentedControl
          data={[
            { label: "Budget export (.zip)", value: "export" },
            { label: "Bank statement (.csv)", value: "statement" },
          ]}
          value={mode}
          onChange={(v) => setMode(v as typeof mode)}
        />
        {mode === "export" ? <ExportPane key={`e${resetSeq}`} onDone={done} /> : <StatementPane key={`s${resetSeq}`} onDone={done} />}
      </Stack>
    </Modal>
    {/* A sibling, not a child: the wizard is closed by the time this opens. */}
    <LinkTransfersModal opened={linkOpen} onClose={linkCtrl.close} />
    </>
  );
}

// ---- Budget-export pane -------------------------------------------------------

interface SourceDraft {
  path: string;
  sourceKey: string;
  household: string;
  register: string;
  plan: string;
  exportDate: string;
}

function ExportPane({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const [sources, setSources] = useState<SourceDraft[]>([]);
  const [result, setResult] = useState<StagingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pick = async () => {
    setError(null);
    try {
      const selected = await open({ multiple: true, filters: [{ name: "Budget export", extensions: ["zip"] }] });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const drafts: SourceDraft[] = [];
      const taken = new Set(sources.map((s) => s.sourceKey));
      for (const path of paths) {
        const members = await readZipCsvs(path);
        const register = members.find((m) => /register\.csv$/i.test(m.name))?.content ?? "";
        const plan = members.find((m) => /plan\.csv$/i.test(m.name))?.content ?? "";
        const base = path.split(/[/\\]/).pop()!.replace(/\.zip$/i, "");
        const household = base.replace(/\s*as of.*$/i, "").trim() || base;
        // sourceKey must be STABLE across imports of the same export series —
        // identities include it, so a fresh key would make nothing match on a
        // merge re-import. Derive it from the filename's budget name alone.
        let sourceKey = slug(household);
        for (let n = 2; taken.has(sourceKey); n++) sourceKey = `${slug(household)}-${n}`;
        taken.add(sourceKey);
        drafts.push({ path, sourceKey, household, register, plan, exportDate: parseAsOf(base) });
      }
      setSources((s) => [...s, ...drafts]);
      setResult(null);
    } catch (e) {
      setError(`Could not read files: ${String(e)}`);
    }
  };

  const updateSource = (key: string, patch: Partial<SourceDraft>) =>
    setSources((ss) => ss.map((s) => (s.sourceKey === key ? { ...s, ...patch } : s)));
  const removeSource = (key: string) => setSources((ss) => ss.filter((s) => s.sourceKey !== key));

  const runDryRun = () => {
    setError(null);
    try {
      const config: ImportConfig = {
        currency: app.currency,
        budgetName: app.budget.budget.name,
        sources: sources.map((s) => ({ sourceKey: s.sourceKey, label: s.household, household: s.household, exportDate: s.exportDate })),
        trackingAccountHints: ["investment", "etf", "etc", "shares", "deposit"],
      };
      const inputs = sources.map((s) => ({ sourceKey: s.sourceKey, registerCsv: s.register, planCsv: s.plan || undefined }));
      setResult(stageImport(inputs, config, today()));
    } catch (e) {
      setError(String(e));
      setResult(null);
    }
  };

  // Merge only makes sense when the staged sources match provenance already in
  // the budget — otherwise nothing would identity-match and imported history
  // would simply duplicate.
  const hasData = app.budget.transactions.length > 0;
  const sourceOverlap =
    result !== null &&
    (() => {
      const stagedKeys = new Set(result.staging.transactions.map((t) => t.source?.sourceBudget).filter(Boolean));
      return app.budget.transactions.some((t) => t.source && stagedKeys.has(t.source.sourceBudget));
    })();
  const [commitMode, setCommitMode] = useState<"merge" | "replace">("replace");
  useEffect(() => {
    setCommitMode(sourceOverlap ? "merge" : "replace");
  }, [sourceOverlap]);

  const commit = () => {
    if (!result) return;
    if (commitMode === "merge") {
      const { merged } = mergeImport(app.budget, result.staging);
      app.replaceBudget(merged);
    } else {
      app.replaceBudget(result.staging);
    }
    app.setView({ kind: "plan" });
    onDone();
  };

  return (
    <Stack>
      <Group>
        <Button leftSection={<IconFileImport size={16} />} onClick={pick} disabled={!isTauri()}>
          Choose export files…
        </Button>
        <Text size="sm" c="dimmed">
          Pick one or more exported <code>.zip</code> budgets (each with a Register + Plan CSV).
        </Text>
      </Group>

      {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}

      {sources.length > 0 && (
        <>
          <Text size="xs" c="dimmed">
            Each file becomes its own <b>household</b> — a separate section in the Plan with its own Ready-to-Assign.
            The “as of” date is read from the filename; rows dated after it import as scheduled (unapproved).
          </Text>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>File</Table.Th>
                <Table.Th>Household</Table.Th>
                <Table.Th w={140}>As of</Table.Th>
                <Table.Th w={40} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sources.map((s) => (
                <Table.Tr key={s.sourceKey}>
                  <Table.Td><Text size="sm" lineClamp={1}>{s.path.split(/[/\\]/).pop()}</Text></Table.Td>
                  <Table.Td><TextInput size="xs" value={s.household} onChange={(e) => updateSource(s.sourceKey, { household: e.currentTarget.value })} /></Table.Td>
                  <Table.Td><TextInput size="xs" value={s.exportDate} placeholder="YYYY-MM-DD" onChange={(e) => updateSource(s.sourceKey, { exportDate: e.currentTarget.value })} /></Table.Td>
                  <Table.Td><ActionIcon variant="subtle" color="red" onClick={() => removeSource(s.sourceKey)} aria-label="Remove"><IconTrash size={15} /></ActionIcon></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>

          <Text size="xs" c="dimmed">
            Money that moves between your budgets is kept as it was recorded — income on the receiving side, a
            categorised expense on the sending side — which is what makes each household's Ready-to-Assign come out
            right.
          </Text>

          <Group>
            <Button variant="light" onClick={runDryRun}>Preview import (dry run)</Button>
          </Group>
        </>
      )}

      {result && (
        <ReportView
          result={result}
          currency={app.currency}
          onCommit={commit}
          hasData={hasData}
          sourceOverlap={sourceOverlap}
          mode={commitMode}
          setMode={setCommitMode}
        />
      )}
    </Stack>
  );
}

function ReportView({ result, currency, onCommit, hasData, sourceOverlap, mode, setMode }: {
  result: StagingResult;
  currency: CurrencyConfig;
  onCommit: () => void;
  hasData: boolean;
  sourceOverlap: boolean;
  mode: "merge" | "replace";
  setMode: (m: "merge" | "replace") => void;
}) {
  const r = result.report;
  const row = (label: string, value: string) => (
    <Group justify="space-between"><Text size="sm" c="dimmed">{label}</Text><Text size="sm" fw={500}>{value}</Text></Group>
  );
  return (
    <Paper withBorder p="md" radius="md">
      <Title order={5} mb="xs">Dry-run report</Title>
      <Stack gap={4}>
        {row("Transactions", `${r.transactions} (${r.unapproved} scheduled)`)}
        {row("Accounts / sections / categories", `${r.accounts} / ${r.groups} / ${r.categories}`)}
        {row("Non-zero assignments", `${r.assignments}`)}
        {row("Splits reconstructed", `${r.splitsReconstructed}`)}
        {row("Within-budget transfer pairs", `${r.transfers.withinPairs} (${r.transfers.withinUnpaired} unpaired)`)}
        {row("Net across accounts", money(r.netAcrossAccounts, currency))}
        {(r.unresolvedAccounts > 0 || r.unresolvedCategories > 0) && (
          <Badge color="orange" variant="light">unresolved: {r.unresolvedAccounts} accounts, {r.unresolvedCategories} categories</Badge>
        )}
        {r.warnings.length > 0 && (
          <Alert color="yellow" mt="xs" icon={<IconAlertTriangle size={16} />}>
            {r.warnings.length} warning{r.warnings.length === 1 ? "" : "s"}: {r.warnings.slice(0, 5).join("; ")}{r.warnings.length > 5 ? " …" : ""}
          </Alert>
        )}
      </Stack>
      <Divider my="md" />
      {hasData ? (
        <Stack gap="xs">
          <Radio.Group value={mode} onChange={(v) => setMode(v as "merge" | "replace")}>
            <Stack gap={6}>
              <Radio
                value="merge"
                disabled={!sourceOverlap}
                label="Merge into the current budget"
                description={
                  sourceOverlap
                    ? "Keeps transactions you added in the app, bank-statement imports, and your account/category settings; the snapshot updates its own rows."
                    : "Unavailable: nothing in the current budget came from these sources, so merging would duplicate the imported history."
                }
              />
              <Radio
                value="replace"
                label="Replace the current budget"
                description="Discards everything currently in the app and starts from this import."
              />
            </Stack>
          </Radio.Group>
          <Group justify="flex-end">
            <Button color="teal" onClick={onCommit}>{mode === "merge" ? "Merge import" : "Replace budget"}</Button>
          </Group>
        </Stack>
      ) : (
        <Group justify="flex-end">
          <Button color="teal" onClick={onCommit}>Commit import</Button>
        </Group>
      )}
    </Paper>
  );
}

// ---- Bank-statement pane --------------------------------------------------------

const NEW_MAPPING = "new";

interface ParsedCsvFile {
  fileName: string;
  text: string;
  headers: string[];
  rowCount: number;
}

/** Payee/category tweaks for rows about to be added, keyed by sourceRow. */
interface RowEdit {
  payee?: string;
  categoryId?: string | null;
}

/** Structural identity of a mapping — same columns, regardless of id/name. */
const formatShape = (f: RegisterFormat): string => JSON.stringify({ ...f, id: "", name: "" });

function StatementPane({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const [parsed, setParsed] = useState<ParsedCsvFile | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedFormat[]>([]);
  const [formatChoice, setFormatChoice] = useState<string>(NEW_MAPPING);
  const [mapping, setMapping] = useState<MappingState>(EMPTY_MAPPING);
  const [trueDate, setTrueDate] = useState<RegisterFormat["trueDate"]>(undefined);
  const [mappingOpen, setMappingOpen] = useState(true);
  const [recalled, setRecalled] = useState(false);
  const [result, setResult] = useState<StatementReconcile | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set()); // sourceRow keys
  const [edits, setEdits] = useState<Map<number, RowEdit>>(new Map());
  // What the app suggested each row was called, so a correction can be told
  // apart from an acceptance — only corrections are worth remembering.
  const [proposed, setProposed] = useState<Map<number, ProposedName>>(new Map());
  const [previouslySkipped, setPreviouslySkipped] = useState<Set<number>>(new Set());
  const [coverageOn, setCoverageOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isCard = app.budget.accounts.find((a) => a.id === accountId)?.type === "creditCard";

  /** Ticked statement rows as they would land in the budget (for coverage preview). */
  const stagedRows = (r: StatementReconcile, ticked: Set<number>): Transaction[] =>
    r.toAdd
      .filter((row) => ticked.has(row.sourceRow))
      .map((row) => ({
        id: `stmt-row-${row.sourceRow}` as Ulid,
        accountId: accountId as Ulid,
        date: row.date,
        effectiveDate: row.date,
        payee: row.payee,
        memo: row.memo,
        amount: row.amount,
        cleared: "uncleared" as const,
        approved: true,
      }));

  // Invoice deduction preview: which card payment settles which billing
  // window, given the rows about to be added. A statement match alone never
  // marks a card row paid — this is what does.
  const coverage = useMemo<InvoiceCoverage | null>(() => {
    if (!result || !isCard || !accountId) return null;
    return deduceInvoiceCoverage([...app.budget.transactions, ...stagedRows(result, selected)], accountId as Ulid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, selected, accountId, isCard, app.budget]);
  const settledCount = useMemo(() => {
    if (!coverage) return 0;
    const clearedOf = new Map(app.budget.transactions.map((t) => [t.id, t.cleared]));
    return coverage.covered.filter((id) => clearedOf.get(id) !== "reconciled").length;
  }, [coverage, app.budget]);

  useEffect(() => {
    app.loadFormats().then(setSaved).catch(() => setSaved([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reconcile = async (file: ParsedCsvFile, format: RegisterFormat, accId: string) => {
    setError(null);
    try {
      const sourceKey = await app.statementSourceKey(accId as Ulid, format.id);
      const r = reconcileStatement(app.budget, file.text, format, {
        sourceKey,
        accountId: accId as Ulid,
        currency: app.currency,
      });
      setResult(r);
      // Everything is ticked except the rows you left unticked before. They are
      // still listed and still tickable — skipping is a default for next time,
      // not a disappearance.
      const skippedBefore = new Set(app.listSkippedRows().map((x) => x.identity));
      setPreviouslySkipped(new Set(r.toAdd.filter((row) => skippedBefore.has(row.identity)).map((row) => row.sourceRow)));
      setSelected(new Set(r.toAdd.filter((row) => !skippedBefore.has(row.identity)).map((row) => row.sourceRow)));
      // Rows the bank didn't name arrive blank, which is unreadable without the
      // statement open beside you. Seed each row with the best name available —
      // what this counterparty or this description was called last time, or the
      // description itself cleaned up — and the category that name usually gets.
      // These are seeds in an editable field, not decisions.
      const categories = lastCategoryByPayee(app.budget);
      const payees = app.budget.payees ?? [];
      const seeded = new Map<number, RowEdit>();
      const named = new Map<number, ProposedName>();
      for (const row of r.toAdd) {
        const proposal = nameIncomingRow({ payee: row.payee, memo: row.memo }, payees, categories);
        named.set(row.sourceRow, proposal);
        if (proposal.payee !== row.payee || proposal.categoryId) {
          seeded.set(row.sourceRow, {
            payee: proposal.payee,
            ...(proposal.categoryId ? { categoryId: proposal.categoryId } : {}),
          });
        }
      }
      setProposed(named);
      setEdits(seeded);
    } catch (e) {
      setError(String(e));
      setResult(null);
    }
  };

  const pick = async () => {
    setError(null);
    try {
      const selectedFile = await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!selectedFile || Array.isArray(selectedFile)) return;
      const text = await readTextAbs(selectedFile);
      const { headers, rows } = parseCsv(text);
      const file: ParsedCsvFile = { fileName: selectedFile.split(/[/\\]/).pop() ?? selectedFile, text, headers, rowCount: rows.length };
      setParsed(file);
      setResult(null);
      setRecalled(false);

      // Recall: a saved mapping whose columns all exist in this file, preferring
      // the one last reconciled into a still-open account — then just run it.
      const formats = await app.loadFormats().catch(() => [] as SavedFormat[]);
      setSaved(formats);
      const fits = formats.filter((s) => formatFitsHeaders(s.format, headers));
      const sources = await app.listStatementSources().catch(() => []);
      for (const src of sources) {
        const f = fits.find((s) => s.format.id === src.formatId);
        const acc = app.budget.accounts.find((a) => a.id === src.accountId && !a.closed);
        if (f && acc) {
          setFormatChoice(f.format.id);
          setMapping(stateFromFormat(f.format));
          setTrueDate(f.format.trueDate);
          setMappingOpen(false);
          setAccountId(acc.id);
          setRecalled(true);
          await reconcile(file, f.format, acc.id);
          return;
        }
      }
      if (fits.length > 0) {
        // Known bank, but no account on record — prefill, let the user pick.
        const newest = [...fits].sort((a, b) => (b.lastUsed ?? "").localeCompare(a.lastUsed ?? ""))[0]!;
        setFormatChoice(newest.format.id);
        setMapping(stateFromFormat(newest.format));
        setTrueDate(newest.format.trueDate);
        setMappingOpen(false);
      } else {
        setFormatChoice(NEW_MAPPING);
        setMapping(stateFromGuess(headers));
        setTrueDate(guessFormat(headers, rows.slice(0, 5)).trueDate);
        setMappingOpen(true);
      }
      if (!accountId) setAccountId(app.budget.accounts[0]?.id ?? null);
    } catch (e) {
      setError(`Could not read the file: ${String(e)}`);
    }
  };

  const chooseFormat = (id: string | null) => {
    const choice = id ?? NEW_MAPPING;
    setFormatChoice(choice);
    setResult(null);
    setRecalled(false);
    if (choice === NEW_MAPPING) {
      if (parsed) {
        setMapping(stateFromGuess(parsed.headers));
        const { rows } = parseCsv(parsed.text);
        setTrueDate(guessFormat(parsed.headers, rows.slice(0, 5)).trueDate);
      }
      setMappingOpen(true);
      return;
    }
    const f = saved.find((s) => s.format.id === choice)?.format;
    if (f) {
      setMapping(stateFromFormat(f));
      setTrueDate(f.trueDate);
      setMappingOpen(false);
    }
  };

  const currentFormat = (): RegisterFormat => ({
    ...buildFormat(mapping, formatChoice === NEW_MAPPING ? "adhoc:bank-statement" : formatChoice, "Bank statement"),
    ...(trueDate ? { trueDate } : {}),
  });

  const commit = async () => {
    if (!accountId || !result) return;
    const accId = accountId as Ulid;

    // The mapping is remembered automatically: a new one is saved under the
    // account's name (deduped by structure), a known one gets its lastUsed
    // bumped — and the account remembers it via statementSourceKey below.
    let durable = currentFormat();
    if (formatChoice === NEW_MAPPING) {
      const dupe = saved.find((s) => formatShape(s.format) === formatShape(durable));
      if (dupe) {
        durable = dupe.format;
        await app.saveFormats(saved.map((s) => (s === dupe ? { ...s, lastUsed: today() } : s))).catch(() => undefined);
      } else {
        durable = { ...buildFormat(mapping, newId(), `${app.accountName(accId)} statement`), ...(trueDate ? { trueDate } : {}) };
        await app.saveFormats([...saved, { format: durable, lastUsed: today() }]).catch(() => undefined);
      }
    } else {
      // Edits to a chosen mapping are saved back to it. They used to apply to
      // the import in hand and then vanish, so adding a column meant either
      // re-doing it every time or accumulating near-duplicate mappings.
      const previous = saved.find((s) => s.format.id === formatChoice)?.format;
      durable = { ...durable, name: previous?.name ?? durable.name };
      await app
        .saveFormats(saved.map((s) => (s.format.id === formatChoice ? { format: durable, lastUsed: today() } : s)))
        .catch(() => undefined);
    }
    const sourceKey = await app.statementSourceKey(accId, durable.id);

    const rows = result.toAdd.filter((r) => selected.has(r.sourceRow));
    let added: Transaction[] = [];
    if (rows.length > 0) {
      // A card swipe on the statement exists but isn't PAID — it enters
      // uncleared and gets settled by invoice deduction below. A cash-account
      // debit on the statement was paid, so it enters reconciled.
      const built = buildStatementTransactions(rows, { sourceKey, accountId: accId, currency: app.currency }, isCard ? "uncleared" : "reconciled");
      added = built.map((tx, i) => {
        const e = edits.get(rows[i]!.sourceRow);
        const payee = e?.payee?.trim();
        return { ...tx, ...(payee ? { payee } : {}), ...(e?.categoryId ? { categoryId: e.categoryId as Ulid } : {}) };
      });
      app.addTransactions(added);

      // Learn only from CORRECTIONS. Accepting a suggested match teaches
      // nothing — and the strings that carry a per-transaction id ("RIDECO.EU/O/
      // 2607150000") would fill the list with keys that never recur.
      for (const row of rows) {
        const proposal = proposed.get(row.sourceRow);
        const chosen = (edits.get(row.sourceRow)?.payee ?? proposal?.payee ?? row.payee).trim();
        const key = technicalKey({ payee: row.payee, memo: row.memo });
        if (!chosen || !key) continue;
        if (proposal && chosen === proposal.payee) continue; // accepted, not corrected
        app.rememberPayeeAlias(chosen, key);
      }
    }
    if (result.parsedRows > 0) {
      // Matched card rows are verified, not paid — only the through-date
      // advances; cash-account matches were settled, so they reconcile.
      app.reconcileAccount(accId, isCard ? [] : result.matches.map((m) => m.txId), result.check.to);
    }
    if (isCard && coverageOn) {
      const cov = deduceInvoiceCoverage([...app.budget.transactions, ...added], accId);
      if (cov) {
        const clearedOf = new Map(app.budget.transactions.map((t) => [t.id, t.cleared]));
        const newly = cov.covered.filter((id) => clearedOf.get(id) !== "reconciled");
        if (newly.length > 0) app.setClearedStatus(newly, "reconciled");
      }
    }
    // What you left unticked becomes next time's default; what you ticked stops
    // being one. Neither hides anything: both sides of the decision are just a
    // starting position for the next statement that covers these days.
    const today2 = today();
    app.recordSkippedRows(
      result.toAdd
        .filter((r) => !selected.has(r.sourceRow))
        .map((r) => ({ identity: r.identity, sourceKey, since: today2 })),
      rows.map((r) => r.identity),
    );

    app.setView({ kind: "account", accountId: accId });
    onDone();
  };

  const formatOptions = [
    { value: NEW_MAPPING, label: "New mapping…" },
    ...saved.map((s) => ({ value: s.format.id, label: s.format.name })),
  ];
  const canPreview = Boolean(parsed && accountId && mappingComplete(mapping));
  // Only the envelopes of the household whose account this is: filing a row
  // against another household's envelope moves money that never moved.
  //
  // Plus the household's income categories under "Unbudgeted money" — a salary
  // or an arriving transfer files to Ready to Assign, not to an envelope, and
  // without this group the wizard offered no valid choice for incoming money
  // (and couldn't even display the category the naming pass proposes for it).
  // Same composition as the register's editor row.
  const importAccount = app.budget.accounts.find((a) => a.id === accountId);
  const envelopeData = categoryOptions(app.budget, importAccount ? { household: importAccount.household } : undefined);
  const unbudgeted = incomeCategoryOptions(app.budget)
    .filter((c) => c.household === importAccount?.household)
    .map(({ value, label }) => ({ value, label }));
  const categoryData = unbudgeted.length ? [{ group: "Unbudgeted money", items: unbudgeted }, ...envelopeData] : envelopeData;
  const unclaimedTxs = result
    ? result.unclaimedBudget.map((id) => app.budget.transactions.find((t) => t.id === id)).filter((t): t is Transaction => !!t)
    : [];

  return (
    <Stack>
      <Group>
        <Button leftSection={<IconFileImport size={16} />} onClick={pick} disabled={!isTauri()}>
          Choose CSV file…
        </Button>
        {parsed && <Text size="sm" c="dimmed">{parsed.fileName} · {parsed.rowCount} rows</Text>}
      </Group>

      {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}

      {parsed && (
        <>
          {recalled && result && (
            <Text size="xs" c="teal">
              ✓ Recognized this file and reconciled it automatically. Change the account or mapping below if that's wrong.
            </Text>
          )}
          <Group grow>
            <Select
              label="Reconcile against account"
              data={app.budget.accounts.map((a) => ({ value: a.id, label: a.name }))}
              value={accountId}
              onChange={(v) => { setAccountId(v); setResult(null); setRecalled(false); }}
              searchable
            />
            <Select label="Column mapping" data={formatOptions} value={formatChoice} onChange={chooseFormat} allowDeselect={false} />
          </Group>
          <Group gap="xs">
            <Anchor size="xs" component="button" type="button" onClick={() => setMappingOpen((o) => !o)}>
              {mappingOpen ? "Hide column mapping" : "Adjust column mapping…"}
            </Anchor>
            {formatChoice !== NEW_MAPPING && (
              <Text size="xs" c="dimmed">— changes are saved back to this mapping</Text>
            )}
          </Group>
          <Collapse in={mappingOpen}>
            <Stack gap="sm">
              <FormatMappingForm headers={parsed.headers} value={mapping} onChange={(m) => { setMapping(m); setResult(null); setRecalled(false); }} />
              {trueDate && (
                <Text size="xs" c="teal">
                  ✓ True transaction dates detected inside the description. Keep the date column on the bank's
                  booking-date column — the real transaction date is extracted automatically and used for matching.
                </Text>
              )}
            </Stack>
          </Collapse>
          {!result && (
            <Group>
              <Button variant="light" onClick={() => parsed && accountId && void reconcile(parsed, currentFormat(), accountId)} disabled={!canPreview}>
                Reconcile
              </Button>
            </Group>
          )}
        </>
      )}

      {result && (
        <ReconcileView
          result={result}
          currency={app.currency}
          accountName={accountId ? app.accountName(accountId as Ulid) : ""}
          categoryData={categoryData}
          unclaimed={unclaimedTxs}
          selected={selected}
          setSelected={setSelected}
          edits={edits}
          previouslySkipped={previouslySkipped}
          setEdits={setEdits}
          isCard={isCard}
          coverage={coverage}
          settledCount={settledCount}
          coverageOn={coverageOn}
          setCoverageOn={setCoverageOn}
          onCommit={() => void commit()}
        />
      )}
    </Stack>
  );
}

function ReconcileView({ result, currency, accountName, categoryData, unclaimed, selected, setSelected, edits, setEdits, previouslySkipped, isCard, coverage, settledCount, coverageOn, setCoverageOn, onCommit }: {
  result: StatementReconcile;
  currency: CurrencyConfig;
  accountName: string;
  categoryData: Array<{ group: string; items: Array<{ value: string; label: string }> }>;
  unclaimed: Transaction[];
  selected: Set<number>;
  setSelected: (s: Set<number>) => void;
  edits: Map<number, RowEdit>;
  /** Rows you left unticked last time — unticked again, and said so. */
  previouslySkipped: Set<number>;
  setEdits: (e: Map<number, RowEdit>) => void;
  isCard: boolean;
  coverage: InvoiceCoverage | null;
  settledCount: number;
  coverageOn: boolean;
  setCoverageOn: (v: boolean) => void;
  onCommit: () => void;
}) {
  const matchedRows = result.matches.reduce((a, m) => a + m.rows.length, 0);
  const combos = result.matches.filter((m) => m.kind === "combo");
  const wides = result.matches.filter((m) => m.kind === "wide");
  const ties = result.matches.filter((m) => m.interchangeable);
  const toggle = (row: number) => {
    const next = new Set(selected);
    next.has(row) ? next.delete(row) : next.add(row);
    setSelected(next);
  };
  const edit = (row: number, patch: RowEdit) => {
    const next = new Map(edits);
    next.set(row, { ...next.get(row), ...patch });
    setEdits(next);
  };
  const netAgrees = result.check.statementNet === result.check.budgetNet;
  // A statement that barely matches an account with history usually means the
  // wrong account is selected — warn before the user imports the whole file.
  const explained = matchedRows + result.churn.length * 2;
  const lowMatch = result.parsedRows >= 8 && explained / result.parsedRows < 0.25;

  const amountCell = (amount: number) => (
    <Text size="sm" c={amount < 0 ? "red" : "teal"}>{money(amount, currency)}</Text>
  );

  return (
    <Paper withBorder p="md" radius="md">
      <Title order={5} mb="xs">Reconciliation</Title>
      <Group gap="xs" mb="xs">
        <Badge color="teal" variant="light">{matchedRows} matched</Badge>
        {combos.length > 0 && <Badge color="cyan" variant="light">{combos.length} same-visit combos</Badge>}
        {wides.length > 0 && <Badge color="indigo" variant="light">{wides.length} wide-window</Badge>}
        {ties.length > 0 && <Badge color="gray" variant="light">{ties.length} interchangeable</Badge>}
        {result.churn.length > 0 && <Badge color="grape" variant="light">{result.churn.length} charge+refund skipped</Badge>}
        <Badge color={result.toAdd.length > 0 ? "orange" : "gray"} variant="light">{result.toAdd.length} missing from budget</Badge>
        {unclaimed.length > 0 && <Badge color="gray" variant="outline">{unclaimed.length} unconfirmed in budget</Badge>}
        {result.errors.length > 0 && <Badge color="red" variant="light">{result.errors.length} parse errors</Badge>}
      </Group>

      <Text size="xs" c={netAgrees ? "teal" : "dimmed"}>
        Net change {result.check.from} – {result.check.to}: statement {money(result.check.statementNet, currency)} vs budget {money(result.check.budgetNet, currency)}
        {netAgrees ? " ✓" : " (will converge as missing rows are added)"}
      </Text>

      {lowMatch && (
        <Alert color="orange" mt="xs" icon={<IconAlertTriangle size={16} />}>
          Only {explained} of {result.parsedRows} statement rows matched anything in “{accountName}”. If this period
          should already be in the budget, double-check the account before adding {result.toAdd.length} rows.
        </Alert>
      )}

      {isCard && (
        coverage && settledCount > 0 ? (
          <Checkbox
            mt="xs"
            checked={coverageOn}
            onChange={(e) => setCoverageOn(e.currentTarget.checked)}
            label={`Invoice payment matched (${coverage.chainLength} consecutive payments agree): ${money(coverage.paymentAmount, currency)} on ${coverage.paymentDate} settles the period ${coverage.windowFrom} – ${coverage.windowTo} and everything before it — mark ${settledCount} transaction${settledCount === 1 ? "" : "s"} reconciled`}
          />
        ) : coverage ? (
          <Text size="xs" c="dimmed" mt="xs">
            Invoice payment matched ({money(coverage.paymentAmount, currency)} on {coverage.paymentDate}) — everything it settles is already reconciled.
          </Text>
        ) : (
          <Text size="xs" c="dimmed" mt="xs">
            No card payment matches a billing window yet, so paid status is left unchanged — a swipe on the statement isn't paid until its invoice is.
          </Text>
        )
      )}

      {result.toAdd.length > 0 && (
        <>
          <Divider my="sm" label="Missing from the budget — tick what to add, tidy as you go" />
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={36} />
                <Table.Th w={100}>Date</Table.Th>
                <Table.Th>Payee</Table.Th>
                <Table.Th w={210}>Category</Table.Th>
                <Table.Th ta="right" w={110}>Amount</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {result.toAdd.map((r) => (
                <Table.Tr key={r.sourceRow}>
                  <Table.Td><Checkbox checked={selected.has(r.sourceRow)} onChange={() => toggle(r.sourceRow)} aria-label="Include row" /></Table.Td>
                  <Table.Td>
                    <Group gap={6} wrap="nowrap">
                      <Text size="sm">{r.date}</Text>
                      {previouslySkipped.has(r.sourceRow) && (
                        <Tooltip label="You left this out of an earlier import, so it starts unticked. Tick it to bring it in." withArrow>
                          <Badge size="xs" color="gray" variant="light">skipped before</Badge>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      value={edits.get(r.sourceRow)?.payee ?? r.payee}
                      onChange={(e) => edit(r.sourceRow, { payee: e.currentTarget.value })}
                      disabled={!selected.has(r.sourceRow)}
                    />
                  </Table.Td>
                  <Table.Td>
                    <Select
                      size="xs"
                      placeholder="Category"
                      data={categoryData}
                      value={edits.get(r.sourceRow)?.categoryId ?? null}
                      onChange={(v) => edit(r.sourceRow, { categoryId: v })}
                      searchable
                      clearable
                      disabled={!selected.has(r.sourceRow)}
                    />
                  </Table.Td>
                  <Table.Td ta="right">{amountCell(r.amount)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}

      {(result.churn.length > 0 || unclaimed.length > 0 || result.errors.length > 0) && (
        <Accordion variant="separated" multiple mt="sm">
          {result.churn.length > 0 && (
            <Accordion.Item value="churn">
              <Accordion.Control>
                <Text size="sm">Skipped charge + refund pairs ({result.churn.length}) — they cancel out, so nothing is added</Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Table verticalSpacing={4}>
                  <Table.Tbody>
                    {result.churn.map((p) => (
                      <Table.Tr key={p.charge.sourceRow}>
                        <Table.Td><Text size="sm" lineClamp={1}>{p.charge.payee}</Text></Table.Td>
                        <Table.Td w={110}><Text size="sm">{p.charge.date}</Text></Table.Td>
                        <Table.Td ta="right" w={110}>{amountCell(p.charge.amount)}</Table.Td>
                        <Table.Td w={110}><Text size="sm">{p.refund.date}</Text></Table.Td>
                        <Table.Td ta="right" w={110}>{amountCell(p.refund.amount)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
              </Accordion.Panel>
            </Accordion.Item>
          )}
          {unclaimed.length > 0 && (
            <Accordion.Item value="unclaimed">
              <Accordion.Control>
                <Text size="sm">Budget rows the statement didn't confirm ({unclaimed.length}) — check these if the net disagrees</Text>
              </Accordion.Control>
              <Accordion.Panel>
                <Table verticalSpacing={4}>
                  <Table.Tbody>
                    {unclaimed.map((t) => (
                      <Table.Tr key={t.id}>
                        <Table.Td w={110}><Text size="sm">{t.date}</Text></Table.Td>
                        <Table.Td><Text size="sm" lineClamp={1}>{t.payee}</Text></Table.Td>
                        <Table.Td ta="right" w={110}>{amountCell(t.amount)}</Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                <Text size="xs" c="dimmed" mt={4}>
                  Rows just outside the statement's window are normal here; a row well inside it may be a typo or something the bank never charged.
                </Text>
              </Accordion.Panel>
            </Accordion.Item>
          )}
          {result.errors.length > 0 && (
            <Accordion.Item value="errors">
              <Accordion.Control><Text size="sm">Rows that couldn't be read ({result.errors.length})</Text></Accordion.Control>
              <Accordion.Panel>
                <Stack gap={2}>
                  {result.errors.map((e, i) => <Text key={i} size="xs" c="dimmed">{e}</Text>)}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          )}
        </Accordion>
      )}

      <Divider my="md" />
      <Group justify="space-between">
        <Text size="xs" c="dimmed">
          {isCard
            ? "Matches verify the bank's record; paid status comes from matched invoice payments. The mapping is remembered for next time."
            : "Matched rows are marked reconciled ✓ and the mapping is remembered for next time."}
        </Text>
        <Button color="teal" onClick={onCommit}>
          {selected.size > 0
            ? `Add ${selected.size} & finish reconcile`
            : result.matches.length > 0
              ? "Finish reconcile"
              : "Done"}
        </Button>
      </Group>
    </Paper>
  );
}
