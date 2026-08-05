import { Group, Text } from "@mantine/core";
import { Logo } from "./Logo";

/** The full brand lockup: mark + "cash money" (theme-adaptive, crisp at any size). */
export function Wordmark({ size = 30 }: { size?: number }) {
  return (
    <Group gap={8} wrap="nowrap">
      <Logo size={size} />
      <Text fw={800} fz={Math.round(size * 0.62)} style={{ letterSpacing: -0.5, lineHeight: 1 }}>
        <Text span inherit variant="gradient" gradient={{ from: "indigo", to: "violet" }}>
          cash
        </Text>
        <Text span inherit c="teal">
          {" "}
          money
        </Text>
      </Text>
    </Group>
  );
}
