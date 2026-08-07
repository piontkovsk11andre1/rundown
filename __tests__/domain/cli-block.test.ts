import { describe, expect, it, vi } from "vitest";
import { expandCliBlocks, extractCliBlocks } from "../../src/domain/cli-block.js";
import type { CommandExecutor } from "../../src/domain/ports/command-executor.js";

describe("extractCliBlocks", () => {
  it("extracts cli fenced blocks with command lines", () => {
    const source = [
      "Before",
      "```cli",
      "cat TestFile.txt",
      "sql -m \"SELECT id, name FROM users LIMIT 5\"",
      "```",
      "After",
    ].join("\n");

    const blocks = extractCliBlocks(source);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      startOffset: source.indexOf("```cli"),
      endOffset: source.indexOf("```", source.indexOf("```cli") + 1) + 3,
      commands: [
        "cat TestFile.txt",
        "sql -m \"SELECT id, name FROM users LIMIT 5\"",
      ],
    });
  });

  it("extracts multiple blocks and ignores empty lines", () => {
    const source = [
      "```cli",
      "",
      "  npm test  ",
      "",
      "```",
      "middle",
      "```cli",
      "pnpm lint",
      "pnpm typecheck",
      "```",
    ].join("\n");

    const blocks = extractCliBlocks(source);

    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.commands).toEqual(["npm test"]);
    expect(blocks[1]?.commands).toEqual(["pnpm lint", "pnpm typecheck"]);
    expect(blocks[0]!.endOffset).toBeLessThan(blocks[1]!.startOffset);
  });

  it("extracts empty cli blocks with no commands", () => {
    const source = ["before", "```cli", "", "   ", "```", "after"].join("\n");

    const blocks = extractCliBlocks(source);

    expect(blocks).toEqual([
      {
        startOffset: source.indexOf("```cli"),
        endOffset: source.lastIndexOf("```") + 3,
        commands: [],
      },
    ]);
  });

  it("supports CRLF and trailing spaces in fence line", () => {
    const source = [
      "prefix",
      "```cli   ",
      "echo hello",
      "```",
    ].join("\r\n");

    const blocks = extractCliBlocks(source);

    expect(blocks).toEqual([
      {
        startOffset: source.indexOf("```cli"),
        endOffset: source.lastIndexOf("```") + 3,
        commands: ["echo hello"],
      },
    ]);
  });

  it("treats non-empty, non-comment lines as commands", () => {
    const source = [
      "```cli",
      "",
      "# comment",
      "   # spaced comment",
      "echo one",
      "  echo two  ",
      "",
      "```",
    ].join("\n");

    const blocks = extractCliBlocks(source);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.commands).toEqual(["echo one", "echo two"]);
  });

  it("returns an empty array when no cli block exists", () => {
    const source = [
      "```bash",
      "echo hello",
      "```",
      "- [ ] task",
    ].join("\n");

    expect(extractCliBlocks(source)).toEqual([]);
  });

  it("ignores cli fences nested inside other fenced blocks", () => {
    const source = [
      "~~~markdown",
      "```cli",
      "echo nested",
      "```",
      "~~~",
      "```cli",
      "echo top",
      "```",
    ].join("\n");

    const blocks = extractCliBlocks(source);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.commands).toEqual(["echo top"]);
  });

  it("ignores cli fences nested in longer backtick fences", () => {
    const source = [
      "````",
      "```cli",
      "echo nested",
      "```",
      "````",
      "```cli",
      "echo top",
      "```",
    ].join("\n");

    const blocks = extractCliBlocks(source);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.commands).toEqual(["echo top"]);
  });
});

describe("expandCliBlocks", () => {
  it("returns source unchanged when no cli blocks exist", async () => {
    const source = ["# Title", "```bash", "echo hi", "```"].join("\n");
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    }));
    const executor: CommandExecutor = { execute };

    const expanded = await expandCliBlocks(source, executor, "/tmp");

    expect(expanded).toBe(source);
    expect(execute).not.toHaveBeenCalled();
  });

  it("replaces cli blocks with command and output xml", async () => {
    const source = [
      "before",
      "```cli",
      "echo one",
      "echo two",
      "```",
      "after",
    ].join("\n");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "one\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "two\n", stderr: "warn\n" });
    const executor: CommandExecutor = { execute };

    const expanded = await expandCliBlocks(source, executor, "C:/repo");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, "echo one", "C:/repo", undefined);
    expect(execute).toHaveBeenNthCalledWith(2, "echo two", "C:/repo", undefined);
    expect(expanded).toBe([
      "before",
      "<command>echo one</command>",
      "<output>",
      "one",
      "",
      "</output>",
      "",
      "<command>echo two</command>",
      "<output>",
      "two",
      "",
      "</output>",
      "after",
    ].join("\n"));
  });

  it("includes exit_code for non-zero command results", async () => {
    const source = ["```cli", "bad cmd", "```"].join("\n");
    const execute = vi.fn(async () => ({
      exitCode: 1,
      stdout: "ignored stdout\n",
      stderr: "ERROR: failed\n",
    }));
    const executor: CommandExecutor = { execute };

    const expanded = await expandCliBlocks(source, executor, "/work");

    expect(expanded).toContain('<command exit_code="1">bad cmd</command>');
    expect(expanded).toContain("ERROR: failed");
    expect(expanded).not.toContain("ignored stdout");
  });

  it("annotates timed-out command output with timeout exit code", async () => {
    const source = ["```cli", "slow cmd", "```"].join("\n");
    const execute = vi.fn(async () => ({
      exitCode: 124,
      stdout: "",
      stderr: "Command timed out after 30000ms.",
    }));
    const executor: CommandExecutor = { execute };

    const expanded = await expandCliBlocks(source, executor, "/work");

    expect(expanded).toContain('<command exit_code="timeout">slow cmd</command>');
    expect(expanded).toContain("ERROR: command timed out");
    expect(expanded).toContain("Command timed out after 30000ms.");
  });

  it("escapes xml-sensitive characters in command and output", async () => {
    const source = ["```cli", "echo <x> & \"y\"", "```"].join("\n");
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stdout: "a < b & c > d\n",
      stderr: "",
    }));
    const executor: CommandExecutor = { execute };

    const expanded = await expandCliBlocks(source, executor, "/work");

    expect(expanded).toContain(
      "<command>echo &lt;x&gt; &amp; &quot;y&quot;</command>",
    );
    expect(expanded).toContain("a &lt; b &amp; c &gt; d");
  });

  it("forwards command execution options to the executor", async () => {
    const source = ["```cli", "echo one", "```"].join("\n");
    const execute = vi.fn(async () => ({
      exitCode: 0,
      stdout: "one\n",
      stderr: "",
    }));
    const executor: CommandExecutor = { execute };

    await expandCliBlocks(source, executor, "C:/repo", { timeoutMs: 42 });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("echo one", "C:/repo", { timeoutMs: 42 });
  });

  it("calls onCommandExecuted with command metrics", async () => {
    const source = ["```cli", "echo one", "```"].join("\n");
    const execute = vi.fn(async () => ({
      exitCode: 7,
      stdout: "abc",
      stderr: "err",
    }));
    const onCommandExecuted = vi.fn();
    const executor: CommandExecutor = { execute };

    await expandCliBlocks(source, executor, "C:/repo", {
      onCommandExecuted,
    });

    expect(onCommandExecuted).toHaveBeenCalledTimes(1);
    expect(onCommandExecuted).toHaveBeenCalledWith({
      command: "echo one",
      exitCode: 7,
      stdoutLength: 3,
      stderrLength: 3,
      durationMs: expect.any(Number),
    });
  });

  it("forwards command ordinals when artifact context is provided", async () => {
    const source = ["```cli", "echo one", "echo two", "```"].join("\n");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ exitCode: 0, stdout: "one\n", stderr: "" })
      .mockResolvedValueOnce({ exitCode: 0, stdout: "two\n", stderr: "" });
    const executor: CommandExecutor = { execute };

    await expandCliBlocks(source, executor, "C:/repo", {
      artifactContext: { runId: "run-test" },
      artifactPhase: "worker",
    });

    expect(execute).toHaveBeenNthCalledWith(1, "echo one", "C:/repo", expect.objectContaining({
      artifactCommandOrdinal: 1,
    }));
    expect(execute).toHaveBeenNthCalledWith(2, "echo two", "C:/repo", expect.objectContaining({
      artifactCommandOrdinal: 2,
    }));
  });
});

describe("expandCliBlocks with fake executor", () => {
  function createFakeExecutor(
    responses: Record<
      string,
      { exitCode: number | null; stdout: string; stderr: string }
    >,
  ): {
    executor: CommandExecutor;
    calls: Array<{ command: string; cwd: string }>;
  } {
    const calls: Array<{ command: string; cwd: string }> = [];

    const executor: CommandExecutor = {
      execute: async (command: string, cwd: string) => {
        calls.push({ command, cwd });
        return responses[command] ?? { exitCode: 0, stdout: "", stderr: "" };
      },
    };

    return { executor, calls };
  }

  it("handles successful command output", async () => {
    const source = ["before", "```cli", "echo ok", "```", "after"].join("\n");
    const { executor, calls } = createFakeExecutor({
      "echo ok": { exitCode: 0, stdout: "ok\n", stderr: "" },
    });

    const expanded = await expandCliBlocks(source, executor, "C:/repo");

    expect(calls).toEqual([{ command: "echo ok", cwd: "C:/repo" }]);
    expect(expanded).toBe([
      "before",
      "<command>echo ok</command>",
      "<output>",
      "ok",
      "",
      "</output>",
      "after",
    ].join("\n"));
  });

  it("handles failed command output and includes exit_code", async () => {
    const source = ["```cli", "bad cmd", "```"].join("\n");
    const { executor } = createFakeExecutor({
      "bad cmd": { exitCode: 1, stdout: "ignored\n", stderr: "boom\n" },
    });

    const expanded = await expandCliBlocks(source, executor, "C:/repo");

    expect(expanded).toContain('<command exit_code="1">bad cmd</command>');
    expect(expanded).toContain("boom");
    expect(expanded).not.toContain("ignored");
  });

  it("handles mixed success and failure commands", async () => {
    const source = ["```cli", "echo ok", "bad cmd", "```"].join("\n");
    const { executor, calls } = createFakeExecutor({
      "echo ok": { exitCode: 0, stdout: "ok\n", stderr: "" },
      "bad cmd": { exitCode: 2, stdout: "", stderr: "nope\n" },
    });

    const expanded = await expandCliBlocks(source, executor, "D:/work");

    expect(calls).toEqual([
      { command: "echo ok", cwd: "D:/work" },
      { command: "bad cmd", cwd: "D:/work" },
    ]);
    expect(expanded).toContain("<command>echo ok</command>");
    expect(expanded).toContain("ok");
    expect(expanded).toContain('<command exit_code="2">bad cmd</command>');
    expect(expanded).toContain("nope");
  });

  it("preserves empty output blocks", async () => {
    const source = ["```cli", "noop", "```"].join("\n");
    const { executor } = createFakeExecutor({
      noop: { exitCode: 0, stdout: "", stderr: "" },
    });

    const expanded = await expandCliBlocks(source, executor, "C:/repo");

    expect(expanded).toBe([
      "<command>noop</command>",
      "<output>",
      "",
      "</output>",
    ].join("\n"));
  });
});
