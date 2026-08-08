import { useMemo, useState } from "react";
import { Anchor, Breadcrumbs, Group, Paper, SegmentedControl, Stack, Table, Text } from "@mantine/core";
import { BarChart } from "@mantine/charts";
import { IconChevronRight } from "@tabler/icons-react";
import {
  flows,
  TRANSFERS,
  UNCATEGORIZED,
  type Cents,
  type FlowDimension,
  type FlowFilter,
  type FlowNode,
  type MonthKey,
  type Ulid,
} from "@cash-money/core";
import { useBudgetState } from "../../state";
import { money } from "../../format";
import { amountColor } from "../../theme";
import { useChartPalette } from "./palette";

interface Level {
  by: FlowDimension;
  label: string;
  accountId?: Ulid;
  groupId?: Ulid;
  categoryId?: Ulid;
}

const MAX_BARS = 12;

/**
 * One waterfall over the selected range: inflows step up, outflows step down,
 * the last bar is the net. Drill by clicking a bar (or its row below):
 * account → section → category → payee, or straight into sections.
 */
export function WaterfallTab({ from, to }: { from: MonthKey; to: MonthKey }) {
  const { budget, currency } = useBudgetState();
  const pal = useChartPalette();
  const [mode, setMode] = useState<"section" | "account">("section");
  const [stack, setStack] = useState<Level[]>([]);

  const level: Level = stack[stack.length - 1] ?? { by: mode, label: "" };
  const filter: FlowFilter = { from, to, accountId: level.accountId, groupId: level.groupId, categoryId: level.categoryId };
  const nodes = useMemo(() => flows(budget, level.by, filter), [budget, level.by, from, to, level.accountId, level.groupId, level.categoryId]);

  // Positive steps first (largest first), then outflows (largest magnitude
  // first); cap the bar count so labels stay readable.
  const ordered = [...nodes].sort((a, b) => (a.amount >= 0 && b.amount < 0 ? -1 : a.amount < 0 && b.amount >= 0 ? 1 : Math.abs(b.amount) - Math.abs(a.amount)));
  const shown = ordered.slice(0, MAX_BARS);
  const rest = ordered.slice(MAX_BARS);
  const restSum = rest.reduce((s, n) => s + n.amount, 0);
  const total = nodes.reduce((s, n) => s + n.amount, 0);

  const chartData = [
    ...shown.map((n) => ({ item: n.label, Amount: n.amount / 100, color: n.amount >= 0 ? pal.positive : pal.negative })),
    ...(rest.length > 0 ? [{ item: `(${rest.length} more)`, Amount: restSum / 100, color: restSum >= 0 ? pal.positive : pal.negative }] : []),
    { item: "Net", Amount: total / 100, color: pal.primary, standalone: true },
  ];
  const fmt = (v: number) => money(Math.round(v * 100) as Cents, currency);

  const drillable = (n: FlowNode): boolean =>
    n.key !== TRANSFERS && n.key !== UNCATEGORIZED && level.by !== "payee";

  const drill = (n: FlowNode) => {
    if (!drillable(n)) return;
    if (level.by === "account") {
      setStack([...stack, { by: "section", label: n.label, accountId: n.key as Ulid }]);
    } else if (level.by === "section") {
      setStack([...stack, { by: "category", label: n.label, accountId: level.accountId, groupId: n.key as Ulid }]);
    } else if (level.by === "category") {
      setStack([...stack, { by: "payee", label: n.label, accountId: level.accountId, groupId: level.groupId, categoryId: n.key as Ulid }]);
    }
  };

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <SegmentedControl
          size="xs"
          data={[
            { label: "By section", value: "section" },
            { label: "By account", value: "account" },
          ]}
          value={mode}
          onChange={(v) => {
            setMode(v as "section" | "account");
            setStack([]);
          }}
        />
        <Breadcrumbs separator={<IconChevronRight size={13} />}>
          <Anchor size="sm" onClick={() => setStack([])}>
            {mode === "section" ? "All sections" : "All accounts"}
          </Anchor>
          {stack.map((l, i) => (
            <Anchor key={i} size="sm" onClick={() => setStack(stack.slice(0, i + 1))} fw={i === stack.length - 1 ? 700 : 400}>
              {l.label}
            </Anchor>
          ))}
        </Breadcrumbs>
      </Group>

      <Paper withBorder p="md" radius="md">
        {level.by !== "account" && !level.accountId && (
          <Text size="xs" c="dimmed" mb={4}>
            Global view: transfers between households are netted out. Drill into an account to see its own ins and outs.
          </Text>
        )}
        {nodes.length === 0 ? (
          <Text size="sm" c="dimmed">Nothing in this range.</Text>
        ) : (
          <BarChart
            h={340}
            type="waterfall"
            data={chartData}
            dataKey="item"
            withBarValueLabel
            valueFormatter={fmt}
            series={[{ name: "Amount", color: "gray.6" }]}
            xAxisProps={{ angle: -20, textAnchor: "end", height: 60, interval: 0 }}
            barProps={{
              onClick: (d: { payload?: { item?: string } }) => {
                const hit = shown.find((n) => n.label === d.payload?.item);
                if (hit) drill(hit);
              },
              cursor: "pointer",
            }}
          />
        )}
      </Paper>

      {nodes.length > 0 && (
        <Table verticalSpacing={4} maw={560}>
          <Table.Tbody>
            {ordered.map((n) => (
              <Table.Tr
                key={n.key}
                onClick={() => drill(n)}
                style={{ cursor: drillable(n) ? "pointer" : "default" }}
              >
                <Table.Td>
                  <Group gap={6} wrap="nowrap">
                    <Text size="sm" lineClamp={1}>{n.label}</Text>
                    {drillable(n) && <IconChevronRight size={13} opacity={0.4} />}
                  </Group>
                </Table.Td>
                <Table.Td ta="right" w={140}>
                  <Text size="sm" fw={500} c={amountColor(n.amount)}>{money(n.amount, currency)}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
            <Table.Tr style={{ borderTop: "2px solid var(--mantine-color-default-border)" }}>
              <Table.Td><Text size="sm" fw={700}>Net</Text></Table.Td>
              <Table.Td ta="right"><Text size="sm" fw={700} c={amountColor(total as Cents)}>{money(total as Cents, currency)}</Text></Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
