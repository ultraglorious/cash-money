import { createTheme } from "@mantine/core";

/**
 * Brand chrome is indigo; money semantics stay separate and consistent
 * everywhere: teal = positive/available, red = negative/overspent, blue =
 * transfer, grape = household/split. Keeping brand ≠ money color avoids
 * "is this green because it's good or because it's the brand?" confusion.
 */
export const theme = createTheme({
  primaryColor: "indigo",
  primaryShade: { light: 6, dark: 5 },
  defaultRadius: "md",
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  headings: { fontWeight: "700" },
  cursorType: "pointer",
});

/** Semantic color for a signed money amount. */
export function amountColor(value: number): string | undefined {
  if (value < 0) return "red";
  if (value > 0) return "teal";
  return "dimmed";
}

// Distinct accent per household, assigned by stable index so the same household
// always gets the same colour across the sidebar and the Plan.
const HOUSEHOLD_PALETTE = ["indigo", "teal", "orange", "grape", "cyan", "lime", "pink", "yellow"];

export function householdColor(household: string, households: readonly string[]): string {
  const i = households.indexOf(household);
  return HOUSEHOLD_PALETTE[(i < 0 ? 0 : i) % HOUSEHOLD_PALETTE.length]!;
}
