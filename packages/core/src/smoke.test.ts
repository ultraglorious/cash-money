import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "./index.js";

describe("toolchain smoke test", () => {
  it("imports the core package", () => {
    expect(CORE_VERSION).toBe("0.0.0");
  });
});
