import { Group, SegmentedControl, Select, Stack, Switch } from "@mantine/core";
import { guessFormat, type ImportDateFormat, type RegisterFormat } from "@cash-money/core";

/**
 * The column-mapping form: how one CSV shape maps onto transactions. Controlled
 * component over a flat MappingState; `buildFormat` turns a complete state into
 * a RegisterFormat, `stateFromFormat`/`stateFromGuess` prefill it.
 */

export const NONE = "— none —";

export interface MappingState {
  dateColumn: string;
  dateFormat: ImportDateFormat;
  payeeColumn: string;
  memoColumn: string; // NONE when unmapped
  amountMode: "single" | "split";
  amountColumn: string;
  outflowPositive: boolean;
  inflowColumn: string;
  outflowColumn: string;
}

export const EMPTY_MAPPING: MappingState = {
  dateColumn: "",
  dateFormat: "iso",
  payeeColumn: "",
  memoColumn: NONE,
  amountMode: "single",
  amountColumn: "",
  outflowPositive: false,
  inflowColumn: "",
  outflowColumn: "",
};

export function stateFromGuess(headers: string[]): MappingState {
  const g = guessFormat(headers);
  return {
    ...EMPTY_MAPPING,
    dateColumn: g.dateColumn ?? "",
    payeeColumn: g.payeeColumn ?? "",
    memoColumn: g.memoColumn ?? NONE,
    ...(g.amount?.mode === "inOut"
      ? { amountMode: "split" as const, inflowColumn: g.amount.inflowColumn, outflowColumn: g.amount.outflowColumn }
      : { amountMode: "single" as const, amountColumn: g.amount?.mode === "signed" ? g.amount.column : "" }),
  };
}

export function stateFromFormat(f: RegisterFormat): MappingState {
  return {
    dateColumn: f.date.column,
    dateFormat: f.date.format,
    payeeColumn: f.payeeColumn,
    memoColumn: f.memoColumn ?? NONE,
    ...(f.amount.mode === "inOut"
      ? {
          amountMode: "split" as const,
          inflowColumn: f.amount.inflowColumn,
          outflowColumn: f.amount.outflowColumn,
          amountColumn: "",
          outflowPositive: false,
        }
      : {
          amountMode: "single" as const,
          amountColumn: f.amount.column,
          outflowPositive: f.amount.outflowPositive ?? false,
          inflowColumn: "",
          outflowColumn: "",
        }),
  };
}

export function mappingComplete(m: MappingState): boolean {
  if (!m.dateColumn || !m.payeeColumn) return false;
  return m.amountMode === "single" ? !!m.amountColumn : !!m.inflowColumn && !!m.outflowColumn;
}

export function buildFormat(m: MappingState, id: string, name: string): RegisterFormat {
  return {
    id,
    name,
    date: { column: m.dateColumn, format: m.dateFormat },
    payeeColumn: m.payeeColumn,
    ...(m.memoColumn !== NONE ? { memoColumn: m.memoColumn } : {}),
    amount:
      m.amountMode === "single"
        ? { mode: "signed", column: m.amountColumn, outflowPositive: m.outflowPositive }
        : { mode: "inOut", inflowColumn: m.inflowColumn, outflowColumn: m.outflowColumn },
  };
}

export function FormatMappingForm({
  headers,
  value,
  onChange,
}: {
  headers: string[];
  value: MappingState;
  onChange: (next: MappingState) => void;
}) {
  const set = (patch: Partial<MappingState>) => onChange({ ...value, ...patch });
  return (
    <Stack gap="sm">
      <Group grow align="flex-end">
        <Select label="Date column" data={headers} value={value.dateColumn} onChange={(v) => set({ dateColumn: v ?? "" })} />
        <Select
          label="Date format"
          data={[
            { value: "iso", label: "YYYY-MM-DD" },
            { value: "dmy", label: "DD/MM/YYYY" },
            { value: "mdy", label: "MM/DD/YYYY" },
          ]}
          value={value.dateFormat}
          onChange={(v) => v && set({ dateFormat: v as ImportDateFormat })}
          allowDeselect={false}
        />
      </Group>
      <Group grow>
        <Select label="Payee / description column" data={headers} value={value.payeeColumn} onChange={(v) => set({ payeeColumn: v ?? "" })} />
        <Select label="Memo column (optional)" data={[NONE, ...headers]} value={value.memoColumn} onChange={(v) => set({ memoColumn: v ?? NONE })} />
      </Group>
      <SegmentedControl
        data={[
          { label: "Single amount column", value: "single" },
          { label: "Separate in / out columns", value: "split" },
        ]}
        value={value.amountMode}
        onChange={(v) => set({ amountMode: v as MappingState["amountMode"] })}
      />
      {value.amountMode === "single" ? (
        <Group grow align="flex-end">
          <Select label="Amount column" data={headers} value={value.amountColumn} onChange={(v) => set({ amountColumn: v ?? "" })} />
          <Switch
            label="Outflows are stored as positive numbers"
            checked={value.outflowPositive}
            onChange={(e) => set({ outflowPositive: e.currentTarget.checked })}
          />
        </Group>
      ) : (
        <Group grow>
          <Select label="Money in (credit) column" data={headers} value={value.inflowColumn} onChange={(v) => set({ inflowColumn: v ?? "" })} />
          <Select label="Money out (debit) column" data={headers} value={value.outflowColumn} onChange={(v) => set({ outflowColumn: v ?? "" })} />
        </Group>
      )}
    </Stack>
  );
}
