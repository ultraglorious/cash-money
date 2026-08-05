import { describe, expect, it } from "vitest";
import {
  addMonths,
  compareMonth,
  daysBetween,
  monthKeyOf,
  monthRange,
  parseImportDate,
  parseImportMonth,
} from "./time.js";

describe("parseImportDate (DD.MM.YYYY)", () => {
  it("parses day-first dotted dates", () => {
    expect(parseImportDate("01.09.2026")).toBe("2026-09-01");
    expect(parseImportDate("10.07.2026")).toBe("2026-07-10");
    expect(parseImportDate("31.12.2018")).toBe("2018-12-31");
  });
  it("rejects malformed dates", () => {
    expect(() => parseImportDate("2026-09-01")).toThrow();
    expect(() => parseImportDate("13.31.2026")).toThrow();
  });
});

describe("parseImportMonth (MMM YYYY)", () => {
  it("parses month names", () => {
    expect(parseImportMonth("Aug 2026")).toBe("2026-08");
    expect(parseImportMonth("May 2018")).toBe("2018-05");
    expect(parseImportMonth("Sep 2021")).toBe("2021-09");
  });
});

describe("month math", () => {
  it("derives the month of a date", () => {
    expect(monthKeyOf("2026-09-01")).toBe("2026-09");
  });
  it("adds and subtracts months across year boundaries", () => {
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-08", 5)).toBe("2027-01");
  });
  it("orders months", () => {
    expect(compareMonth("2026-01", "2026-02")).toBe(-1);
    expect(compareMonth("2026-02", "2026-02")).toBe(0);
    expect(compareMonth("2027-01", "2026-12")).toBe(1);
  });
  it("builds inclusive ranges", () => {
    expect(monthRange("2026-11", "2027-02")).toEqual([
      "2026-11", "2026-12", "2027-01", "2027-02",
    ]);
    expect(monthRange("2026-02", "2026-01")).toEqual([]);
  });
});

describe("daysBetween", () => {
  it("counts days regardless of order and across months", () => {
    expect(daysBetween("2026-05-30", "2026-06-01")).toBe(2);
    expect(daysBetween("2026-06-01", "2026-05-30")).toBe(2);
    expect(daysBetween("2026-07-31", "2026-07-31")).toBe(0);
  });
});
