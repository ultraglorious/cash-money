import { useMemo } from "react";
import { Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { CompositeChart } from "@mantine/charts";
import { compareMonth, monthlyCashflow, type Cents, type MonthKey } from "@cash-money/core";
import { useBudgetState } from "../../state";
import { money } from "../../format";
import { amountColor } from "../../theme";
import { monthLabel, useChartPalette } from "./palette";

/**
 * The household P&L: income (revenue), spending (costs), net (profit) per
 * month, plus the run-rate numbers a business would watch — computed over
 * FULL months only, so a half-elapsed current month doesn't skew averages.
 */
export function OverviewTab({ from, to }: { from: MonthKey; to: MonthKey }) {
  const { budget, currency } = useBudgetState();
  const pal = useChartPalette();
  const all = useMemo(() => monthlyCashflow(budget), [budget]);

  const rows = all.filter((r) => compareMonth(r.month, from) >= 0 && compareMonth(r.month, to) <= 0);
  const data = rows.map((r) => ({
    month: monthLabel(r.month),
    Income: r.income / 100,
    Spending: r.spending / 100,
    Net: r.net / 100,
  }));
  const fmt = (v: number) => money(Math.round(v * 100) as Cents, currency);

  // Trailing windows over full months (drop the current, likely partial, month).
  const nowMonth = new Date().toISOString().slice(0, 7);
  const full = all.filter((r) => compareMonth(r.month, nowMonth) < 0);
  const window = (n: number) => full.slice(-n);
  const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);
  const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
  const t3spend = avg(window(3).map((r) => r.spending));
  const t3net = avg(window(3).map((r) => r.net));
  const t12 = window(12);
  const t12income = sum(t12.map((r) => r.income));
  const t12net = sum(t12.map((r) => r.net));
  const savingsRate = t12income > 0 ? (t12net / t12income) * 100 : 0;
  const current = all.length > 0 ? all[all.length - 1]! : undefined;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Tile label="Income (this month)" value={money((current?.income ?? 0) as Cents, currency)} />
        <Tile
          label="Spending (this month)"
          value={money((current?.spending ?? 0) as Cents, currency)}
          sub={`avg ${money(Math.round(t3spend) as Cents, currency)}/mo over last 3`}
        />
        <Tile
          label="Net (this month)"
          value={money((current?.net ?? 0) as Cents, currency)}
          color={amountColor((current?.net ?? 0) as Cents)}
          sub={`avg ${money(Math.round(t3net) as Cents, currency)}/mo over last 3`}
        />
        <Tile
          label="Savings rate (12 mo)"
          value={`${savingsRate.toFixed(1)}%`}
          color={savingsRate >= 0 ? "teal" : "red"}
          sub={`spend run rate ${money(Math.round(t3spend * 12) as Cents, currency)}/yr`}
        />
      </SimpleGrid>

      <Paper withBorder p="md" radius="md">
        <Text size="sm" fw={600} mb="xs">Income vs spending, with net</Text>
        {data.length === 0 ? (
          <Text size="sm" c="dimmed">No activity in this range.</Text>
        ) : (
          <CompositeChart
            h={320}
            data={data}
            dataKey="month"
            maxBarWidth={26}
            withLegend
            valueFormatter={fmt}
            curveType="monotone"
            series={[
              { name: "Income", color: pal.positive, type: "bar" },
              { name: "Spending", color: pal.negative, type: "bar" },
              { name: "Net", color: pal.primary, type: "line" },
            ]}
          />
        )}
      </Paper>
    </Stack>
  );
}

function Tile({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
      <Text size="xl" fw={700} c={color}>{value}</Text>
      {sub && <Text size="xs" c="dimmed">{sub}</Text>}
    </Paper>
  );
}
