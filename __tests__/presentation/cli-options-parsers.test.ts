import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseCooldown,
  parseMaxItems,
  parseResolveRepairAttempts,
  parseScanCount,
  resolveTranslateMarkdownFiles,
} from "../../src/presentation/cli-options.js";

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

describe("parseResolveRepairAttempts", () => {
  it("defaults to one resolve-informed repair attempt when omitted", () => {
    expect(parseResolveRepairAttempts(undefined)).toBe(1);
  });

  it("parses explicit resolve-informed repair-attempt values", () => {
    expect(parseResolveRepairAttempts("0")).toBe(0);
    expect(parseResolveRepairAttempts("3")).toBe(3);
  });

  it("rejects non-integer values", () => {
    expect(() => parseResolveRepairAttempts("abc")).toThrow("Invalid --resolve-repair-attempts value: abc");
  });
});

describe("resolveTranslateMarkdownFiles", () => {
  it("accepts existing markdown inputs and markdown output in existing parent directory", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-translate-opts-"));
    try {
      const whatPath = path.join(tempRoot, "what.md");
      const howPath = path.join(tempRoot, "how.markdown");
      const outputPath = path.join(tempRoot, "out.md");

      fs.writeFileSync(whatPath, "# What\n", "utf8");
      fs.writeFileSync(howPath, "# How\n", "utf8");

      expect(resolveTranslateMarkdownFiles(whatPath, howPath, outputPath)).toEqual({
        whatMarkdownFile: whatPath,
        howMarkdownFile: howPath,
        outputMarkdownFile: outputPath,
      });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects non-markdown input paths", () => {
    expect(() => resolveTranslateMarkdownFiles("what.txt", "how.md", "out.md")).toThrow(
      "Invalid translate <what> document path: what.txt",
    );
  });

  it("rejects missing <what> file", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-translate-opts-"));
    try {
      const whatPath = path.join(tempRoot, "what.md");
      const howPath = path.join(tempRoot, "how.md");
      const outputPath = path.join(tempRoot, "out.md");
      fs.writeFileSync(howPath, "# How\n", "utf8");

      expect(() => resolveTranslateMarkdownFiles(whatPath, howPath, outputPath)).toThrow(
        `Invalid translate document path for <what>: ${whatPath}`,
      );
      expect(() => resolveTranslateMarkdownFiles(whatPath, howPath, outputPath)).toThrow("does not exist");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects when output parent directory does not exist", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-translate-opts-"));
    try {
      const whatPath = path.join(tempRoot, "what.md");
      const howPath = path.join(tempRoot, "how.md");
      const outputPath = path.join(tempRoot, "missing", "out.md");

      fs.writeFileSync(whatPath, "# What\n", "utf8");
      fs.writeFileSync(howPath, "# How\n", "utf8");

      expect(() => resolveTranslateMarkdownFiles(whatPath, howPath, outputPath)).toThrow(
        `Invalid translate document path for <output>: ${outputPath}`,
      );
      expect(() => resolveTranslateMarkdownFiles(whatPath, howPath, outputPath)).toThrow("Parent directory does not exist");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects when output path matches how path", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-translate-opts-"));
    try {
      const whatPath = path.join(tempRoot, "what.md");
      const howPath = path.join(tempRoot, "how.md");

      fs.writeFileSync(whatPath, "# What\n", "utf8");
      fs.writeFileSync(howPath, "# How\n", "utf8");

      expect(() => resolveTranslateMarkdownFiles(whatPath, howPath, howPath)).toThrow(
        "The `translate` command does not allow <output> to be the same path as <how>",
      );
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
