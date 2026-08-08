import { useState } from "react";
import { Center, Group, Select, Stack, Tabs, Text, Title } from "@mantine/core";
import { IconChartBar, IconChartLine, IconLayoutList, IconStairs } from "@tabler/icons-react";
import type { MonthKey } from "@cash-money/core";
import { useBudgetState } from "../../state";
import { monthLabel } from "./palette";
import { OverviewTab } from "./OverviewTab";
import { WaterfallTab } from "./WaterfallTab";
import { DetailTab } from "./DetailTab";
import { NetWorthTab } from "./NetWorthTab";

export function AnalyticsView() {
  const { months } = useBudgetState();
  const defaultFrom = months[Math.max(0, months.length - 12)] ?? months[0];
  const [from, setFrom] = useState<MonthKey | undefined>(defaultFrom);
  const [to, setTo] = useState<MonthKey | undefined>(months[months.length - 1]);

  if (months.length === 0 || !from || !to) {
    return (
      <Center h={320}>
        <Text c="dimmed">Add some transactions first — analytics needs history to chew on.</Text>
      </Center>
    );
  }
  const options = months.map((m) => ({ value: m, label: monthLabel(m) }));
  const lo = from <= to ? from : to;
  const hi = from <= to ? to : from;

  return (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Title order={3}>Analytics</Title>
        <Group gap="xs">
          <Select size="xs" w={110} data={options} value={from} onChange={(v) => v && setFrom(v)} allowDeselect={false} aria-label="From month" />
          <Text size="xs" c="dimmed">to</Text>
          <Select size="xs" w={110} data={options} value={to} onChange={(v) => v && setTo(v)} allowDeselect={false} aria-label="To month" />
        </Group>
      </Group>

      <Tabs defaultValue="overview" keepMounted={false}>
        <Tabs.List mb="md">
          <Tabs.Tab value="overview" leftSection={<IconChartBar size={15} />}>Overview</Tabs.Tab>
          <Tabs.Tab value="waterfall" leftSection={<IconStairs size={15} />}>Waterfall</Tabs.Tab>
          <Tabs.Tab value="detail" leftSection={<IconLayoutList size={15} />}>Breakdown</Tabs.Tab>
          <Tabs.Tab value="networth" leftSection={<IconChartLine size={15} />}>Net worth</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="overview"><OverviewTab from={lo} to={hi} /></Tabs.Panel>
        <Tabs.Panel value="waterfall"><WaterfallTab from={lo} to={hi} /></Tabs.Panel>
        <Tabs.Panel value="detail"><DetailTab from={lo} to={hi} /></Tabs.Panel>
        <Tabs.Panel value="networth"><NetWorthTab from={lo} to={hi} /></Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
