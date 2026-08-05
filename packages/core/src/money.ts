/**
 * Money is stored everywhere as an integer number of the currency's minor units
 * (e.g. cents for EUR). Never floats — all arithmetic is integer arithmetic, and
 * parsing goes through string manipulation so we never round-trip through a float.
 */

export type Cents = number & { readonly __brand: "Cents" };

/** Coerce/assert an integer into the Cents brand. Throws on non-integers. */
export function cents(n: number): Cents {
  if (!Number.isInteger(n)) {
    throw new Error(`Cents must be an integer, got ${n}`);
  }
  return n as Cents;
}

export const ZERO = 0 as Cents;

export function addC(...values: Cents[]): Cents {
  let sum = 0;
  for (const v of values) sum += v;
  return sum as Cents;
}

export function subC(a: Cents, b: Cents): Cents {
  return (a - b) as Cents;
}

export function negC(a: Cents): Cents {
  return -a as Cents;
}

export function sumC(values: readonly Cents[]): Cents {
  let sum = 0;
  for (const v of values) sum += v;
  return sum as Cents;
}

export interface CurrencyConfig {
  /** ISO 4217-ish code, e.g. "EUR". */
  code: string;
  /** Display symbol, e.g. "€". */
  symbol: string;
  /** Number of minor-unit digits, e.g. 2 for EUR. */
  decimals: number;
  symbolPosition: "before" | "after";
  decimalSeparator: string;
  groupSeparator: string;
}

export const EUR: CurrencyConfig = {
  code: "EUR",
  symbol: "€",
  decimals: 2,
  symbolPosition: "before",
  decimalSeparator: ".",
  groupSeparator: ",",
};

export const USD: CurrencyConfig = {
  code: "USD",
  symbol: "$",
  decimals: 2,
  symbolPosition: "before",
  decimalSeparator: ".",
  groupSeparator: ",",
};

const NEGATIVE_RE = /^\((.*)\)$/;

/**
 * Parse a plain, already-symbol-stripped signed decimal string into minor units.
 * `"3500.00"` (2 decimals) => 350000; `"-64.4"` => -6440; `"3500.005"` rounds
 * half-away-from-zero to the currency's precision.
 *
 * Parsing is done on the digit strings directly so we never touch a float.
 */
export function centsFromDecimalString(
  raw: string,
  decimals: number,
  decimalSeparator = ".",
): Cents {
  let s = raw.trim();
  if (s === "") throw new Error("Cannot parse empty money string");

  let negative = false;
  const paren = NEGATIVE_RE.exec(s);
  if (paren) {
    negative = true;
    s = paren[1]!.trim();
  }
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith("+")) {
    s = s.slice(1).trim();
  }

  const [intPart = "0", fracPartRaw = ""] = s.split(decimalSeparator);

  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPartRaw)) {
    throw new Error(`Cannot parse money string: ${JSON.stringify(raw)}`);
  }

  // Pad/round the fractional part to `decimals` places.
  let frac = fracPartRaw;
  let carry = 0;
  if (frac.length > decimals) {
    const keep = frac.slice(0, decimals);
    const nextDigit = frac.charCodeAt(decimals) - 48; // '0'
    frac = keep;
    if (nextDigit >= 5) carry = 1;
  } else {
    frac = frac.padEnd(decimals, "0");
  }

  const intUnits = (intPart === "" ? 0 : Number(intPart)) * 10 ** decimals;
  const fracUnits = frac === "" ? 0 : Number(frac);
  let total = intUnits + fracUnits + carry;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`Money value out of safe integer range: ${JSON.stringify(raw)}`);
  }
  if (negative) total = -total;
  return total as Cents;
}

/**
 * Lenient parse of a display/import money string that may include the currency
 * symbol, code, whitespace, and group separators. e.g. "€3,500.00", "-€64.40".
 */
export function parseMoney(raw: string, currency: CurrencyConfig): Cents {
  let s = raw.trim();
  if (s === "") throw new Error("Cannot parse empty money string");

  // Strip symbol and code anywhere they appear.
  if (currency.symbol) s = s.split(currency.symbol).join("");
  if (currency.code) s = s.replace(new RegExp(currency.code, "gi"), "");
  // Strip group separators.
  if (currency.groupSeparator) s = s.split(currency.groupSeparator).join("");
  s = s.trim();

  return centsFromDecimalString(s, currency.decimals, currency.decimalSeparator);
}

/** Format minor units for display, e.g. -6440 (EUR) => "-€64.40". */
export function formatMoney(value: Cents, currency: CurrencyConfig): string {
  const negative = value < 0;
  const abs = Math.abs(value);
  const divisor = 10 ** currency.decimals;
  const intPart = Math.trunc(abs / divisor);
  const fracPart = abs % divisor;

  const intStr = groupDigits(String(intPart), currency.groupSeparator);
  const fracStr =
    currency.decimals > 0
      ? currency.decimalSeparator + String(fracPart).padStart(currency.decimals, "0")
      : "";

  const number = intStr + fracStr;
  const withSymbol =
    currency.symbolPosition === "before"
      ? currency.symbol + number
      : number + currency.symbol;

  return negative ? "-" + withSymbol : withSymbol;
}

function groupDigits(digits: string, sep: string): string {
  if (!sep) return digits;
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}
