import { useState } from "react";
import { ActionIcon, Autocomplete, Badge, Box, Group, NumberInput, Select, TextInput, Tooltip } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { useDisclosure } from "@mantine/hooks";
import { IconCheck, IconMinus, IconPlus, IconX } from "@tabler/icons-react";
import type { Cents, RecurrenceFreq, SplitLine, Transaction, Ulid } from "@cash-money/core";
import { useApp } from "../../state";
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
  /** Present => the transaction repeats on this cadence. */
  recurrence?: { freq: RecurrenceFreq; anchorDay?: number };
  /** Present => this is a transfer to/from that account (both legs created/mirrored). */
  transferAccountId?: Ulid;
}

const TRANSFER_PREFIX = "Transfer to/from: ";

const REPEAT_NONE = "none";
const REPEAT_OPTIONS = [
  { value: REPEAT_NONE, label: "No repeat" },
  { value: "weekly", label: "Weekly" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "yearly", label: "Yearly" },
];

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
  incomeData,
  accountData,
  onSubmit,
  onCancel,
}: {
  single: Ulid | null;
  initial?: Transaction;
  payees: string[];
  lastCategoryOf: (payee: string) => Ulid | undefined;
  categoryData: GroupedOption[];
  incomeData: { value: string; label: string; household?: string }[];
  accountData: { value: string; label: string; household?: string; onBudget?: boolean }[];
  onSubmit: (data: EditorSubmit) => void;
  onCancel: () => void;
}) {
  const { currency } = useApp();
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
  const [repeat, setRepeat] = useState<string>(initial?.recurrence?.freq ?? REPEAT_NONE);
  const [transferTo, setTransferTo] = useState<string | null>(initial?.transfer?.counterAccountId ?? null);

  // "Transfer to/from: <Account>" options offered in the payee field — picking
  // one turns the row into a transfer (both legs, linked). Excludes this row's
  // own account; a transfer edit stays a transfer (delete to un-transfer).
  const transferByLabel = new Map(
    accountData.filter((a) => a.value !== accountId).map((a) => [`${TRANSFER_PREFIX}${a.label}`, a.value]),
  );
  const nameOfAccount = (id: string | null) => accountData.find((a) => a.value === id)?.label ?? "—";
  // A transfer means whatever boundary it crosses (see ARCHITECTURE.md,
  // "Transfers: three nested boundaries"):
  //  - WITHIN one budget scope (same household, incl. its cards): a pocket
  //    shuffle — no category, invisible to envelopes and analytics.
  //  - LEAVING this budget scope, either between budgets (another household)
  //    or out of budget entirely (a tracking account): the money left this
  //    budget's spendable pool, so the outflow leg spends an envelope like any
  //    regular payee — hence the normal Category field.
  // A tracking account belongs to the household but to no budget, which is why
  // it lands on the leaving side.
  const accOf = (id: string | null) => accountData.find((a) => a.value === id);
  const budgetScopeOf = (id: string | null): string | undefined => {
    const a = accOf(id);
    if (!a) return undefined;
    return a.onBudget === false ? "__no-budget__" : a.household ?? "__no-household__";
  };
  const leavesBudget = !!transferTo && budgetScopeOf(accountId) !== budgetScopeOf(transferTo);
  const leavesBudgetHint =
    accOf(transferTo)?.onBudget === false
      ? `Leaves the budget for ${nameOfAccount(transferTo)} — still yours, but no longer spendable, so it spends an envelope.`
      : `Leaves this budget for ${accOf(transferTo)?.household ?? nameOfAccount(transferTo)} — spends an envelope here, lands as money to assign there.`;

  // Unbudgeted money is a legitimate source: income on the way in, and on the
  // way out a deliberate Ready-to-Assign drain. It has to be *picked* — leaving
  // the category blank must never be the way money silently leaves the pool.
  const household = accOf(accountId)?.household;
  const unbudgeted = incomeData.filter((c) => c.household === household).map(({ value, label }) => ({ value, label }));
  const pickerData: GroupedOption[] = unbudgeted.length
    ? [{ group: "Unbudgeted money", items: unbudgeted }, ...categoryData]
    : categoryData;

  const signedMagnitude = (): Cents => {
    const cents = Math.round(Number(magnitude || 0) * 100);
    return (direction === "out" ? -cents : cents) as Cents;
  };
  const splitTotal = splits ? (splits.reduce((s, l) => s + l.amount, 0) as Cents) : signedMagnitude();
  const valid = Boolean(accountId && date && (splits ? splits.length > 0 : magnitude !== "" && Number(magnitude) > 0));

  const commit = () => {
    if (!valid || !accountId || !date) return;
    const iso = toIso(date);
    const recurrence =
      repeat === REPEAT_NONE || transferTo
        ? undefined
        : { freq: repeat as RecurrenceFreq, anchorDay: Number(iso.slice(8, 10)) };
    const base = { accountId: accountId as Ulid, date: iso, payee: payee.trim(), memo: memo.trim(), cleared: initial?.cleared ?? "cleared", recurrence };
    if (transferTo)
      onSubmit({
        ...base,
        amount: signedMagnitude(),
        transferAccountId: transferTo as Ulid,
        ...(leavesBudget && categoryId ? { categoryId: categoryId as Ulid } : {}),
      });
    else if (splits) onSubmit({ ...base, amount: splitTotal, splits });
    else onSubmit({ ...base, amount: signedMagnitude(), ...(categoryId ? { categoryId: categoryId as Ulid } : {}) });
  };

  const onPayeePick = (value: string) => {
    setPayee(value);
    const target = transferByLabel.get(value);
    if (target) {
      setTransferTo(target);
      setSplits(null);
      setCategoryId(null);
      return;
    }
    // An existing transfer stays a transfer even while the text is mid-edit.
    if (!initial?.transfer) setTransferTo(null);
    if (!categoryTouched && !splits) {
      const last = lastCategoryOf(value);
      if (last) setCategoryId(last);
    }
  };

  return (
    <Box
      style={{ display: "grid", gridTemplateColumns: registerTemplate(!!single), alignItems: "center", columnGap: 8, padding: "6px 10px", background: "var(--mantine-color-indigo-light)" }}
      onKeyDown={(e) => {
        // Enter anywhere in the row confirms; a combobox that consumed Enter to
        // pick an option marks the event defaultPrevented, so it won't double-fire.
        if (e.key === "Enter" && !e.defaultPrevented) commit();
        if (e.key === "Escape" && !e.defaultPrevented) onCancel();
      }}
    >
      <Box />
      <DatePickerInput size="xs" value={date} onChange={setDate} valueFormat="DD MMM" popoverProps={{ withinPortal: true }} />
      {!single && <Select size="xs" placeholder="Account" data={accountData} value={accountId} onChange={setAccountId} searchable comboboxProps={{ withinPortal: true }} />}
      <Autocomplete
        size="xs"
        placeholder="Payee"
        data={[
          { group: "Transfer to/from", items: [...transferByLabel.keys()] },
          { group: "Payees", items: payees },
        ]}
        value={payee}
        onChange={onPayeePick}
        onOptionSubmit={onPayeePick}
        comboboxProps={{ withinPortal: true }}
      />
      {transferTo ? (
        <Group gap={4} wrap="nowrap">
          {leavesBudget ? (
            <Tooltip label={leavesBudgetHint} openDelay={400} withinPortal multiline w={280}>
              <Select
                size="xs"
                placeholder="Category"
                data={pickerData}
                value={categoryId}
                onChange={(v) => setCategoryId(v)}
                searchable
                clearable
                comboboxProps={{ withinPortal: true }}
                style={{ flex: 1 }}
              />
            </Tooltip>
          ) : (
            <Tooltip label="Within this budget — money changes pocket, no envelope is touched." openDelay={400} withinPortal multiline w={280}>
              <Badge color="blue" variant="light">Transfer: {nameOfAccount(transferTo)}</Badge>
            </Tooltip>
          )}
          {!initial?.transfer && (
            <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => { setTransferTo(null); setPayee(""); }} aria-label="Clear transfer">
              <IconX size={13} />
            </ActionIcon>
          )}
        </Group>
      ) : splits ? (
        <Group gap={4} wrap="nowrap">
          <Badge color="grape" variant="light" style={{ cursor: "pointer" }} onClick={splitCtrl.open}>Split ({splits.length})</Badge>
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setSplits(null)} aria-label="Clear split"><IconX size={13} /></ActionIcon>
        </Group>
      ) : (
        <Select
          size="xs"
          placeholder="Category"
          data={[{ value: SPLIT_VALUE, label: "⑂ Split between categories…" }, ...pickerData]}
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
        prefix={currency.symbol}
        decimalScale={2}
        hideControls
        min={0}
        disabled={!!splits}
        value={splits ? Math.abs(splitTotal) / 100 : magnitude}
        onChange={setMagnitude}
        styles={{ input: { textAlign: "right" } }}
        leftSection={
          <ActionIcon size="sm" variant="subtle" color={direction === "out" ? "red" : "teal"} onClick={() => setDirection((d) => (d === "out" ? "in" : "out"))} disabled={!!splits} aria-label="Toggle inflow/outflow">
            {direction === "out" ? <IconMinus size={14} /> : <IconPlus size={14} />}
          </ActionIcon>
        }
      />
      <Select
        size="xs"
        data={REPEAT_OPTIONS}
        value={transferTo ? REPEAT_NONE : repeat}
        onChange={(v) => setRepeat(v ?? REPEAT_NONE)}
        allowDeselect={false}
        disabled={!!transferTo}
        comboboxProps={{ withinPortal: true }}
        aria-label="Repeat"
      />
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
