import { describe, expect, it } from "vitest";
import { parseTraceBlock } from "../../src/domain/trace-parser.js";

describe("parseTraceBlock", () => {
  it("extracts a valid rundown-trace block", () => {
    const stdout = [
      "Agent output before block",
      "```rundown-trace",
      "confidence: 87",
      "files_read: src/domain/trace.ts, src/domain/defaults.ts",
      "tools_used: read, apply_patch",
      "approach: Added parser and unit tests",
      "```",
    ].join("\n");

    expect(parseTraceBlock(stdout)).toEqual({
      confidence: "87",
      files_read: "src/domain/trace.ts, src/domain/defaults.ts",
      tools_used: "read, apply_patch",
      approach: "Added parser and unit tests",
    });
  });

  it("returns null when stdout has no rundown-trace block", () => {
    const stdout = [
      "All tasks completed.",
      "No structured trace block was emitted.",
    ].join("\n");

    expect(parseTraceBlock(stdout)).toBeNull();
  });

  it("returns the first rundown-trace block when multiple are present", () => {
    const stdout = [
      "Agent output before block",
      "```rundown-trace",
      "confidence: 87",
      "```",
      "```rundown-trace",
      "confidence: 20",
      "```",
    ].join("\n");

    expect(parseTraceBlock(stdout)).toEqual({
      confidence: "87",
    });
  });

  it("ignores malformed lines and still parses valid key-value entries", () => {
    const stdout = [
      "```rundown-trace",
      "malformed line without separator",
      ": missing-key",
      "valid_key: valid value",
      "another_valid: value:with:colons",
      "   spaced_key   :   spaced value   ",
      "```",
    ].join("\n");

    expect(parseTraceBlock(stdout)).toEqual({
      valid_key: "valid value",
      another_valid: "value:with:colons",
      spaced_key: "spaced value",
    });
  });

  it("handles extra whitespace in block fences and values", () => {
    const stdout = [
      "prefix",
      "```rundown-trace   ",
      "",
      "  confidence   :   99   ",
      "  blockers:   none  ",
      "",
      "```",
      "suffix",
    ].join("\n");

    expect(parseTraceBlock(stdout)).toEqual({
      confidence: "99",
      blockers: "none",
    });
  });
});
