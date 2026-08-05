import { describe, expect, it } from "vitest";
import { ULID_RE, fingerprint, newId } from "./ids.js";

describe("newId", () => {
  it("produces valid, unique ULIDs", () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
    expect(a).toMatch(ULID_RE);
  });
});

describe("fingerprint", () => {
  it("is deterministic for identical inputs", () => {
    const a = fingerprint(["budget-a", "Checking", "2026-07-31", -350000, "Savings"]);
    const b = fingerprint(["budget-a", "Checking", "2026-07-31", -350000, "Savings"]);
    expect(a).toBe(b);
  });

  it("distinguishes reordered / different fields", () => {
    const a = fingerprint(["a", "b"]);
    const b = fingerprint(["b", "a"]);
    expect(a).not.toBe(b);
  });

  it("does not let separators collide fields (a|b vs a+b)", () => {
    // "ab" split into ["a","b"] must not equal ["ab", ""] etc.
    const a = fingerprint(["a", "b"]);
    const b = fingerprint(["ab"]);
    expect(a).not.toBe(b);
  });
});
