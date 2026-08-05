import { useState } from "react";
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertTriangle, IconFileImport, IconTrash } from "@tabler/icons-react";
import { open } from "@tauri-apps/plugin-dialog";
import { stageImport, type ImportConfig, type StagingResult } from "@cash-money/core";
import { useApp } from "../../state";
import { money } from "../../format";
import { isTauri, readZipCsvs } from "../../platform/tauriFs";

interface SourceDraft {
  path: string;
  sourceKey: string;
  household: string;
  register: string;
  plan: string;
  exportDate: string;
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "src";
const today = () => new Date().toISOString().slice(0, 10);
function parseAsOf(name: string): string {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(name);
  return m ? m[1]! : today();
}

export function ImportWizard({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const app = useApp();
  const [sources, setSources] = useState<SourceDraft[]>([]);
  const [result, setResult] = useState<StagingResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setSources([]);
    setResult(null);
    setError(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const pick = async () => {
    setError(null);
    try {
      const selected = await open({ multiple: true, filters: [{ name: "Budget export", extensions: ["zip"] }] });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const drafts: SourceDraft[] = [];
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i]!;
        const members = await readZipCsvs(path);
        const register = members.find((m) => /register\.csv$/i.test(m.name))?.content ?? "";
        const plan = members.find((m) => /plan\.csv$/i.test(m.name))?.content ?? "";
        const base = path.split(/[/\\]/).pop()!.replace(/\.zip$/i, "");
        const household = base.replace(/\s*as of.*$/i, "").trim() || base;
        drafts.push({ path, sourceKey: `${slug(household)}-${sources.length + i}`, household, register, plan, exportDate: parseAsOf(base) });
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
        exportDate: sources[0]?.exportDate ?? today(),
        sources: sources.map((s) => ({ sourceKey: s.sourceKey, label: s.household, household: s.household })),
        trackingAccountHints: ["investment", "etf", "etc", "shares", "deposit"],
      };
      const inputs = sources.map((s) => ({ sourceKey: s.sourceKey, registerCsv: s.register, planCsv: s.plan }));
      setResult(stageImport(inputs, config, config.exportDate));
    } catch (e) {
      setError(String(e));
      setResult(null);
    }
  };

  const commit = () => {
    if (!result) return;
    app.replaceBudget(result.staging);
    app.setView({ kind: "plan" });
    close();
  };

  return (
    <Modal opened={opened} onClose={close} title="Import budget export" size="xl" centered>
      <Stack>
        {!isTauri() && (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
            Importing reads files from disk, so it's only available in the desktop app (not this browser preview).
          </Alert>
        )}

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
              Each file becomes its own <b>household</b> — a separate section in the Plan with its own Ready-to-Assign
              (e.g. “Personal”, “Joint”). Give the two files different household names to keep them apart.
            </Text>
            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>File</Table.Th>
                  <Table.Th>Household (its own section in the Plan)</Table.Th>
                  <Table.Th w={40} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {sources.map((s) => (
                  <Table.Tr key={s.sourceKey}>
                    <Table.Td><Text size="sm" lineClamp={1}>{s.path.split(/[/\\]/).pop()}</Text></Table.Td>
                    <Table.Td><TextInput size="xs" value={s.household} onChange={(e) => updateSource(s.sourceKey, { household: e.currentTarget.value })} /></Table.Td>
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

        {result && <ReportView result={result} currency={app.currency} onCommit={commit} />}
      </Stack>
    </Modal>
  );
}

function ReportView({ result, currency, onCommit }: { result: StagingResult; currency: ImportConfig["currency"]; onCommit: () => void }) {
  const r = result.report;
  const s = result.staging;
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
      <Group justify="space-between">
        <Text size="xs" c="dimmed">Budget "{s.budget.name}" — committing replaces your current budget.</Text>
        <Button color="teal" onClick={onCommit}>Commit import</Button>
      </Group>
    </Paper>
  );
}
