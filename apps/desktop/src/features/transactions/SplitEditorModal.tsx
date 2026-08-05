import { useEffect, useState } from "react";
import { ActionIcon, Box, Button, Group, Modal, NumberInput, Select, Slider, Stack, Text, TextInput } from "@mantine/core";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import { newId, type Cents, type SplitLine, type Ulid } from "@cash-money/core";
import { useApp } from "../../state";
import { money } from "../../format";

interface Line {
  key: string;
  categoryId: string | null;
  amount: number | string; // euros, magnitude
  memo: string;
}

const BAR_COLORS = ["indigo", "teal", "orange", "grape", "cyan", "lime", "pink", "yellow"];

/**
 * Split a payment across categories. Works on a draft `amount` (signed cents),
 * so it can be used both while entering a new transaction and to edit an
 * existing one. Amounts are magnitudes; the sign comes from the transaction.
 */
export function SplitEditorModal({
  opened,
  onClose,
  amount,
  initialSplits,
  onSave,
  onUnsplit,
}: {
  opened: boolean;
  onClose: () => void;
  amount: Cents;
  initialSplits?: SplitLine[];
  onSave: (splits: SplitLine[]) => void;
  onUnsplit?: () => void;
}) {
  const { budget, currency } = useApp();
  const sign = amount < 0 ? -1 : 1;
  const target = Math.abs(amount) / 100;
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    if (!opened) return;
    if (initialSplits?.length) {
      setLines(initialSplits.map((s) => ({ key: s.id, categoryId: s.categoryId ?? null, amount: Math.abs(s.amount) / 100, memo: s.memo })));
    } else {
      setLines([
        { key: newId(), categoryId: null, amount: target, memo: "" },
        { key: newId(), categoryId: null, amount: 0, memo: "" },
      ]);
    }
  }, [opened, initialSplits, target]);

  const options = budget.groups
    .filter((g) => g.kind !== "income")
    .map((g) => ({ group: g.name, items: budget.categories.filter((c) => c.groupId === g.id).map((c) => ({ value: c.id, label: c.name })) }))
    .filter((grp) => grp.items.length > 0);

  const sum = lines.reduce((s, l) => s + Number(l.amount || 0), 0);
  const remaining = target - sum;
  const balanced = Math.abs(remaining) < 0.005 && lines.length >= 2;

  const setAmount = (key: string, val: number) => {
    setLines((ls) => {
      // Two-way binding when exactly two lines (so the slider + boxes agree).
      if (ls.length === 2) {
        const otherKey = ls.find((l) => l.key !== key)!.key;
        const v = Math.max(0, Math.min(val, target));
        return ls.map((l) => (l.key === key ? { ...l, amount: v } : l.key === otherKey ? { ...l, amount: Math.round((target - v) * 100) / 100 } : l));
      }
      return ls.map((l) => (l.key === key ? { ...l, amount: val } : l));
    });
  };
  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const addLine = () => setLines((ls) => [...ls, { key: newId(), categoryId: null, amount: 0, memo: "" }]);
  const removeLine = (key: string) => setLines((ls) => (ls.length <= 2 ? ls : ls.filter((l) => l.key !== key)));
  const distributeEvenly = () => {
    const n = lines.length;
    const each = Math.floor((target / n) * 100) / 100;
    setLines((ls) => ls.map((l, i) => ({ ...l, amount: i === n - 1 ? Math.round((target - each * (n - 1)) * 100) / 100 : each })));
  };

  const save = () => {
    if (!balanced) return;
    onSave(lines.map((l) => ({ id: newId(), amount: (sign * Math.round(Number(l.amount) * 100)) as Cents, memo: l.memo, ...(l.categoryId ? { categoryId: l.categoryId as Ulid } : {}) })));
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Split transaction" centered size="lg">
      <Stack>
        <Group justify="space-between">
          <Text size="sm" c="dimmed">Total: {money(amount, currency)}</Text>
          <Button size="compact-xs" variant="subtle" onClick={distributeEvenly}>Distribute evenly</Button>
        </Group>

        {/* Proportion bar */}
        <Group gap={2} wrap="nowrap" style={{ height: 10 }}>
          {lines.map((l, i) => {
            const pct = target > 0 ? (Number(l.amount || 0) / target) * 100 : 0;
            return <Box key={l.key} style={{ width: `${Math.max(0, pct)}%`, height: "100%", borderRadius: 3, background: `var(--mantine-color-${BAR_COLORS[i % BAR_COLORS.length]}-6)` }} />;
          })}
        </Group>

        {lines.length === 2 && (
          <Slider
            value={Number(lines[0]!.amount) || 0}
            onChange={(v) => setAmount(lines[0]!.key, v)}
            min={0}
            max={target}
            step={0.01}
            label={(v) => `€${v.toFixed(2)}`}
          />
        )}

        {lines.map((l, i) => (
          <Group key={l.key} align="flex-end" wrap="nowrap">
            <Box w={10} h={30} style={{ borderRadius: 3, background: `var(--mantine-color-${BAR_COLORS[i % BAR_COLORS.length]}-6)` }} />
            <Select label={i === 0 ? "Category" : undefined} placeholder="Category" data={options} value={l.categoryId} onChange={(v) => update(l.key, { categoryId: v })} searchable style={{ flex: 2 }} comboboxProps={{ withinPortal: true }} />
            <NumberInput label={i === 0 ? "Amount" : undefined} prefix="€" decimalScale={2} fixedDecimalScale min={0} value={l.amount} onChange={(v) => setAmount(l.key, Number(v || 0))} style={{ flex: 1 }} />
            <TextInput label={i === 0 ? "Memo" : undefined} value={l.memo} onChange={(e) => update(l.key, { memo: e.currentTarget.value })} style={{ flex: 1 }} />
            <ActionIcon color="red" variant="subtle" onClick={() => removeLine(l.key)} disabled={lines.length <= 2} aria-label="Remove line"><IconTrash size={16} /></ActionIcon>
          </Group>
        ))}

        <Group justify="space-between">
          <Button variant="subtle" leftSection={<IconPlus size={16} />} onClick={addLine}>Add split</Button>
          <Text size="sm" c={balanced ? "teal" : "red"}>{balanced ? "Balanced" : `${remaining > 0 ? "Unassigned" : "Over"}: €${Math.abs(remaining).toFixed(2)}`}</Text>
        </Group>

        <Group justify="space-between">
          {onUnsplit ? <Button variant="default" color="red" onClick={onUnsplit}>Remove split</Button> : <span />}
          <Group>
            <Button variant="default" onClick={onClose}>Cancel</Button>
            <Button onClick={save} disabled={!balanced}>Save split</Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
