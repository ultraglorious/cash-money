import { useComputedColorScheme } from "@mantine/core";

/**
 * Chart palette, validated (dataviz six-checks: lightness band, chroma floor,
 * CVD separation, normal-vision floor, contrast) against each scheme's
 * surface — dark mode is re-stepped from the same hues, not a flip. Positive/
 * negative are the app's polarity pair (teal in / red out, matching the
 * register); the categorical order for multi-series charts is fixed:
 * primary → positive → accent → quaternary.
 */
export interface ChartPalette {
  primary: string; // indigo: totals, net lines
  positive: string; // teal: income, inflows, cash
  negative: string; // red: spending, outflows
  accent: string; // orange: credit cards
  quaternary: string; // grape: tracking
}

const LIGHT: ChartPalette = {
  primary: "#4c6ef5",
  positive: "#12b886",
  negative: "#fa5252",
  accent: "#fd7e14",
  quaternary: "#be4bdb",
};

const DARK: ChartPalette = {
  primary: "#5c7cfa",
  positive: "#0ca678",
  negative: "#fa5252",
  accent: "#e8590c",
  quaternary: "#be4bdb",
};

export function useChartPalette(): ChartPalette {
  return useComputedColorScheme("light") === "dark" ? DARK : LIGHT;
}

/** "2026-03" → "Mar 26" for axis ticks. */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1] ?? m} ${y!.slice(2)}`;
}
