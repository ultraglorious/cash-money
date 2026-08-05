import { useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Table,
  Text,
} from "@mantine/core";
import { IconAlertTriangle, IconFileImport } from "@tabler/icons-react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  parseCsv,
  stageStatement,
  type ImportDateFormat,
  type RegisterFormat,
  type Transaction,
  type Ulid,
} from "@cash-money/core";
import { useApp } from "../../state";
import { money } from "../../format";
import { isTauri, readTextAbs } from "../../platform/tauriFs";

interface Parsed {
  fileName: string;
  text: string;
  headers: string[];
  rowCount: number;
}

interface Preview {
  merged: Transaction[];
  added: Transaction[];
  alreadyPresent: number;
  errors: string[];
}

const NONE = "— none —";
const find = (headers: string[], re: RegExp) => headers.find((h) => re.test(h)) ?? "";

export function BankImportWizard({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const app = useApp();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [dateColumn, setDateColumn] = useState("");
  const [dateFormat, setDateFormat] = useState<ImportDateFormat>("iso");
  const [payeeColumn, setPayeeColumn] = useState("");
  const [memoColumn, setMemoColumn] = useState<string>(NONE);
  const [amountMode, setAmountMode] = useState<"single" | "split">("single");
  const [amountColumn, setAmountColumn] = useState("");
  const [outflowPositive, setOutflowPositive] = useState(false);
  const [inflowColumn, setInflowColumn] = useState("");
  const [outflowColumn, setOutflowColumn] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setParsed(null);
    setPreview(null);
    setError(null);
    onClose();
  };

  const pick = async () => {
    setError(null);
    try {
      const selected = await open({ multiple: false, filters: [{ name: "CSV", extensions: ["csv"] }] });
      if (!selected || Array.isArray(selected)) return;
      const text = await readTextAbs(selected);
      const { headers, rows } = parseCsv(text);
      setParsed({ fileName: selected.split(/[/\\]/).pop() ?? selected, text, headers, rowCount: rows.length });
      setPreview(null);
      // Best-effort auto-guess of the mapping.
      setDateColumn(find(headers, /date/i));
      setPayeeColumn(find(headers, /payee|description|name|details|narrative|memo/i));
      const memo = find(headers, /reference|note|memo/i);
      setMemoColumn(memo || NONE);
      const debit = find(headers, /debit|outflow|withdraw|paid.?out/i);
      const credit = find(headers, /credit|inflow|deposit|paid.?in/i);
      if (debit && credit) {
        setAmountMode("split");
        setOutflowColumn(debit);
        setInflowColumn(credit);
      } else {
        setAmountMode("single");
        setAmountColumn(find(headers, /amount|value/i));
      }
      if (!accountId) setAccountId(app.budget.accounts[0]?.id ?? null);
    } catch (e) {
      setError(`Could not read the file: ${String(e)}`);
    }
  };

  const buildFormat = (): RegisterFormat => ({
    id: "adhoc:bank-statement",
    name: "Bank statement",
    date: { column: dateColumn, format: dateFormat },
    payeeColumn,
    ...(memoColumn !== NONE ? { memoColumn } : {}),
    amount:
      amountMode === "single"
        ? { mode: "signed", column: amountColumn, outflowPositive }
        : { mode: "inOut", inflowColumn, outflowColumn },
  });

  const runPreview = () => {
    if (!parsed || !accountId) return;
    setError(null);
    try {
      const { merged, report } = stageStatement(app.budget, parsed.text, buildFormat(), {
        // Stable per account, so re-importing the same or an overlapping
        // statement into this account is a no-op for rows already present.
        sourceKey: `stmt:${accountId}`,
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

  const commit = () => {
    if (!accountId || !preview) return;
    app.setTransactions(preview.merged);
    app.setView({ kind: "account", accountId: accountId as Ulid });
    close();
  };

  const colOptions = parsed?.headers ?? [];
  const canPreview = Boolean(parsed && accountId && dateColumn && payeeColumn && (amountMode === "single" ? amountColumn : inflowColumn && outflowColumn));

  return (
    <Modal opened={opened} onClose={close} title="Import bank statement (CSV)" size="xl" centered>
      <Stack>
        {!isTauri() && (
          <Alert color="yellow" icon={<IconAlertTriangle size={16} />}>
            Reading files from disk is only available in the desktop app (not this browser preview).
          </Alert>
        )}
        <Group>
          <Button leftSection={<IconFileImport size={16} />} onClick={pick} disabled={!isTauri()}>
            Choose CSV file…
          </Button>
          {parsed && <Text size="sm" c="dimmed">{parsed.fileName} · {parsed.rowCount} rows</Text>}
        </Group>

        {error && <Alert color="red" icon={<IconAlertTriangle size={16} />}>{error}</Alert>}

        {parsed && (
          <>
            <Select label="Import into account" data={app.budget.accounts.map((a) => ({ value: a.id, label: a.name }))} value={accountId} onChange={setAccountId} searchable />
            <Group grow align="flex-end">
              <Select label="Date column" data={colOptions} value={dateColumn} onChange={(v) => setDateColumn(v ?? "")} />
              <Select
                label="Date format"
                data={[
                  { value: "iso", label: "YYYY-MM-DD" },
                  { value: "dmy", label: "DD/MM/YYYY" },
                  { value: "mdy", label: "MM/DD/YYYY" },
                ]}
                value={dateFormat}
                onChange={(v) => v && setDateFormat(v as ImportDateFormat)}
                allowDeselect={false}
              />
            </Group>
            <Group grow>
              <Select label="Payee / description column" data={colOptions} value={payeeColumn} onChange={(v) => setPayeeColumn(v ?? "")} />
              <Select label="Memo column (optional)" data={[NONE, ...colOptions]} value={memoColumn} onChange={(v) => setMemoColumn(v ?? NONE)} />
            </Group>

            <SegmentedControl
              data={[
                { label: "Single amount column", value: "single" },
                { label: "Separate in / out columns", value: "split" },
              ]}
              value={amountMode}
              onChange={(v) => setAmountMode(v as "single" | "split")}
            />
            {amountMode === "single" ? (
              <Group grow align="flex-end">
                <Select label="Amount column" data={colOptions} value={amountColumn} onChange={(v) => setAmountColumn(v ?? "")} />
                <Switch label="Outflows are stored as positive numbers" checked={outflowPositive} onChange={(e) => setOutflowPositive(e.currentTarget.checked)} />
              </Group>
            ) : (
              <Group grow>
                <Select label="Money in (credit) column" data={colOptions} value={inflowColumn} onChange={(v) => setInflowColumn(v ?? "")} />
                <Select label="Money out (debit) column" data={colOptions} value={outflowColumn} onChange={(v) => setOutflowColumn(v ?? "")} />
              </Group>
            )}

            <Group>
              <Button variant="light" onClick={runPreview} disabled={!canPreview}>Preview</Button>
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
              <Button color="teal" onClick={commit} disabled={preview.added.length === 0}>
                Import {preview.added.length} transaction{preview.added.length === 1 ? "" : "s"}
              </Button>
            </Group>
          </Paper>
        )}
      </Stack>
    </Modal>
  );
}
