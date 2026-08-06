import { describe, expect, it } from "vitest";
import {
  centsFromDecimalString,
  cents,
  EUR,
  formatMoney,
  parseMoney,
  type Cents,
} from "./money.js";

describe("centsFromDecimalString", () => {
  it("parses whole and fractional amounts", () => {
    expect(centsFromDecimalString("3500.00", 2)).toBe(350000);
    expect(centsFromDecimalString("64.40", 2)).toBe(6440);
    expect(centsFromDecimalString("0.00", 2)).toBe(0);
    expect(centsFromDecimalString("10023.20", 2)).toBe(1002320);
  });

  it("handles signs and parentheses", () => {
    expect(centsFromDecimalString("-64.40", 2)).toBe(-6440);
    expect(centsFromDecimalString("(64.40)", 2)).toBe(-6440);
    expect(centsFromDecimalString("+12.00", 2)).toBe(1200);
  });

  it("pads short fractions and rounds long ones half-away-from-zero", () => {
    expect(centsFromDecimalString("5", 2)).toBe(500);
    expect(centsFromDecimalString("5.1", 2)).toBe(510);
    expect(centsFromDecimalString("5.005", 2)).toBe(501); // 5.00|5 -> round up
    expect(centsFromDecimalString("5.004", 2)).toBe(500);
    expect(centsFromDecimalString("-5.005", 2)).toBe(-501);
  });

  it("is exact for values that trip up naive float math", () => {
    // 0.1 + 0.2 !== 0.3 in floats, but must be exact in cents.
    const a = centsFromDecimalString("0.10", 2);
    const b = centsFromDecimalString("0.20", 2);
    expect(a + b).toBe(centsFromDecimalString("0.30", 2));
  });

  it("rejects garbage", () => {
    expect(() => centsFromDecimalString("", 2)).toThrow();
    expect(() => centsFromDecimalString("abc", 2)).toThrow();
  });
});

describe("parseMoney (lenient, symbol-aware)", () => {
  it("parses symbol-prefixed EUR strings", () => {
    expect(parseMoney("€3500.00", EUR)).toBe(350000);
    expect(parseMoney("-€64.40", EUR)).toBe(-6440);
    expect(parseMoney("€0.00", EUR)).toBe(0);
  });

  it("tolerates group separators even though the export omits them", () => {
    expect(parseMoney("€3,500.00", EUR)).toBe(350000);
    expect(parseMoney("€1,002,320.55", EUR)).toBe(100232055);
  });
});

describe("formatMoney", () => {
  it("round-trips with parseMoney", () => {
    for (const raw of ["€3500.00", "-€64.40", "€0.00", "€1234567.89"]) {
      const parsed = parseMoney(raw, EUR);
      const formatted = formatMoney(parsed, EUR);
      expect(parseMoney(formatted, EUR)).toBe(parsed);
    }
  });

  it("groups thousands and shows the symbol", () => {
    expect(formatMoney(100232055 as Cents, EUR)).toBe("€1,002,320.55");
    expect(formatMoney(-6440 as Cents, EUR)).toBe("-€64.40");
    expect(formatMoney(0 as Cents, EUR)).toBe("€0.00");
  });
});

describe("cents arithmetic", () => {
  it("rejects non-integers", () => {
    expect(() => cents(1.5)).toThrow();
  });
});
