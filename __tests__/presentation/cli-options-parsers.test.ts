import { describe, expect, it } from "vitest";
import { parseCooldown, parseScanCount } from "../../src/presentation/cli-options.js";

describe("parseCooldown", () => {
  it("returns milliseconds for positive cooldown seconds", () => {
    expect(parseCooldown("1")).toBe(1_000);
    expect(parseCooldown("60")).toBe(60_000);
  });

  it("rejects zero cooldown", () => {
    expect(() => parseCooldown("0")).toThrow("Invalid --cooldown value: 0");
    expect(() => parseCooldown("0")).toThrow("Must be a positive integer");
  });

  it("rejects non-integer cooldown values", () => {
    expect(() => parseCooldown("abc")).toThrow("Invalid --cooldown value: abc");
  });

  it("rejects unsafe integer cooldown values", () => {
    expect(() => parseCooldown("9007199254740993")).toThrow("Must be a safe positive integer");
  });
});

describe("parseScanCount", () => {
  it("returns undefined when omitted", () => {
    expect(parseScanCount(undefined)).toBeUndefined();
  });

  it("returns parsed positive integers", () => {
    expect(parseScanCount("1")).toBe(1);
    expect(parseScanCount("5")).toBe(5);
  });

  it("rejects zero or non-integer values", () => {
    expect(() => parseScanCount("0")).toThrow("Invalid --scan-count value: 0");
    expect(() => parseScanCount("abc")).toThrow("Invalid --scan-count value: abc");
  });
});
