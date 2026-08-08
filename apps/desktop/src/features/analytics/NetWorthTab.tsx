import { useMemo } from "react";
import { Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { LineChart } from "@mantine/charts";
import { compareMonth, netWorthSeries, type Cents, type MonthKey } from "@cash-money/core";
import { useBudgetState } from "../../state";
import { money } from "../../format";
import { amountColor } from "../../theme";
import { monthLabel, useChartPalette } from "./palette";

/** Net worth over time: every account, cumulative, split by account type. */
export function NetWorthTab({ from, to }: { from: MonthKey; to: MonthKey }) {
  const { budget, currency } = useBudgetState();
  const pal = useChartPalette();
  const points = useMemo(() => netWorthSeries(budget), [budget]);
  const shown = points.filter((p) => compareMonth(p.month, from) >= 0 && compareMonth(p.month, to) <= 0);

  const data = shown.map((p) => ({
    month: monthLabel(p.month),
    "Net worth": p.total / 100,
    Cash: p.cash / 100,
    "Credit cards": p.credit / 100,
    Tracking: p.tracking / 100,
  }));
  const fmt = (v: number) => money(Math.round(v * 100) as Cents, currency);

  // Change vs up-to-12-months ago — labeled by what the history actually spans.
  const latest = points[points.length - 1];
  const baseline = points.slice(-13)[0];
  const monthsBack = points.length > 1 ? Math.min(12, points.length - 1) : 0;
  const delta = latest && baseline && baseline !== latest ? latest.total - baseline.total : undefined;

  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Tile label="Net worth" value={money((latest?.total ?? 0) as Cents, currency)} color={amountColor((latest?.total ?? 0) as Cents)} />
        <Tile
          label={`Change (${monthsBack} mo)`}
          value={delta !== undefined ? money(delta as Cents, currency) : "—"}
          color={delta !== undefined ? amountColor(delta as Cents) : undefined}
        />
        <Tile label="Cash" value={money((latest?.cash ?? 0) as Cents, currency)} />
        <Tile label="Tracking" value={money((latest?.tracking ?? 0) as Cents, currency)} />
      </SimpleGrid>

      <Paper withBorder p="md" radius="md">
        <Text size="sm" fw={600} mb="xs">Net worth over time</Text>
        {data.length === 0 ? (
          <Text size="sm" c="dimmed">No history in this range.</Text>
        ) : (
          <LineChart
            h={340}
            data={data}
            dataKey="month"
            withLegend
            valueFormatter={fmt}
            curveType="monotone"
            withDots={false}
            strokeWidth={2}
            series={[
              { name: "Net worth", color: pal.primary },
              { name: "Cash", color: pal.positive },
              { name: "Credit cards", color: pal.accent },
              { name: "Tracking", color: pal.quaternary },
            ]}
          />
        )}
      </Paper>
    </Stack>
  );
}

function Tile({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <Paper withBorder p="md" radius="md">
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>{label}</Text>
      <Text size="xl" fw={700} c={color}>{value}</Text>
    </Paper>
  );
}
