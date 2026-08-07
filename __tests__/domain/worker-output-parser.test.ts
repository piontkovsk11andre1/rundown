import { describe, expect, it } from "vitest";
import { parseWorkerOutput } from "../../src/domain/worker-output-parser.js";

describe("parseWorkerOutput", () => {
  it("extracts thinking blocks from supported delimiters", () => {
    const stdout = [
      "before",
      "<thinking>",
      "first idea",
      "</thinking>",
      "```thinking",
      "second idea",
      "```",
      "```opencode-thinking",
      "third idea",
      "```",
    ].join("\n");

    expect(parseWorkerOutput(stdout).thinking_blocks).toEqual([
      { content: "first idea" },
      { content: "second idea" },
      { content: "third idea" },
    ]);
  });

  it("parses rundown-trace block and derives tool_calls", () => {
    const stdout = [
      "```rundown-trace",
      "confidence: 90",
      "tools_used: read, apply_patch, read",
      "approach: implement parser",
      "```",
    ].join("\n");

    const result = parseWorkerOutput(stdout);

    expect(result.agent_signals).toEqual({
      confidence: "90",
      tools_used: "read, apply_patch, read",
      approach: "implement parser",
    });
    expect(result.tool_calls).toEqual(["read", "apply_patch"]);
  });

  it("handles combined output with thinking blocks and trace signals", () => {
    const stdout = [
      "analysis",
      "<thinking>",
      "map task steps",
      "</thinking>",
      "```rundown-trace",
      "tools_used: grep, read",
      "blockers: none",
      "```",
      "```thinking",
      "apply focused patch",
      "```",
    ].join("\n");

    const result = parseWorkerOutput(stdout);

    expect(result.thinking_blocks).toEqual([
      { content: "map task steps" },
      { content: "apply focused patch" },
    ]);
    expect(result.agent_signals).toEqual({
      tools_used: "grep, read",
      blockers: "none",
    });
    expect(result.tool_calls).toEqual(["grep", "read"]);
    expect(result.raw_stdout).toBe(stdout);
  });

  it("returns empty analysis for empty stdout", () => {
    const result = parseWorkerOutput("");

    expect(result).toEqual({
      thinking_blocks: [],
      tool_calls: [],
      agent_signals: null,
      raw_stdout: "",
    });
  });

  it("returns no trace-relevant data when stdout has no matching content", () => {
    const stdout = "Task completed successfully with no extra blocks.";
    const result = parseWorkerOutput(stdout);

    expect(result.thinking_blocks).toEqual([]);
    expect(result.tool_calls).toEqual([]);
    expect(result.agent_signals).toBeNull();
    expect(result.raw_stdout).toBe(stdout);
  });
});
