import { useState } from "react";
import { ActionIcon, Autocomplete, Badge, Box, Group, NumberInput, Select, TextInput } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useDisclosure } from "@mantine/hooks";
import { IconCheck, IconMinus, IconPlus, IconX } from "@tabler/icons-react";
import type { Cents, SplitLine, Transaction, Ulid } from "@cash-money/core";
import { SplitEditorModal } from "./SplitEditorModal";
import { registerTemplate } from "./layout";

export interface EditorSubmit {
  accountId: Ulid;
  date: string;
  payee: string;
  categoryId?: Ulid;
  memo: string;
  amount: Cents;
  cleared: "cleared" | "uncleared" | "reconciled";
  splits?: SplitLine[];
}

interface GroupedOption {
  group: string;
  items: { value: string; label: string }[];
}

const SPLIT_VALUE = "__split__";

function toIso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function fromIso(iso: string): Date {
  return new Date(`${iso}T00:00:00`);
}

export function EditorRow({
  single,
  initial,
  payees,
  lastCategoryOf,
  categoryData,
  accountData,
  onSubmit,
  onCancel,
}: {
  single: Ulid | null;
  initial?: Transaction;
  payees: string[];
  lastCategoryOf: (payee: string) => Ulid | undefined;
  categoryData: GroupedOption[];
  accountData: { value: string; label: string }[];
  onSubmit: (data: EditorSubmit) => void;
  onCancel: () => void;
}) {
  const [accountId, setAccountId] = useState<string | null>(single ?? initial?.accountId ?? null);
  const [date, setDate] = useState<Date | null>(initial ? fromIso(initial.date) : new Date());
  const [payee, setPayee] = useState(initial?.payee ?? "");
  const [categoryId, setCategoryId] = useState<string | null>(initial?.categoryId ?? null);
  const [categoryTouched, setCategoryTouched] = useState(!!initial?.categoryId);
  const [memo, setMemo] = useState(initial?.memo ?? "");
  const [direction, setDirection] = useState<"out" | "in">(initial && initial.amount > 0 ? "in" : "out");
  const [magnitude, setMagnitude] = useState<number | string>(initial ? Math.abs(initial.amount) / 100 : "");
  const [splits, setSplits] = useState<SplitLine[] | null>(null);
  const [splitOpen, splitCtrl] = useDisclosure(false);

  const signedMagnitude = (): Cents => {
    const cents = Math.round(Number(magnitude || 0) * 100);
    return (direction === "out" ? -cents : cents) as Cents;
  };
  const splitTotal = splits ? (splits.reduce((s, l) => s + l.amount, 0) as Cents) : signedMagnitude();
  const valid = Boolean(accountId && date && (splits ? splits.length > 0 : magnitude !== "" && Number(magnitude) > 0));

  const commit = () => {
    if (!valid || !accountId || !date) return;
    const base = { accountId: accountId as Ulid, date: toIso(date), payee: payee.trim(), memo: memo.trim(), cleared: initial?.cleared ?? "cleared" };
    if (splits) onSubmit({ ...base, amount: splitTotal, splits });
    else onSubmit({ ...base, amount: signedMagnitude(), ...(categoryId ? { categoryId: categoryId as Ulid } : {}) });
  };

  const onPayeePick = (value: string) => {
    setPayee(value);
    if (!categoryTouched && !splits) {
      const last = lastCategoryOf(value);
      if (last) setCategoryId(last);
    }
  };

  return (
    <Box style={{ display: "grid", gridTemplateColumns: registerTemplate(!!single), alignItems: "center", columnGap: 8, padding: "6px 10px", background: "var(--mantine-color-indigo-light)" }}>
      <DatePickerInput size="xs" value={date} onChange={setDate} valueFormat="DD MMM" popoverProps={{ withinPortal: true }} />
      {!single && <Select size="xs" placeholder="Account" data={accountData} value={accountId} onChange={setAccountId} searchable comboboxProps={{ withinPortal: true }} />}
      <Autocomplete size="xs" placeholder="Payee" data={payees} value={payee} onChange={onPayeePick} onOptionSubmit={onPayeePick} comboboxProps={{ withinPortal: true }} />
      {splits ? (
        <Group gap={4} wrap="nowrap">
          <Badge color="grape" variant="light" style={{ cursor: "pointer" }} onClick={splitCtrl.open}>Split ({splits.length})</Badge>
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setSplits(null)} aria-label="Clear split"><IconX size={13} /></ActionIcon>
        </Group>
      ) : (
        <Select
          size="xs"
          placeholder="Category"
          data={[{ value: SPLIT_VALUE, label: "⑂ Split between categories…" }, ...categoryData]}
          value={categoryId}
          onChange={(v) => {
            if (v === SPLIT_VALUE) { splitCtrl.open(); return; }
            setCategoryId(v);
            setCategoryTouched(true);
          }}
          searchable
          clearable
          comboboxProps={{ withinPortal: true }}
        />
      )}
      <TextInput size="xs" placeholder="Memo" value={memo} onChange={(e) => setMemo(e.currentTarget.value)} />
      <NumberInput
        size="xs"
        placeholder="0.00"
        prefix="€"
        decimalScale={2}
        hideControls
        min={0}
        disabled={!!splits}
        value={splits ? Math.abs(splitTotal) / 100 : magnitude}
        onChange={setMagnitude}
        onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") onCancel(); }}
        styles={{ input: { textAlign: "right" } }}
        leftSection={
          <ActionIcon size="sm" variant="subtle" color={direction === "out" ? "red" : "teal"} onClick={() => setDirection((d) => (d === "out" ? "in" : "out"))} disabled={!!splits} aria-label="Toggle inflow/outflow">
            {direction === "out" ? <IconMinus size={14} /> : <IconPlus size={14} />}
          </ActionIcon>
        }
      />
      <Box />
      <Group gap={4} wrap="nowrap">
        <ActionIcon size="sm" color="teal" variant="light" onClick={commit} disabled={!valid} aria-label="Save"><IconCheck size={15} /></ActionIcon>
        <ActionIcon size="sm" color="gray" variant="subtle" onClick={onCancel} aria-label="Cancel"><IconX size={15} /></ActionIcon>
      </Group>

      <SplitEditorModal
        opened={splitOpen}
        onClose={splitCtrl.close}
        amount={signedMagnitude()}
        initialSplits={splits ?? undefined}
        onSave={(s) => { setSplits(s); setCategoryId(null); splitCtrl.close(); }}
        onUnsplit={splits ? () => { setSplits(null); splitCtrl.close(); } : undefined}
      />
    </Box>
  );
}
