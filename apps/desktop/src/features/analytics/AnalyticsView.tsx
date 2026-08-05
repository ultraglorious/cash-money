import { Center, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconChartHistogram } from "@tabler/icons-react";

export function AnalyticsView() {
  return (
    <Center h={360}>
      <Stack align="center" gap="sm">
        <ThemeIcon size={56} radius="xl" variant="light" color="grape">
          <IconChartHistogram size={30} />
        </ThemeIcon>
        <Title order={4}>Analytics</Title>
        <Text c="dimmed" ta="center" maw={420}>
          Spending trends, net-worth over time, and category breakdowns will live here.
          Deferred for now — the data model already captures everything these reports need.
        </Text>
      </Stack>
    </Center>
  );
}
