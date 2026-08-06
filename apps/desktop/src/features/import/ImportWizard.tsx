import { useEffect, useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Checkbox,
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
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertTriangle, IconFileImport, IconTrash } from "@tabler/icons-react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  mergeImport,
  newId,
  parseCsv,
  stageImport,
  stageStatement,
  type CurrencyConfig,
  type ImportConfig,
  type SavedFormat,
  type StagingResult,
  type Transaction,
  type Ulid,
} from "@cash-money/core";
import { useApp } from "../../state";
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

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "src";
const today = () => new Date().toISOString().slice(0, 10);
function parseAsOf(name: string): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name);
  return m ? m[1]! : today();
}

/** One wizard for both import kinds: full budget exports and bank statements. */
export function ImportWizard({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<"export" | "statement">("export");
  const [resetSeq, setResetSeq] = useState(0);
  const close = () => {
    setResetSeq((n) => n + 1); // remount panes so nothing leaks between sessions
    onClose();
  };

  return (
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
        {mode === "export" ? <ExportPane key={`e${resetSeq}`} onDone={close} /> : <StatementPane key={`s${resetSeq}`} onDone={close} />}
      </Stack>
    </Modal>
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

interface StatementPreview {
  merged: Transaction[];
  added: Transaction[];
  alreadyPresent: number;
  errors: string[];
}

function StatementPane({ onDone }: { onDone: () => void }) {
  const app = useApp();
  const [parsed, setParsed] = useState<ParsedCsvFile | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedFormat[]>([]);
  const [formatChoice, setFormatChoice] = useState<string>(NEW_MAPPING);
  const [mapping, setMapping] = useState<MappingState>(EMPTY_MAPPING);
  const [saveMapping, setSaveMapping] = useState(false);
  const [mappingName, setMappingName] = useState("");
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    app.loadFormats().then(setSaved).catch(() => setSaved([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async () => {
    setError(null);
    try {
      const selected = await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!selected || Array.isArray(selected)) return;
      const text = await readTextAbs(selected);
      const { headers, rows } = parseCsv(text);
      setParsed({ fileName: selected.split(/[/\\]/).pop() ?? selected, text, headers, rowCount: rows.length });
      setPreview(null);
      if (formatChoice === NEW_MAPPING) setMapping(stateFromGuess(headers));
      if (!accountId) setAccountId(app.budget.accounts[0]?.id ?? null);
    } catch (e) {
      setError(`Could not read the file: ${String(e)}`);
    }
  };

  const chooseFormat = (id: string | null) => {
    const choice = id ?? NEW_MAPPING;
    setFormatChoice(choice);
    setPreview(null);
    if (choice === NEW_MAPPING) {
      if (parsed) setMapping(stateFromGuess(parsed.headers));
      return;
    }
    const f = saved.find((s) => s.format.id === choice)?.format;
    if (f) setMapping(stateFromFormat(f));
  };

  const currentFormat = () =>
    buildFormat(mapping, formatChoice === NEW_MAPPING ? "adhoc:bank-statement" : formatChoice, mappingName || "Bank statement");

  const runPreview = async () => {
    if (!parsed || !accountId) return;
    setError(null);
    try {
      const format = currentFormat();
      const sourceKey = await app.statementSourceKey(accountId as Ulid, format.id);
      const { merged, report } = stageStatement(app.budget, parsed.text, format, {
        sourceKey,
        accountId: accountId as Ulid,
        currency: app.currency,
      });
      setPreview({
        merged,
        added: merged.slice(app.budget.transactions.length),
        alreadyPresent: report.matched + report.legacyMatched,
        errors: report.errors,
      });
    } catch (e) {
      setError(String(e));
      setPreview(null);
    }
  };

  const commit = async () => {
    if (!accountId || !preview) return;
    app.setTransactions(preview.merged);
    if (saveMapping && formatChoice === NEW_MAPPING && mappingName.trim()) {
      const format = buildFormat(mapping, newId(), mappingName.trim());
      await app.saveFormats([...saved, { format, lastUsed: today() }]).catch(() => undefined);
    }
    app.setView({ kind: "account", accountId: accountId as Ulid });
    onDone();
  };

  const formatOptions = [
    { value: NEW_MAPPING, label: "New mapping…" },
    ...saved.map((s) => ({ value: s.format.id, label: s.format.name })),
  ];
  const canPreview = Boolean(parsed && accountId && mappingComplete(mapping));

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
          <Group grow>
            <Select label="Import into account" data={app.budget.accounts.map((a) => ({ value: a.id, label: a.name }))} value={accountId} onChange={setAccountId} searchable />
            <Select label="Column mapping" data={formatOptions} value={formatChoice} onChange={chooseFormat} allowDeselect={false} />
          </Group>
          <FormatMappingForm headers={parsed.headers} value={mapping} onChange={(m) => { setMapping(m); setPreview(null); }} />
          {formatChoice === NEW_MAPPING && (
            <Group align="flex-end">
              <Checkbox label="Save this mapping for next time" checked={saveMapping} onChange={(e) => setSaveMapping(e.currentTarget.checked)} />
              {saveMapping && (
                <TextInput size="xs" placeholder="Mapping name (e.g. My bank)" value={mappingName} onChange={(e) => setMappingName(e.currentTarget.value)} />
              )}
            </Group>
          )}
          <Group>
            <Button variant="light" onClick={() => void runPreview()} disabled={!canPreview}>Preview</Button>
          </Group>
        </>
      )}

      {preview && (
        <Paper withBorder p="md" radius="md">
          <Group gap="xs" mb="xs">
            <Badge color="teal" variant="light">{preview.added.length} to import</Badge>
            {preview.alreadyPresent > 0 && <Badge color="gray" variant="light">{preview.alreadyPresent} already present</Badge>}
            {preview.errors.length > 0 && <Badge color="red" variant="light">{preview.errors.length} errors</Badge>}
          </Group>
          {preview.errors.length > 0 && (
            <Alert color="yellow" mb="xs" icon={<IconAlertTriangle size={16} />}>
              {preview.errors.slice(0, 4).join("; ")}{preview.errors.length > 4 ? " …" : ""}
            </Alert>
          )}
          <Table verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr><Table.Th>Date</Table.Th><Table.Th>Payee</Table.Th><Table.Th ta="right">Amount</Table.Th></Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {preview.added.slice(0, 8).map((t) => (
                <Table.Tr key={t.id}>
                  <Table.Td>{t.date}</Table.Td>
                  <Table.Td><Text size="sm" lineClamp={1}>{t.payee}</Text></Table.Td>
                  <Table.Td ta="right"><Text size="sm" c={t.amount < 0 ? "red" : "teal"}>{money(t.amount, app.currency)}</Text></Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          {preview.added.length > 8 && <Text size="xs" c="dimmed" mt={4}>…and {preview.added.length - 8} more</Text>}
          <Divider my="md" />
          <Group justify="flex-end">
            <Button color="teal" onClick={() => void commit()} disabled={preview.added.length === 0}>
              Import {preview.added.length} transaction{preview.added.length === 1 ? "" : "s"}
            </Button>
          </Group>
        </Paper>
      )}
    </Stack>
  );
}
