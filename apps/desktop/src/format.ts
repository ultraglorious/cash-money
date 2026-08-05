import { formatMoney, type Cents, type CurrencyConfig } from "@cash-money/core";

export function money(value: number, currency: CurrencyConfig): string {
  return formatMoney(value as Cents, currency);
}

export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(m) - 1] ?? m} ${y}`;
}

export function monthToDate(month: string): Date {
  const [y, m] = month.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, 1);
}

export function dateToMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Current calendar month, clamped into an available range. */
export function currentMonthClamped(months: string[]): string {
  if (months.length === 0) return dateToMonthKey(new Date());
  const now = dateToMonthKey(new Date());
  const first = months[0]!;
  const last = months[months.length - 1]!;
  if (now < first) return first;
  if (now > last) return last;
  return now;
}
