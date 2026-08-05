import { describe, expect, it } from "vitest";
import { parseCsv, parseDateAs } from "./register.js";

describe("parseCsv", () => {
  it("strips a BOM, trims headers, and keys rows by header", () => {
    const text = '﻿"Date ","Payee"\n"01.02.2026","Shop"\n';
    const { headers, rows } = parseCsv(text);
    expect(headers).toEqual(["Date", "Payee"]);
    expect(rows).toEqual([{ Date: "01.02.2026", Payee: "Shop" }]);
  });

  it("skips blank lines and preserves commas inside quotes", () => {
    const { rows } = parseCsv('"A","B"\n\n"x, y","z"\n');
    expect(rows).toEqual([{ A: "x, y", B: "z" }]);
  });
});

describe("parseDateAs", () => {
  it("parses each layout with -, /, or . separators", () => {
    expect(parseDateAs("2026-02-01", "iso")).toBe("2026-02-01");
    expect(parseDateAs("2026/2/1", "iso")).toBe("2026-02-01");
    expect(parseDateAs("01.02.2026", "dmy")).toBe("2026-02-01");
    expect(parseDateAs("1/2/2026", "dmy")).toBe("2026-02-01");
    expect(parseDateAs("02-01-2026", "mdy")).toBe("2026-02-01");
  });

  it("expands 2-digit years to 20xx", () => {
    expect(parseDateAs("01.02.26", "dmy")).toBe("2026-02-01");
    expect(parseDateAs("2/1/26", "mdy")).toBe("2026-02-01");
  });

  it("rejects out-of-range and malformed dates", () => {
    expect(() => parseDateAs("32.01.2026", "dmy")).toThrow(/Bad date/);
    expect(() => parseDateAs("01.13.2026", "dmy")).toThrow(/Bad date/);
    expect(() => parseDateAs("soon", "iso")).toThrow(/Bad ISO date/);
    expect(() => parseDateAs("", "dmy")).toThrow(/Bad date/);
  });
});
