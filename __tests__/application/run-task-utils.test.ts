import { describe, expect, it } from "vitest";
import type { Task } from "../../src/domain/parser.js";

import {
  asEnum,
  asNonNegativeInt,
  asStringArray,
  computeDurationMs,
  countTraceLines,
  formatTaskLabel,
  hasLongOption,
  hasLongOptionVariant,
  isSameFilePath,
  parseJson,
} from "../../src/application/run-task-utils.js";

describe("run-task-utils", () => {
  describe("parseJson", () => {
    it("parses valid JSON", () => {
      expect(parseJson<{ value: number }>("{\"value\":1}")).toEqual({ value: 1 });
    });

    it("returns null for invalid JSON", () => {
      expect(parseJson("not-json")).toBeNull();
    });
  });

  describe("asStringArray", () => {
    it("keeps trimmed non-empty strings", () => {
      expect(asStringArray(["  a  ", "", "  ", 1, "b"])).toEqual(["a", "b"]);
    });

    it("returns empty array for non-array input", () => {
      expect(asStringArray("nope")).toEqual([]);
    });
  });

  describe("asNonNegativeInt", () => {
    it("normalizes numeric inputs", () => {
      expect(asNonNegativeInt(4.9)).toBe(4);
      expect(asNonNegativeInt(-1)).toBe(0);
    });

    it("parses numeric strings", () => {
      expect(asNonNegativeInt("42")).toBe(42);
      expect(asNonNegativeInt(" 7 ")).toBe(7);
    });

    it("falls back to 0 for invalid values", () => {
      expect(asNonNegativeInt("abc")).toBe(0);
      expect(asNonNegativeInt({})).toBe(0);
    });
  });

  describe("asEnum", () => {
    it("returns fallback for invalid values", () => {
      expect(asEnum("bad", ["a", "b"] as const, "a")).toBe("a");
      expect(asEnum(1, ["a", "b"] as const, "a")).toBe("a");
    });

    it("returns matching value", () => {
      expect(asEnum("b", ["a", "b"] as const, "a")).toBe("b");
    });
  });

  describe("countTraceLines", () => {
    it("counts line endings", () => {
      expect(countTraceLines("")).toBe(0);
      expect(countTraceLines("one")).toBe(1);
      expect(countTraceLines("one\ntwo")).toBe(2);
      expect(countTraceLines("one\r\ntwo\r\nthree")).toBe(3);
    });
  });

  describe("computeDurationMs", () => {
    it("computes non-negative differences", () => {
      expect(computeDurationMs("2025-01-01T00:00:00.000Z", "2025-01-01T00:00:01.250Z")).toBe(1250);
      expect(computeDurationMs("2025-01-01T00:00:01.000Z", "2025-01-01T00:00:00.000Z")).toBe(0);
    });

    it("returns 0 when timestamps are missing or invalid", () => {
      expect(computeDurationMs(undefined, "2025-01-01T00:00:01.000Z")).toBe(0);
      expect(computeDurationMs("invalid", "2025-01-01T00:00:01.000Z")).toBe(0);
    });
  });

  describe("formatTaskLabel", () => {
    it("formats task label", () => {
      const task: Task = {
        text: "Do thing",
        checked: false,
        index: 3,
        line: 12,
        column: 1,
        offsetStart: 0,
        offsetEnd: 10,
        file: "todo.md",
        isInlineCli: false,
        depth: 0,
        children: [],
        subItems: [],
      };

      expect(formatTaskLabel(task)).toBe("todo.md:12 [#3] Do thing");
    });
  });

  describe("option helpers", () => {
    it("detects long options and variants", () => {
      const args = ["--verify", "--worker=foo"];
      expect(hasLongOption(args, "--verify")).toBe(true);
      expect(hasLongOption(args, "--worker")).toBe(true);
      expect(hasLongOption(args, "--missing")).toBe(false);
      expect(hasLongOptionVariant(args, ["--no-verify", "--verify"])).toBe(true);
    });
  });

  describe("isSameFilePath", () => {
    it("compares identical paths", () => {
      expect(isSameFilePath("a/b.md", "a/b.md")).toBe(true);
    });
  });
});
