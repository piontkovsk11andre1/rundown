import { describe, expect, it } from "vitest";
import { parseCooldown, parseMaxItems, parseScanCount } from "../../src/presentation/cli-options.js";

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

describe("parseMaxItems", () => {
  it("returns undefined when omitted", () => {
    expect(parseMaxItems(undefined)).toBeUndefined();
  });

  it("accepts zero and positive integers", () => {
    expect(parseMaxItems("0")).toBe(0);
    expect(parseMaxItems("3")).toBe(3);
  });

  it("rejects negative values with a clear message", () => {
    expect(() => parseMaxItems("-1")).toThrow("Invalid --max-items value: -1");
    expect(() => parseMaxItems("-1")).toThrow("Must be a non-negative integer (0 or greater)");
  });

  it("rejects non-integer values with a clear message", () => {
    expect(() => parseMaxItems("1.5")).toThrow("Invalid --max-items value: 1.5");
    expect(() => parseMaxItems("abc")).toThrow("Invalid --max-items value: abc");
    expect(() => parseMaxItems("1.5")).toThrow("Must be a non-negative integer (0 or greater)");
  });
});
