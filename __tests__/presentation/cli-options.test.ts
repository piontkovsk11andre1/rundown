import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RunTaskCall = Record<string, unknown>;

const envKeys = ["RUNDOWN_DISABLE_AUTO_PARSE", "RUNDOWN_TEST_MODE"] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../src/create-app.js");
  vi.doUnmock("../../src/domain/workspace-link.js");
  vi.doUnmock("../../src/infrastructure/cancellable-sleep.js");
  vi.doUnmock("../../src/infrastructure/adapters/config-dir-adapter.js");
  vi.doUnmock("../../src/infrastructure/adapters/global-output-log-writer.js");
});

describe("CLI run option normalization", () => {
  it("passes git and hook options as disabled by default", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.commitAfterComplete).toBe(false);
    expect(call.commitMode).toBe("per-task");
    expect(call.commitMessageTemplate).toBeUndefined();
    expect(call.onCompleteCommand).toBeUndefined();
    expect(call.onFailCommand).toBeUndefined();
    expect(call.showAgentOutput).toBe(false);
    expect(call.runAll).toBe(false);
    expect(call.noRepair).toBe(false);
    expect(call.repairAttempts).toBe(1);
    expect(call.resolveRepairAttempts).toBe(1);
    expect(call.forceExecute).toBe(false);
    expect(call.ignoreCliBlock).toBe(false);
  });

  it("uses run defaults from config when commit flags are omitted", async () => {
    const runTask = vi.fn(async () => 0);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-run-defaults-"));
    const previousCwd = process.cwd();
    try {
      const configDir = path.join(tempRoot, ".rundown");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        run: {
          revertable: true,
          commit: false,
          commitMessage: "cfg: {{task}}",
          commitMode: "file-done",
        },
      }, null, 2) + "\n", "utf-8");
      process.chdir(tempRoot);

      const call = await invokeRunAndCaptureCall([
        "run",
        "tasks.md",
        "--all",
        "--worker",
        "opencode",
        "run",
      ], runTask);

      expect(call.keepArtifacts).toBe(true);
      expect(call.commitAfterComplete).toBe(true);
      expect(call.commitMode).toBe("file-done");
      expect(call.commitMessageTemplate).toBe("cfg: {{task}}");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("lets CLI flags override commit defaults while preserving unrelated config defaults", async () => {
    const runTask = vi.fn(async () => 0);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-run-defaults-override-"));
    const previousCwd = process.cwd();
    try {
      const configDir = path.join(tempRoot, ".rundown");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        run: {
          revertable: true,
          commit: false,
          commitMessage: "cfg: {{task}}",
          commitMode: "file-done",
        },
      }, null, 2) + "\n", "utf-8");
      process.chdir(tempRoot);

      const call = await invokeRunAndCaptureCall([
        "run",
        "tasks.md",
        "--all",
        "--commit",
        "--commit-mode",
        "per-task",
        "--commit-message",
        "cli: {{task}}",
        "--worker",
        "opencode",
        "run",
      ], runTask);

      expect(call.commitAfterComplete).toBe(true);
      expect(call.commitMode).toBe("per-task");
      expect(call.commitMessageTemplate).toBe("cli: {{task}}");
      expect(call.keepArtifacts).toBe(true);
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("lets --revertable override config while preserving configured commit message and mode", async () => {
    const runTask = vi.fn(async () => 0);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-run-defaults-revertable-override-"));
    const previousCwd = process.cwd();
    try {
      const configDir = path.join(tempRoot, ".rundown");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        run: {
          revertable: false,
          commit: false,
          commitMessage: "cfg: {{task}}",
          commitMode: "file-done",
        },
      }, null, 2) + "\n", "utf-8");
      process.chdir(tempRoot);

      const call = await invokeRunAndCaptureCall([
        "run",
        "tasks.md",
        "--all",
        "--revertable",
        "--worker",
        "opencode",
        "run",
      ], runTask);

      expect(call.keepArtifacts).toBe(true);
      expect(call.commitAfterComplete).toBe(true);
      expect(call.commitMode).toBe("file-done");
      expect(call.commitMessageTemplate).toBe("cfg: {{task}}");
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("lets empty --commit-message override configured commit message", async () => {
    const runTask = vi.fn(async () => 0);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-run-defaults-empty-commit-message-"));
    const previousCwd = process.cwd();
    try {
      const configDir = path.join(tempRoot, ".rundown");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        run: {
          commit: true,
          commitMessage: "cfg: {{task}}",
          commitMode: "per-task",
        },
      }, null, 2) + "\n", "utf-8");
      process.chdir(tempRoot);

      const call = await invokeRunAndCaptureCall([
        "run",
        "tasks.md",
        "--commit",
        "--commit-message",
        "",
        "--worker",
        "opencode",
        "run",
      ], runTask);

      expect(call.commitAfterComplete).toBe(true);
      expect(call.commitMode).toBe("per-task");
      expect(call.commitMessageTemplate).toBeUndefined();
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes --resolve-repair-attempts override to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--resolve-repair-attempts",
      "4",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.resolveRepairAttempts).toBe(4);
  });

  it("passes --ignore-cli-block flag to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--ignore-cli-block",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.ignoreCliBlock).toBe(true);
  });

  it("passes --cache-cli-blocks flag to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--cache-cli-blocks",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.cacheCliBlocks).toBe(true);
  });

  it("passes show-agent-output option to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--show-agent-output",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.showAgentOutput).toBe(true);
  });

  it("defaults show-agent-output to false when omitted", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.showAgentOutput).toBe(false);
  });

  it("accepts --quiet for run command parsing", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--quiet",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.source).toBe("tasks.md");
  });

  it("accepts -q shorthand for run command parsing", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "-q",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.source).toBe("tasks.md");
  });

  it("normalizes empty commit and hook values to undefined", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--commit",
      "--commit-message",
      "",
      "--on-complete",
      "",
      "--on-fail",
      "",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.commitAfterComplete).toBe(true);
    expect(call.commitMode).toBe("per-task");
    expect(call.commitMessageTemplate).toBeUndefined();
    expect(call.onCompleteCommand).toBeUndefined();
    expect(call.onFailCommand).toBeUndefined();
  });

  it("preserves non-empty commit and hook values", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--commit",
      "--commit-message",
      "done: {{task}}",
      "--on-complete",
      "node scripts/after.js",
      "--on-fail",
      "node scripts/handle-fail.js",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.commitAfterComplete).toBe(true);
    expect(call.commitMode).toBe("per-task");
    expect(call.commitMessageTemplate).toBe("done: {{task}}");
    expect(call.onCompleteCommand).toBe("node scripts/after.js");
    expect(call.onFailCommand).toBe("node scripts/handle-fail.js");
  });

  it("passes explicit file-done commit mode for run --all", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--all",
      "--commit-mode",
      "file-done",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.commitMode).toBe("file-done");
    expect(call.runAll).toBe(true);
  });

  it("accepts file-done commit mode with --redo implicit-all", async () => {
    const runTask = vi.fn(async () => 0);
    const redoCall = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--redo",
      "--commit-mode",
      "file-done",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(redoCall.commitMode).toBe("file-done");
    expect(redoCall.redo).toBe(true);
  });

  it("accepts file-done commit mode with --clean implicit-all", async () => {
    const runTask = vi.fn(async () => 0);
    const cleanCall = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--clean",
      "--commit-mode",
      "file-done",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(cleanCall.commitMode).toBe("file-done");
    expect(cleanCall.clean).toBe(true);
  });

  it("passes --all flag to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--all",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.runAll).toBe(true);
  });

  it("defaults reset flags to false when omitted", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.redo).toBe(false);
    expect(call.resetAfter).toBe(false);
    expect(call.clean).toBe(false);
    expect(call.rounds).toBe(1);
  });

  it("passes explicit --rounds value to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--clean",
      "--rounds",
      "3",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.rounds).toBe(3);
  });

  it("logs a CLI error and exits when --rounds is used without clean reset flags", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--rounds",
      "2",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--rounds requires --clean or both --redo and --reset-after"));
  });

  it("logs a CLI error and exits when --rounds is used with only --redo", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--redo",
      "--rounds",
      "2",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--rounds requires --clean or both --redo and --reset-after"));
  });

  it("logs a CLI error and exits when --rounds is used with only --reset-after", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--reset-after",
      "--rounds",
      "2",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--rounds requires --clean or both --redo and --reset-after"));
  });

  it("accepts --rounds when combined with --redo and --reset-after", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--redo",
      "--reset-after",
      "--rounds",
      "2",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.redo).toBe(true);
    expect(call.resetAfter).toBe(true);
    expect(call.rounds).toBe(2);
  });

  it("parses --redo flag without enabling reset-after", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--redo",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.redo).toBe(true);
    expect(call.resetAfter).toBe(false);
    expect(call.clean).toBe(false);
  });

  it("parses --reset-after flag without enabling redo", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--reset-after",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.redo).toBe(false);
    expect(call.resetAfter).toBe(true);
    expect(call.clean).toBe(false);
  });

  it("passes reset flags to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--redo",
      "--reset-after",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.redo).toBe(true);
    expect(call.resetAfter).toBe(true);
    expect(call.clean).toBe(false);
  });

  it("expands --clean into redo and reset-after", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--clean",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.clean).toBe(true);
    expect(call.redo).toBe(true);
    expect(call.resetAfter).toBe(true);
  });

  it("shows reset options in run help text", async () => {
    const runTask = vi.fn(async () => 0);
    const result = await invokeRunAndCaptureHelpOutput([
      "run",
      "--help",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();

    const compactHelpOutput = stripAnsi(result.output).replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--redo Reset all checkboxes in the source file before running");
    expect(compactHelpOutput).toContain("--reset-after Reset all checkboxes in the source file after the run completes");
    expect(compactHelpOutput).toContain("--clean Shorthand for --redo --reset-after");
    expect(compactHelpOutput).toContain("--rounds <n> Repeat clean cycles N times (default: 1)");
    expect(compactHelpOutput).toContain("--force-attempts <n> Default outer retry attempts for force:-prefixed tasks");
    expect(compactHelpOutput).toContain("--quiet Suppress info-level output");
  });

  it("expands --revertable into commit and keep-artifacts", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--revertable",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.commitAfterComplete).toBe(true);
    expect(call.keepArtifacts).toBe(true);
  });

  it("shows --revertable in run help text", async () => {
    const runTask = vi.fn(async () => 0);
    const result = await invokeRunAndCaptureHelpOutput([
      "run",
      "--help",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();

    const compactHelpOutput = stripAnsi(result.output).replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--revertable Shorthand for --commit --keep-artifacts");
  });

  it("logs a CLI error and exits with code 1 on zero --rounds", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--clean",
      "--rounds",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --rounds value: 0"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Must be a positive integer"));
  });

  it("logs a CLI error and exits with code 1 on negative --rounds", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--clean",
      "--rounds",
      "-1",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --rounds value: -1"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Must be a positive integer"));
  });

  it("logs a CLI error and exits with code 1 on non-integer --rounds", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--clean",
      "--rounds",
      "abc",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --rounds value: abc"));
  });

  it("supports all as a first-class run-all command", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "all",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.source).toBe("tasks.md");
    expect(call.runAll).toBe(true);
  });

  it("registers materialize in root help with run-equivalent description", async () => {
    const runTask = vi.fn(async () => 0);
    const result = await invokeRunAndCaptureHelpOutput([
      "--help",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();

    const compactHelpOutput = stripAnsi(result.output).replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("materialize [options] <source>");
    expect(compactHelpOutput).toContain("Run all tasks with revertable defaults (equivalent to `run --all --revertable`).");
  });

  it("expands materialize alias to run --all --revertable", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "materialize",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.source).toBe("tasks.md");
    expect(call.runAll).toBe(true);
    expect(call.commitAfterComplete).toBe(true);
    expect(call.keepArtifacts).toBe(true);
  });

  it("parses run-like options for materialize while forwarding separator worker command", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "materialize",
      "tasks.md",
      "--mode",
      "wait",
      "--sort",
      "old-first",
      "--no-verify",
      "--repair-attempts",
      "2",
      "--resolve-repair-attempts",
      "3",
      "--trace",
      "--show-agent-output",
      "--",
      "opencode",
      "run",
      "--model",
      "gpt-5.3-codex",
    ], runTask);

    expect(call.source).toBe("tasks.md");
    expect(call.mode).toBe("wait");
    expect(call.sortMode).toBe("old-first");
    expect(call.verify).toBe(false);
    expect(call.repairAttempts).toBe(2);
    expect(call.resolveRepairAttempts).toBe(3);
    expect(call.trace).toBe(true);
    expect(call.showAgentOutput).toBe(true);
    expect(call.workerCommand).toEqual(["opencode", "run", "--model", "gpt-5.3-codex"]);
    expect(call.runAll).toBe(true);
    expect(call.commitAfterComplete).toBe(true);
    expect(call.keepArtifacts).toBe(true);
  });

  it("accepts separator-passed worker commands for materialize", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "materialize",
      "tasks.md",
      "--",
      "opencode",
      "run",
      "--model",
      "gpt-5.3-codex",
    ], runTask);

    expect(call.source).toBe("tasks.md");
    expect(call.workerCommand).toEqual(["opencode", "run", "--model", "gpt-5.3-codex"]);
    expect(call.runAll).toBe(true);
    expect(call.commitAfterComplete).toBe(true);
    expect(call.keepArtifacts).toBe(true);
  });

  it("keeps materialize revertable defaults with --config-dir and separator worker args", async () => {
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-materialize-cli-"));
    const configDir = path.join(tempRoot, ".rundown");

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
      run: {
        revertable: false,
        commit: false,
      },
    }, null, 2) + "\n", "utf-8");

    try {
      const call = await invokeRunAndCaptureCall([
        "--config-dir",
        configDir,
        "materialize",
        "tasks.md",
        "--",
        "opencode",
        "run",
      ], runTask);

      expect(call.source).toBe("tasks.md");
      expect(call.workerCommand).toEqual(["opencode", "run"]);
      expect(call.runAll).toBe(true);
      expect(call.commitAfterComplete).toBe(true);
      expect(call.keepArtifacts).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("materialize preserves forced all+revertable defaults while honoring explicit commit CLI overrides", async () => {
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-materialize-precedence-"));
    const configDir = path.join(tempRoot, ".rundown");

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
      run: {
        revertable: false,
        commit: false,
        commitMessage: "cfg: {{task}}",
        commitMode: "file-done",
      },
    }, null, 2) + "\n", "utf-8");

    try {
      const call = await invokeRunAndCaptureCall([
        "--config-dir",
        configDir,
        "materialize",
        "tasks.md",
        "--commit-mode",
        "per-task",
        "--commit-message",
        "cli: {{task}}",
        "--worker",
        "opencode",
        "run",
      ], runTask);

      expect(call.source).toBe("tasks.md");
      expect(call.runAll).toBe(true);
      expect(call.keepArtifacts).toBe(true);
      expect(call.commitAfterComplete).toBe(true);
      expect(call.commitMode).toBe("per-task");
      expect(call.commitMessageTemplate).toBe("cli: {{task}}");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("shows run-like options in materialize help text", async () => {
    const runTask = vi.fn(async () => 0);
    const result = await invokeRunAndCaptureHelpOutput([
      "materialize",
      "--help",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();

    const compactHelpOutput = stripAnsi(result.output).replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--verify Run verification after task execution (default)");
    expect(compactHelpOutput).toContain("--mode <mode> Runner execution mode: wait, tui, detached");
    expect(compactHelpOutput).toContain("--worker <pattern> Optional worker pattern override (alternative to -- <command>)");
    expect(compactHelpOutput).toContain("--revertable Shorthand for --commit --keep-artifacts");
  });

  it("shows skip-research make options in help text", async () => {
    const runTask = vi.fn(async () => 0);
    const result = await invokeRunAndCaptureHelpOutput([
      "make",
      "--help",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();

    const compactHelpOutput = stripAnsi(result.output).replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--skip-research, --raw Skip phase 1 research and start from planning");
    expect(compactHelpOutput).toContain("--mode <mode> Make mode: wait");
  });

  it("shows add plan-only options in help text", async () => {
    const runTask = vi.fn(async () => 0);
    const result = await invokeRunAndCaptureHelpOutput([
      "add",
      "--help",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();

    const compactHelpOutput = stripAnsi(result.output).replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--mode <mode> Add mode: wait");
    expect(compactHelpOutput).toContain("--scan-count <n> Max clean-session TODO coverage scans for the plan phase");
    expect(compactHelpOutput).toContain("--deep <n> Additional nested planning depth passes after top-level scans for the plan phase");
    expect(compactHelpOutput).toContain("--worker <pattern> Optional worker pattern override (alternative to -- <command>)");
  });

  it("parses all with --worker echo and enables runAll", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "all",
      "tasks.md",
      "--worker",
      "echo",
    ], runTask);

    expect(call.source).toBe("tasks.md");
    expect(call.workerCommand).toEqual(["echo"]);
    expect(call.runAll).toBe(true);
  });

  it("accepts run options when using all alias", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "all",
      "tasks.md",
      "--verify",
      "--keep-artifacts",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.source).toBe("tasks.md");
    expect(call.verify).toBe(true);
    expect(call.keepArtifacts).toBe(true);
    expect(call.runAll).toBe(true);
  });

  it("accepts file-done commit mode when using all alias", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "all",
      "tasks.md",
      "--commit-mode",
      "file-done",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.commitMode).toBe("file-done");
    expect(call.runAll).toBe(true);
  });

  it("call enforces clean all-task execution with CLI block caching", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "call",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.source).toBe("tasks.md");
    expect(call.clean).toBe(true);
    expect(call.redo).toBe(true);
    expect(call.resetAfter).toBe(true);
    expect(call.runAll).toBe(true);
    expect(call.cacheCliBlocks).toBe(true);
  });

  it("loop enforces call semantics for each iteration", async () => {
    const runTask = vi.fn(async () => 0);
    const calls = await invokeLoopAndCaptureRunCalls([
      "loop",
      "tasks.md",
      "--iterations",
      "1",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      source: "tasks.md",
      clean: true,
      redo: true,
      resetAfter: true,
      runAll: true,
      cacheCliBlocks: true,
    });
  });

  it("loop runs bounded iterations", async () => {
    const runTask = vi.fn(async () => 0);
    const calls = await invokeLoopAndCaptureRunCalls([
      "loop",
      "tasks.md",
      "--iterations",
      "3",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(calls).toHaveLength(3);
  });

  it("loop forwards --commit options to each iteration", async () => {
    const runTask = vi.fn(async () => 0);
    const calls = await invokeLoopAndCaptureRunCalls([
      "loop",
      "tasks.md",
      "--iterations",
      "2",
      "--cooldown",
      "0",
      "--commit",
      "--commit-message",
      "loop: {{task}}",
      "--commit-mode",
      "file-done",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({
        commitAfterComplete: true,
        commitMessageTemplate: "loop: {{task}}",
        commitMode: "file-done",
        runAll: true,
      });
    }
  });

  it("loop releases held locks after each iteration before cooldown", async () => {
    const runTask = vi.fn(async () => 0);
    const releaseAllLocks = vi.fn();
    const result = await invokeLoopAndCaptureRunCallsAndLockReleaseCount([
      "loop",
      "tasks.md",
      "--iterations",
      "2",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask, releaseAllLocks);

    expect(result.calls).toHaveLength(2);
    expect(releaseAllLocks).toHaveBeenCalledTimes(2);
  });

  it("loop still releases locks when an iteration throws", async () => {
    const runTask = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockRejectedValueOnce(new Error("boom"));
    const releaseAllLocks = vi.fn();
    const exitCode = await invokeLoopAndCaptureExitCodeWithLockRelease([
      "loop",
      "tasks.md",
      "--iterations",
      "3",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask, releaseAllLocks);

    expect(exitCode).toBe(1);
    expect(releaseAllLocks).toHaveBeenCalledTimes(2);
  });

  it("loop emits iteration start and completion status messages", async () => {
    const runTask = vi.fn(async () => 0);
    const events = await invokeLoopAndCaptureOutputEvents([
      "loop",
      "tasks.md",
      "--iterations",
      "2",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    const infoMessages = events
      .filter((event) => event.kind === "info")
      .map((event) => event.message);

    expect(infoMessages).toContain("Loop iteration 1 starting...");
    expect(infoMessages).toContain("Loop iteration 1 completed - starting next iteration immediately.");
    expect(infoMessages).toContain("Loop iteration 2 starting...");
    expect(infoMessages).toContain("Loop iteration 2 completed - reached iteration limit; stopping.");
  });

  it("loop emits a final summary for bounded successful iterations", async () => {
    const runTask = vi.fn(async () => 0);
    const events = await invokeLoopAndCaptureOutputEvents([
      "loop",
      "tasks.md",
      "--iterations",
      "2",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    const infoMessages = events
      .filter((event) => event.kind === "info")
      .map((event) => event.message);

    expect(infoMessages).toContain("Loop summary: total iterations=2, succeeded=2, failed=0.");
  });

  it("loop emits cooldown status with remaining time", async () => {
    const runTask = vi.fn(async () => 0);
    const cancellableSleep = vi.fn(() => ({
      promise: Promise.resolve(),
      cancel: () => {},
    }));

    vi.doMock("../../src/infrastructure/cancellable-sleep.js", () => ({
      cancellableSleep,
    }));

    const events = await invokeLoopAndCaptureOutputEvents([
      "loop",
      "tasks.md",
      "--iterations",
      "2",
      "--cooldown",
      "2",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    const infoMessages = events
      .filter((event) => event.kind === "info")
      .map((event) => event.message);

    expect(infoMessages).toContain("Loop cooldown: 2s remaining before iteration 2.");
    expect(infoMessages).toContain("Loop cooldown: 1s remaining before iteration 2.");
    expect(cancellableSleep).toHaveBeenCalledTimes(2);
    expect(cancellableSleep).toHaveBeenNthCalledWith(1, 1000);
    expect(cancellableSleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it("loop exits with code 0 on SIGINT during cooldown", async () => {
    const runTask = vi.fn(async () => 0);
    const cancellableSleep = vi.fn(() => {
      process.emit("SIGINT");
      return {
        promise: Promise.resolve(),
        cancel: () => {},
      };
    });

    vi.doMock("../../src/infrastructure/cancellable-sleep.js", () => ({
      cancellableSleep,
    }));

    const exitCode = await invokeRunAndCaptureExitCode([
      "loop",
      "tasks.md",
      "--cooldown",
      "5",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(exitCode).toBe(0);
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it("loop rejects interactive --mode values such as tui before first iteration", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const exitCode = await invokeRunAndCaptureExitCode([
        "loop",
        "tasks.md",
        "--mode",
        "tui",
        "--iterations",
        "1",
        "--cooldown",
        "0",
        "--worker",
        "opencode",
        "run",
      ], runTask);

      expect(exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --mode value: tui"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Allowed: wait"));
      expect(runTask).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("logs a CLI error and exits with code 1 on zero --time-limit", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "loop",
      "tasks.md",
      "--time-limit",
      "0",
      "--iterations",
      "1",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --time-limit value: 0"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Must be a positive integer"));
  });

  it("logs a CLI error and exits with code 1 on negative --time-limit", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "loop",
      "tasks.md",
      "--time-limit",
      "-1",
      "--iterations",
      "1",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --time-limit value: -1"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Must be a positive integer"));
  });

  it("logs a CLI error and exits with code 1 on non-integer --time-limit", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "loop",
      "tasks.md",
      "--time-limit",
      "abc",
      "--iterations",
      "1",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --time-limit value: abc"));
  });

  it("loop stops on failed iteration by default", async () => {
    const runTask = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);

    const exitCode = await invokeRunAndCaptureExitCode([
      "loop",
      "tasks.md",
      "--iterations",
      "3",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).toHaveBeenCalledTimes(2);
    expect(exitCode).toBe(2);
  });

  it("loop propagates execution failure exit code when stopping on error", async () => {
    const runTask = vi.fn<() => Promise<number>>().mockResolvedValueOnce(1);

    const exitCode = await invokeRunAndCaptureExitCode([
      "loop",
      "tasks.md",
      "--iterations",
      "3",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(exitCode).toBe(1);
  });

  it("loop continues after failures with --continue-on-error", async () => {
    const runTask = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);

    const exitCode = await invokeRunAndCaptureExitCode([
      "loop",
      "tasks.md",
      "--iterations",
      "2",
      "--cooldown",
      "0",
      "--continue-on-error",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).toHaveBeenCalledTimes(2);
    expect(exitCode).toBe(0);
  });

  it("loop emits a final summary when stopping on failure", async () => {
    const runTask = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);

    const events = await invokeLoopAndCaptureOutputEvents([
      "loop",
      "tasks.md",
      "--iterations",
      "3",
      "--cooldown",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    const infoMessages = events
      .filter((event) => event.kind === "info")
      .map((event) => event.message);

    expect(infoMessages).toContain("Loop summary: total iterations=2, succeeded=1, failed=1.");
  });

  it("loop emits a final summary with failures when continuing on error", async () => {
    const runTask = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(0);

    const events = await invokeLoopAndCaptureOutputEvents([
      "loop",
      "tasks.md",
      "--iterations",
      "2",
      "--cooldown",
      "0",
      "--continue-on-error",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    const infoMessages = events
      .filter((event) => event.kind === "info")
      .map((event) => event.message);

    expect(infoMessages).toContain("Loop summary: total iterations=2, succeeded=1, failed=1.");
  });

  it("passes force-execute option to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--force-execute",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.forceExecute).toBe(true);
  });

  it("passes force-attempts option to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--force-attempts",
      "4",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.forceAttempts).toBe(4);
  });

  it("defaults force-attempts to 2 when omitted", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.forceAttempts).toBe(2);
  });

  it("passes force-unlock option to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--force-unlock",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.forceUnlock).toBe(true);
  });

  it("defaults cli-block-timeout to 30000ms", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.cliBlockTimeoutMs).toBe(30_000);
  });

  it("passes explicit cli-block-timeout to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--cli-block-timeout",
      "1234",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.cliBlockTimeoutMs).toBe(1234);
  });

  it("accepts cli-block-timeout of 0 to disable timeout", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--cli-block-timeout",
      "0",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.cliBlockTimeoutMs).toBe(0);
  });

  it("logs a CLI error and exits with code 1 on invalid cli-block-timeout", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--cli-block-timeout",
      "abc",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --cli-block-timeout value: abc"));
  });

  it("preserves an explicit verify flag", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--verify",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.verify).toBe(true);
  });

  it("accepts worker commands passed after the separator", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--",
      "opencode",
      "run",
    ], runTask);

    expect(call.workerCommand).toEqual(["opencode", "run"]);
  });

  it("passes trace option to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--trace",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.trace).toBe(true);
  });

  it("passes trace-only option to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--trace-only",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.traceOnly).toBe(true);
  });

  it("passes trace-stats option to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--trace-stats",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.traceStats).toBe(true);
  });

  it("collects repeated template vars", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--var",
      "env=prod",
      "--var",
      "owner=ops",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.cliTemplateVarArgs).toEqual(["env=prod", "owner=ops"]);
  });

  it("normalizes discuss defaults", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.source).toBe("tasks.md");
    expect(call.runId).toBeUndefined();
    expect(call.mode).toBe("tui");
    expect(call.sortMode).toBe("name-sort");
    expect(call.dryRun).toBe(false);
    expect(call.printPrompt).toBe(false);
    expect(call.keepArtifacts).toBe(false);
    expect(call.varsFileOption).toBeUndefined();
    expect(call.cliTemplateVarArgs).toEqual([]);
    expect(call.workerCommand).toEqual(["opencode", "run"]);
    expect(call.showAgentOutput).toBe(false);
    expect(call.trace).toBe(false);
    expect(call.forceUnlock).toBe(false);
    expect(call.ignoreCliBlock).toBe(false);
    expect(call.cliBlockTimeoutMs).toBe(30_000);
  });

  it("passes --run option to discuss task", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--run",
      "latest",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.runId).toBe("latest");
  });

  it("parses --run with a full run id for discuss", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--run",
      "run-20260406T221109164Z-42f68dae",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.source).toBe("tasks.md");
    expect(call.runId).toBe("run-20260406T221109164Z-42f68dae");
  });

  it("parses --run with a prefix for discuss", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--run",
      "run-20260406T2211",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.source).toBe("tasks.md");
    expect(call.runId).toBe("run-20260406T2211");
  });

  it("keeps <source> when discuss is combined with --run", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--run",
      "latest",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.source).toBe("tasks.md");
    expect(call.runId).toBe("latest");
  });

  it("allows discuss without <source> when --run is provided", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "--run",
      "latest",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.source).toBe("");
    expect(call.runId).toBe("latest");
  });

  it("logs a CLI error and exits when discuss --run is provided without a value", async () => {
    const discussTask = vi.fn(async () => 0);
    let stderr = "";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as never);

    try {
      await invokeDiscussAndExpectExit([
        "discuss",
        "tasks.md",
        "--run",
      ], discussTask);
    } finally {
      stderrSpy.mockRestore();
    }

    expect(discussTask).not.toHaveBeenCalled();
    expect(stderr).toContain("option '--run <id|prefix|latest>' argument missing");
  });

  it("passes explicit --cli-block-timeout to discuss task", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--cli-block-timeout",
      "1234",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.cliBlockTimeoutMs).toBe(1234);
  });

  it("passes --ignore-cli-block flag to discuss task", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--ignore-cli-block",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.ignoreCliBlock).toBe(true);
  });

  it("collects discuss template vars and flags", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--vars-file",
      "custom-vars.json",
      "--var",
      "env=prod",
      "--var",
      "owner=ops",
      "--dry-run",
      "--show-agent-output",
      "--trace",
      "--force-unlock",
      "--worker",
      "opencode",
      "run",
    ], discussTask);

    expect(call.varsFileOption).toBe("custom-vars.json");
    expect(call.cliTemplateVarArgs).toEqual(["env=prod", "owner=ops"]);
    expect(call.dryRun).toBe(true);
    expect(call.showAgentOutput).toBe(true);
    expect(call.trace).toBe(true);
    expect(call.forceUnlock).toBe(true);
  });

  it("passes explicit discuss execution options", async () => {
    const discussTask = vi.fn(async () => 0);
    const call = await invokeDiscussAndCaptureCall([
      "discuss",
      "tasks.md",
      "--mode",
      "wait",
      "--sort",
      "old-first",
      "--print-prompt",
      "--keep-artifacts",
      "--",
      "opencode",
      "run",
    ], discussTask);

    expect(call.mode).toBe("wait");
    expect(call.sortMode).toBe("old-first");
    expect(call.printPrompt).toBe(true);
    expect(call.keepArtifacts).toBe(true);
    expect(call.workerCommand).toEqual(["opencode", "run"]);
  });

  it("accepts an explicit --config-dir when it exists and is a directory", async () => {
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-cli-config-dir-"));
    const configDir = path.join(tempRoot, ".rundown-custom");
    fs.mkdirSync(configDir, { recursive: true });

    try {
      const call = await invokeRunAndCaptureCall([
        "--config-dir",
        configDir,
        "run",
        "tasks.md",
        "--worker",
        "opencode",
        "run",
      ], runTask);

      expect(call.source).toBe("tasks.md");
      expect(call.workerCommand).toEqual(["opencode", "run"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("logs a CLI error and exits with code 1 when --config-dir does not exist", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const missingPath = path.join(os.tmpdir(), `rundown-missing-config-dir-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const exitCode = await invokeRunAndCaptureExitCode([
      "--config-dir",
      missingPath,
      "run",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(exitCode).toBe(1);
    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --config-dir value"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Directory does not exist"));
  });

  it("logs a CLI error and exits when --config-dir is not a directory", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-cli-config-file-"));
    const configFile = path.join(tempRoot, "not-a-directory.txt");
    fs.writeFileSync(configFile, "x", "utf8");

    try {
      await invokeRunAndExpectExit([
        "--config-dir",
        configFile,
        "run",
        "tasks.md",
        "--worker",
        "opencode",
        "run",
      ], runTask);

      expect(runTask).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --config-dir value"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Path is not a directory"));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses explicit --config-dir verbatim and skips discovery", async () => {
    const runTask = vi.fn(async () => 0);
    const createApp = vi.fn(() => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }));
    const resolve = vi.fn(() => ({
      configDir: "/should-not-be-used/.rundown",
      isExplicit: false,
    }));
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-cli-explicit-config-dir-"));
    const configDir = path.join(tempRoot, ".rundown-custom");
    fs.mkdirSync(configDir, { recursive: true });
    const previousEnv = captureEnv();

    process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
    process.env.RUNDOWN_TEST_MODE = "1";

    vi.doMock("../../src/create-app.js", () => ({ createApp }));
    vi.doMock("../../src/infrastructure/adapters/config-dir-adapter.js", () => ({
      createConfigDirAdapter: () => ({ resolve }),
    }));

    try {
      const { parseCliArgs } = await import("../../src/presentation/cli.js");
      await parseCliArgs([
        "--config-dir",
        configDir,
        "run",
        "tasks.md",
        "--worker",
        "opencode run",
      ]);
    } catch (error) {
      const message = String(error);
      if (!/CLI exited with code \d+/.test(message)) {
        throw error;
      }
    } finally {
      restoreEnv(previousEnv);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }

    expect(resolve).not.toHaveBeenCalled();
    expect(createApp).toHaveBeenCalledWith(expect.objectContaining({
      ports: expect.objectContaining({
        configDir: {
          configDir,
          isExplicit: true,
        },
      }),
    }));
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it("prefers linked-workspace config-dir discovery when workspace.link resolves", async () => {
    const runTask = vi.fn(async () => 0);
    const createApp = vi.fn(() => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }));
    const invocationDir = process.cwd();
    const linkedWorkspaceRoot = path.join(invocationDir, "linked-workspace-root");
    const linkedConfigDir = path.join(linkedWorkspaceRoot, ".rundown");
    const resolve = vi.fn((candidateDir: string) => {
      if (candidateDir === linkedWorkspaceRoot) {
        return {
          configDir: linkedConfigDir,
          isExplicit: false,
        };
      }

      if (candidateDir === invocationDir) {
        return {
          configDir: path.join(invocationDir, ".rundown"),
          isExplicit: false,
        };
      }

      return undefined;
    });
    const previousEnv = captureEnv();

    process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
    process.env.RUNDOWN_TEST_MODE = "1";

    vi.doMock("../../src/create-app.js", () => ({ createApp }));
    vi.doMock("../../src/domain/workspace-link.js", () => ({
      resolveWorkspaceLink: () => ({
        status: "resolved",
        linkPath: path.join(invocationDir, ".rundown", "workspace.link"),
        relativeTarget: "../linked-workspace-root",
        workspaceRoot: linkedWorkspaceRoot,
      }),
    }));
    vi.doMock("../../src/infrastructure/adapters/config-dir-adapter.js", () => ({
      createConfigDirAdapter: () => ({ resolve }),
    }));

    try {
      const { parseCliArgs } = await import("../../src/presentation/cli.js");
      await parseCliArgs([
        "run",
        "tasks.md",
        "--worker",
        "opencode run",
      ]);
    } catch (error) {
      const message = String(error);
      if (!/CLI exited with code \d+/.test(message)) {
        throw error;
      }
    } finally {
      restoreEnv(previousEnv);
    }

    expect(resolve).toHaveBeenCalledWith(linkedWorkspaceRoot);
    expect(resolve).not.toHaveBeenCalledWith(invocationDir);
    expect(createApp).toHaveBeenCalledWith(expect.objectContaining({
      ports: expect.objectContaining({
        configDir: {
          configDir: linkedConfigDir,
          isExplicit: false,
        },
      }),
    }));
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it("falls back to invocation config-dir discovery when linked workspace has no config", async () => {
    const runTask = vi.fn(async () => 0);
    const createApp = vi.fn(() => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }));
    const invocationDir = process.cwd();
    const linkedWorkspaceRoot = path.join(invocationDir, "linked-workspace-root");
    const invocationConfigDir = path.join(invocationDir, ".rundown");
    const resolve = vi.fn((candidateDir: string) => {
      if (candidateDir === linkedWorkspaceRoot) {
        return undefined;
      }

      if (candidateDir === invocationDir) {
        return {
          configDir: invocationConfigDir,
          isExplicit: false,
        };
      }

      return undefined;
    });
    const previousEnv = captureEnv();

    process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
    process.env.RUNDOWN_TEST_MODE = "1";

    vi.doMock("../../src/create-app.js", () => ({ createApp }));
    vi.doMock("../../src/domain/workspace-link.js", () => ({
      resolveWorkspaceLink: () => ({
        status: "resolved",
        linkPath: path.join(invocationDir, ".rundown", "workspace.link"),
        relativeTarget: "../linked-workspace-root",
        workspaceRoot: linkedWorkspaceRoot,
      }),
    }));
    vi.doMock("../../src/infrastructure/adapters/config-dir-adapter.js", () => ({
      createConfigDirAdapter: () => ({ resolve }),
    }));

    try {
      const { parseCliArgs } = await import("../../src/presentation/cli.js");
      await parseCliArgs([
        "run",
        "tasks.md",
        "--worker",
        "opencode run",
      ]);
    } catch (error) {
      const message = String(error);
      if (!/CLI exited with code \d+/.test(message)) {
        throw error;
      }
    } finally {
      restoreEnv(previousEnv);
    }

    expect(resolve).toHaveBeenNthCalledWith(1, linkedWorkspaceRoot);
    expect(resolve).toHaveBeenNthCalledWith(2, invocationDir);
    expect(createApp).toHaveBeenCalledWith(expect.objectContaining({
      ports: expect.objectContaining({
        configDir: {
          configDir: invocationConfigDir,
          isExplicit: false,
        },
      }),
    }));
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it("logs a CLI error and exits with code 1 on invalid mode", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--mode",
      "bad-mode",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --mode value: bad-mode"));
  });

  it("appends CLI fatal fallback errors to the global output log", async () => {
    const runTask = vi.fn(async () => 0);
    const writeSpy = vi.fn();

    await invokeRunAndExpectExitWithGlobalLogCapture([
      "run",
      "tasks.md",
      "--mode",
      "bad-mode",
      "--worker",
      "opencode run",
    ], runTask, writeSpy);

    expect(writeSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      stream: "stderr",
      kind: "cli-fatal",
      message: expect.stringContaining("Invalid --mode value: bad-mode"),
      command: "run",
      argv: [
        "run",
        "tasks.md",
        "--mode",
        "bad-mode",
        "--worker",
        "opencode run",
      ],
      cwd: process.cwd(),
      pid: process.pid,
      version: expect.any(String),
      session_id: expect.any(String),
      ts: expect.any(String),
    }));
  });

  it("appends Commander framework stderr output to the global output log", async () => {
    const runTask = vi.fn(async () => 0);
    const writeSpy = vi.fn();

    await invokeRunAndExpectExitWithGlobalLogCapture([
      "run",
      "tasks.md",
      "--unknown-flag",
      "--worker",
      "opencode run",
    ], runTask, writeSpy);

    expect(runTask).not.toHaveBeenCalled();
    expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      stream: "stderr",
      kind: "commander",
      message: expect.stringContaining("unknown option"),
      command: "run",
      argv: [
        "run",
        "tasks.md",
        "--unknown-flag",
        "--worker",
        "opencode run",
      ],
      cwd: process.cwd(),
      pid: process.pid,
      version: expect.any(String),
      session_id: expect.any(String),
      ts: expect.any(String),
    }));
  });

  it("logs a CLI error and exits with code 1 on invalid sort", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--sort",
      "created",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --sort value: created"));
  });
});

describe("CLI reverify option normalization", () => {
  it("keeps repair enabled by default when --no-repair is omitted", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.noRepair).toBe(false);
    expect(call.repairAttempts).toBe(1);
    expect(call.resolveRepairAttempts).toBe(1);
  });

  it("passes reverify options to application layer", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--run",
      "run-123",
      "--repair-attempts",
      "2",
      "--resolve-repair-attempts",
      "3",
      "--no-repair",
      "--dry-run",
      "--print-prompt",
      "--keep-artifacts",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.runId).toBe("run-123");
    expect(call.last).toBeUndefined();
    expect(call.all).toBe(false);
    expect(call.oldestFirst).toBe(false);
    expect(call.repairAttempts).toBe(2);
    expect(call.resolveRepairAttempts).toBe(3);
    expect(call.noRepair).toBe(true);
    expect(call.dryRun).toBe(true);
    expect(call.printPrompt).toBe(true);
    expect(call.keepArtifacts).toBe(true);
    expect(call.workerCommand).toEqual(["opencode", "run"]);
    expect(call.ignoreCliBlock).toBe(false);
    expect(call.cliBlockTimeoutMs).toBe(30_000);
  });

  it("passes explicit --cli-block-timeout to reverify task", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--cli-block-timeout",
      "1234",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.cliBlockTimeoutMs).toBe(1234);
  });

  it("passes --ignore-cli-block flag to reverify task", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--ignore-cli-block",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.ignoreCliBlock).toBe(true);
  });

  it("accepts reverify worker commands passed after the separator", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.workerCommand).toEqual(["opencode", "run"]);
  });

  it("accepts worker flags after --worker for reverify", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--worker",
      "claude",
      "-p",
    ], reverifyTask);

    expect(call.workerCommand).toEqual(["claude", "-p"]);
  });

  it("passes trace option to reverify task", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--trace",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.trace).toBe(true);
  });

  it("passes --show-agent-output option to reverify task", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--show-agent-output",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.showAgentOutput).toBe(true);
  });

  it("parses --last value for reverify", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--last",
      "3",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.last).toBe(3);
    expect(call.all).toBe(false);
  });

  it("parses --all flag for reverify", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--all",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.all).toBe(true);
    expect(call.last).toBeUndefined();
  });

  it("logs a CLI error and exits with code 1 on non-integer --last", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeReverifyAndExpectExit([
      "reverify",
      "--last",
      "three",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(reverifyTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --last value: three"));
  });

  it("logs a CLI error and exits with code 1 on invalid repair attempts", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeReverifyAndExpectExit([
      "reverify",
      "--repair-attempts",
      "two",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(reverifyTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --repair-attempts value: two"));
  });

  it("logs a CLI error and exits with code 1 on invalid resolve repair attempts", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeReverifyAndExpectExit([
      "reverify",
      "--resolve-repair-attempts",
      "two",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(reverifyTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --resolve-repair-attempts value: two"));
  });

  it("logs a CLI error and exits with code 1 on invalid force-attempts", async () => {
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRunAndExpectExit([
      "run",
      "tasks.md",
      "--force-attempts",
      "bad",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(runTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --force-attempts value: bad"));
  });

  it("logs a CLI error and exits with code 1 on unsafe repair attempts", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeReverifyAndExpectExit([
      "reverify",
      "--repair-attempts",
      "9007199254740993",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(reverifyTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Must be a safe non-negative integer"));
  });

  it("uses process.exit outside CLI test mode", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const previousEnv = captureEnv();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as never);

    process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
    delete process.env.RUNDOWN_TEST_MODE;

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: vi.fn(async () => 0),
        reverifyTask,
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
      }),
    }));

    try {
      const { parseCliArgs } = await import("../../src/presentation/cli.js");
      await expect(parseCliArgs(["reverify", "--worker", "opencode run"]))
        .rejects.toThrow("process.exit:1");
    } finally {
      restoreEnv(previousEnv);
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(reverifyTask).toHaveBeenCalledTimes(1);
  });

  it("auto-parses argv on import when not disabled", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const previousEnv = captureEnv();
    const previousArgv = process.argv;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      void code;
      return undefined as never;
    }) as never);

    delete process.env.RUNDOWN_DISABLE_AUTO_PARSE;
    process.env.RUNDOWN_TEST_MODE = "1";
    process.argv = ["node", "rundown", "reverify", "--worker", "opencode", "run"];

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: vi.fn(async () => 0),
        reverifyTask,
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
      }),
    }));

    try {
      await import("../../src/presentation/cli.js");
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      restoreEnv(previousEnv);
      process.argv = previousArgv;
      errorSpy.mockRestore();
      exitSpy.mockRestore();
    }

    expect(reverifyTask).toHaveBeenCalledTimes(1);
  });

});

describe("CLI invocation logging context", () => {
  it("sets command name to the selected top-level command", async () => {
    const context = await invokeCliAndCaptureLoggedContext([
      "run",
      "tasks.md",
      "--worker",
      "opencode run",
    ]);

    expect(context.command).toBe("run");
  });

  it("captures full argv including separator worker command", async () => {
    const args = [
      "run",
      "tasks.md",
      "--",
      "opencode",
      "run",
      "--json",
    ];
    const context = await invokeCliAndCaptureLoggedContext(args);

    expect(context.argv).toEqual(args);
  });

  it("falls back to rundown command when no subcommand is provided", async () => {
    const context = await invokeCliAndCaptureLoggedContext(["--help"]);

    expect(context.command).toBe("rundown");
  });

  it("records all command in invocation context", async () => {
    const context = await invokeCliAndCaptureLoggedContext(["all", "tasks.md", "--worker", "opencode run"]);

    expect(context.command).toBe("all");
    expect(context.argv).toEqual(["all", "tasks.md", "--worker", "opencode run"]);
  });
});

describe("CLI lock release signal handling", () => {
  it("registers SIGINT and SIGTERM handlers that release held locks before exit", async () => {
    const previousEnv = captureEnv();
    process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
    process.env.RUNDOWN_TEST_MODE = "1";

    const releaseAllLocks = vi.fn();

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: vi.fn(async () => 0),
        reverifyTask: vi.fn(async () => 0),
        revertTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
        releaseAllLocks,
      }),
    }));

    try {
      const { parseCliArgs } = await import("../../src/presentation/cli.js");
      await expect(parseCliArgs(["init"]))
        .rejects.toThrow("CLI exited with code 0");
    } finally {
      restoreEnv(previousEnv);
    }

    const sigintHandler = process
      .listeners("SIGINT")
      .find((listener) => (listener as { __rundownLockReleaseSignalHandler?: boolean }).__rundownLockReleaseSignalHandler === true);
    const sigtermHandler = process
      .listeners("SIGTERM")
      .find((listener) => (listener as { __rundownLockReleaseSignalHandler?: boolean }).__rundownLockReleaseSignalHandler === true);

    expect(sigintHandler).toBeDefined();
    expect(sigtermHandler).toBeDefined();

    (sigintHandler as () => void)();
    const { awaitLockReleaseShutdown } = await import("../../src/presentation/cli-lock-handlers.js");
    await expect(awaitLockReleaseShutdown()).rejects.toThrow(/130/);
    expect(releaseAllLocks).toHaveBeenCalledTimes(1);

    (sigtermHandler as () => void)();
    await expect(awaitLockReleaseShutdown()).rejects.toThrow(/143/);
    expect(releaseAllLocks).toHaveBeenCalledTimes(2);
  });

  it("waits for app shutdown before releasing locks and terminating on SIGINT", async () => {
    const previousEnv = captureEnv();
    process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
    process.env.RUNDOWN_TEST_MODE = "1";

    const releaseAllLocks = vi.fn();
    let resolveShutdown: (() => void) | undefined;
    const awaitShutdown = vi.fn(() => new Promise<void>((resolve) => {
      resolveShutdown = resolve;
    }));

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: vi.fn(async () => 0),
        reverifyTask: vi.fn(async () => 0),
        revertTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
        releaseAllLocks,
        awaitShutdown,
      }),
    }));

    try {
      const { parseCliArgs } = await import("../../src/presentation/cli.js");
      await expect(parseCliArgs(["init"]))
        .rejects.toThrow("CLI exited with code 0");
    } finally {
      restoreEnv(previousEnv);
    }

    const sigintHandler = process
      .listeners("SIGINT")
      .find((listener) => (listener as { __rundownLockReleaseSignalHandler?: boolean }).__rundownLockReleaseSignalHandler === true);

    expect(sigintHandler).toBeDefined();
    (sigintHandler as () => void)();

    expect(awaitShutdown).toHaveBeenCalledTimes(1);
    expect(releaseAllLocks).not.toHaveBeenCalled();

    resolveShutdown?.();

    const { awaitLockReleaseShutdown } = await import("../../src/presentation/cli-lock-handlers.js");
    await expect(awaitLockReleaseShutdown()).rejects.toThrow(/130/);
    expect(releaseAllLocks).toHaveBeenCalledTimes(1);
  });

  it("registers an exit fallback handler on Windows", async () => {
    const previousEnv = captureEnv();
    process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
    process.env.RUNDOWN_TEST_MODE = "1";

    const releaseAllLocks = vi.fn();
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: vi.fn(async () => 0),
        reverifyTask: vi.fn(async () => 0),
        revertTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
        releaseAllLocks,
      }),
    }));

    try {
      const { parseCliArgs } = await import("../../src/presentation/cli.js");
      await expect(parseCliArgs(["init"]))
        .rejects.toThrow("CLI exited with code 0");
    } finally {
      platformSpy.mockRestore();
      restoreEnv(previousEnv);
    }

    const exitHandler = process
      .listeners("exit")
      .find((listener) => (listener as { __rundownLockReleaseExitHandler?: boolean }).__rundownLockReleaseExitHandler === true);

    expect(exitHandler).toBeDefined();
    (exitHandler as () => void)();
    expect(releaseAllLocks).toHaveBeenCalledTimes(1);
  });
});

describe("CLI revert option normalization", () => {
  it("passes revert options to application layer", async () => {
    const revertTask = vi.fn(async () => 0);
    const call = await invokeRevertAndCaptureCall([
      "revert",
      "--run",
      "run-123",
      "--method",
      "reset",
      "--dry-run",
      "--force",
      "--keep-artifacts",
    ], revertTask);

    expect(call.runId).toBe("run-123");
    expect(call.last).toBeUndefined();
    expect(call.all).toBe(false);
    expect(call.method).toBe("reset");
    expect(call.dryRun).toBe(true);
    expect(call.force).toBe(true);
    expect(call.keepArtifacts).toBe(true);
  });

  it("uses defaults for omitted revert options", async () => {
    const revertTask = vi.fn(async () => 0);
    const call = await invokeRevertAndCaptureCall(["revert"], revertTask);

    expect(call.runId).toBe("latest");
    expect(call.last).toBeUndefined();
    expect(call.all).toBe(false);
    expect(call.method).toBe("revert");
    expect(call.dryRun).toBe(false);
    expect(call.force).toBe(false);
    expect(call.keepArtifacts).toBe(false);
  });

  it("parses --last and --all for revert", async () => {
    const revertTask = vi.fn(async () => 0);
    const call = await invokeRevertAndCaptureCall([
      "revert",
      "--last",
      "3",
      "--all",
    ], revertTask);

    expect(call.last).toBe(3);
    expect(call.all).toBe(true);
  });

  it("parses --all for revert", async () => {
    const revertTask = vi.fn(async () => 0);
    const call = await invokeRevertAndCaptureCall([
      "revert",
      "--all",
    ], revertTask);

    expect(call.runId).toBe("latest");
    expect(call.last).toBeUndefined();
    expect(call.all).toBe(true);
    expect(call.method).toBe("revert");
  });

  it("logs a CLI error and exits with code 1 on invalid revert method", async () => {
    const revertTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRevertAndExpectExit([
      "revert",
      "--method",
      "checkout",
    ], revertTask);

    expect(revertTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --method value: checkout"));
  });

  it("logs a CLI error and exits with code 1 on non-integer --last", async () => {
    const revertTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeRevertAndExpectExit([
      "revert",
      "--last",
      "three",
    ], revertTask);

    expect(revertTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --last value: three"));
  });
});

describe("CLI log option normalization", () => {
  it("passes log options to application layer", async () => {
    const logTask = vi.fn(async () => 0);
    const call = await invokeLogAndCaptureCall([
      "log",
      "--revertable",
      "--command",
      "run",
      "--limit",
      "5",
      "--json",
    ], logTask);

    expect(call.revertable).toBe(true);
    expect(call.commandName).toBe("run");
    expect(call.limit).toBe(5);
    expect(call.json).toBe(true);
  });

  it("uses defaults for omitted log options", async () => {
    const logTask = vi.fn(async () => 0);
    const call = await invokeLogAndCaptureCall(["log"], logTask);

    expect(call.revertable).toBe(false);
    expect(call.commandName).toBeUndefined();
    expect(call.limit).toBeUndefined();
    expect(call.json).toBe(false);
  });

  it("normalizes empty command filter to undefined", async () => {
    const logTask = vi.fn(async () => 0);
    const call = await invokeLogAndCaptureCall([
      "log",
      "--command",
      "",
    ], logTask);

    expect(call.commandName).toBeUndefined();
  });

  it("logs a CLI error and exits with code 1 on non-integer --limit", async () => {
    const logTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeLogAndExpectExit([
      "log",
      "--limit",
      "many",
    ], logTask);

    expect(logTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --limit value: many"));
  });

  it("rejects unsupported --no-color option for log command", async () => {
    const logTask = vi.fn(async () => 0);

    await invokeLogAndExpectExit([
      "log",
      "--no-color",
    ], logTask);

    expect(logTask).not.toHaveBeenCalled();
  });
});

describe("CLI plan and utility command normalization", () => {
  it("explore forwards shared worker/runtime options to both research and plan", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-explore-shared-forwarding-"));
    const markdownFile = path.join(tempRoot, "8. Explore.md");
    fs.writeFileSync(markdownFile, "# Explore target\n", "utf8");

    try {
      const result = await invokeExploreAndCaptureCalls([
        "explore",
        markdownFile,
        "--scan-count",
        "5",
        "--deep",
        "2",
        "--max-items",
        "9",
        "--dry-run",
        "--print-prompt",
        "--keep-artifacts",
        "--show-agent-output",
        "--trace",
        "--force-unlock",
        "--vars-file",
        "vars.local.json",
        "--var",
        "env=prod",
        "--var",
        "region=eu",
        "--ignore-cli-block",
        "--cli-block-timeout",
        "5678",
        "--",
        "opencode",
        "run",
        "--model",
        "gpt-5",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);

      expect(researchTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        mode: "wait",
        keepArtifacts: true,
        showAgentOutput: true,
        trace: true,
        forceUnlock: true,
        ignoreCliBlock: true,
        cliBlockTimeoutMs: 5678,
        varsFileOption: "vars.local.json",
        cliTemplateVarArgs: ["env=prod", "region=eu"],
        workerPattern: expect.objectContaining({
          command: ["opencode", "run", "--model", "gpt-5"],
        }),
      }));

      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        mode: "wait",
        scanCount: 5,
        deep: 2,
        maxItems: 9,
        keepArtifacts: true,
        showAgentOutput: true,
        trace: true,
        forceUnlock: true,
        ignoreCliBlock: true,
        cliBlockTimeoutMs: 5678,
        varsFileOption: "vars.local.json",
        cliTemplateVarArgs: ["env=prod", "region=eu"],
        workerPattern: expect.objectContaining({
          command: ["opencode", "run", "--model", "gpt-5"],
        }),
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make creates file then runs research and plan with forwarded options", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-success-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");
    const callOrder: string[] = [];

    researchTask.mockImplementationOnce(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      callOrder.push("research");
      expect(call.source).toBe(markdownFile);
      expect(fs.readFileSync(markdownFile, "utf8")).toBe("please do something");
      return 0;
    });
    planTask.mockImplementationOnce(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      callOrder.push("plan");
      expect(call.source).toBe(markdownFile);
      return 0;
    });

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--scan-count",
        "5",
        "--dry-run",
        "--print-prompt",
        "--keep-artifacts",
        "--show-agent-output",
        "--trace",
        "--force-unlock",
        "--ignore-cli-block",
        "--cli-block-timeout",
        "1234",
        "--vars-file",
        "custom-vars.json",
        "--var",
        "env=prod",
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(callOrder).toEqual(["research", "plan"]);
      expect(fs.readFileSync(markdownFile, "utf8")).toBe("please do something");

      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(researchTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        mode: "wait",
        dryRun: true,
        printPrompt: true,
        keepArtifacts: true,
        showAgentOutput: true,
        trace: true,
        forceUnlock: true,
        ignoreCliBlock: true,
        cliBlockTimeoutMs: 1234,
        varsFileOption: "custom-vars.json",
        cliTemplateVarArgs: ["env=prod"],
        workerPattern: expect.objectContaining({
          command: ["opencode", "run"],
        }),
      }));

      expect(planTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        scanCount: 5,
        mode: "wait",
        dryRun: true,
        printPrompt: true,
        keepArtifacts: true,
        showAgentOutput: true,
        trace: true,
        forceUnlock: true,
        ignoreCliBlock: true,
        cliBlockTimeoutMs: 1234,
        varsFileOption: "custom-vars.json",
        cliTemplateVarArgs: ["env=prod"],
        workerPattern: expect.objectContaining({
          command: ["opencode", "run"],
        }),
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make executes successfully with a relative markdown target path", async () => {
    const researchTask = vi.fn(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      expect(path.isAbsolute(call.source)).toBe(false);
      return 0;
    });
    const planTask = vi.fn(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      expect(path.isAbsolute(call.source)).toBe(false);
      return 0;
    });
    const tempRoot = fs.mkdtempSync(path.join(process.cwd(), "rundown-make-relative-success-"));
    const absoluteMarkdownFile = path.join(tempRoot, "8. Do something.md");
    const relativeMarkdownFile = path.relative(process.cwd(), absoluteMarkdownFile);

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "relative path seed text",
        relativeMarkdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(absoluteMarkdownFile, "utf8")).toBe("relative path seed text");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make executes successfully with an absolute markdown target path", async () => {
    const researchTask = vi.fn(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      expect(path.isAbsolute(call.source)).toBe(true);
      return 0;
    });
    const planTask = vi.fn(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      expect(path.isAbsolute(call.source)).toBe(true);
      return 0;
    });
    const tempRoot = fs.mkdtempSync(path.join(process.cwd(), "rundown-make-absolute-success-"));
    const absoluteMarkdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "absolute path seed text",
        absoluteMarkdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(absoluteMarkdownFile, "utf8")).toBe("absolute path seed text");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make accepts .markdown extension and runs research then plan", async () => {
    const callOrder: string[] = [];
    const researchTask = vi.fn(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      callOrder.push("research");
      expect(call.source.endsWith(".markdown")).toBe(true);
      return 0;
    });
    const planTask = vi.fn(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      callOrder.push("plan");
      expect(call.source.endsWith(".markdown")).toBe(true);
      return 0;
    });
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-markdown-extension-"));
    const markdownFile = path.join(tempRoot, "8. Do something.markdown");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(markdownFile, "utf8")).toBe("please do something");
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(["research", "plan"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make defaults mode to wait for both research and plan", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-mode-default-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(researchTask).toHaveBeenCalledWith(expect.objectContaining({ mode: "wait" }));
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({ mode: "wait" }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make forwards shared runtime and worker options to both research and plan", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-shared-forwarding-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--keep-artifacts",
        "--show-agent-output",
        "--trace",
        "--force-unlock",
        "--ignore-cli-block",
        "--cli-block-timeout",
        "5678",
        "--vars-file",
        "vars.local.json",
        "--var",
        "env=prod",
        "--var",
        "region=eu",
        "--",
        "opencode",
        "run",
        "--model",
        "gpt-5",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);

      expect(researchTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        mode: "wait",
        keepArtifacts: true,
        showAgentOutput: true,
        trace: true,
        forceUnlock: true,
        ignoreCliBlock: true,
        cliBlockTimeoutMs: 5678,
        varsFileOption: "vars.local.json",
        cliTemplateVarArgs: ["env=prod", "region=eu"],
        workerPattern: expect.objectContaining({
          command: ["opencode", "run", "--model", "gpt-5"],
        }),
      }));

      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        mode: "wait",
        keepArtifacts: true,
        showAgentOutput: true,
        trace: true,
        forceUnlock: true,
        ignoreCliBlock: true,
        cliBlockTimeoutMs: 5678,
        varsFileOption: "vars.local.json",
        cliTemplateVarArgs: ["env=prod", "region=eu"],
        workerPattern: expect.objectContaining({
          command: ["opencode", "run", "--model", "gpt-5"],
        }),
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make --raw alias bypasses research and runs plan directly", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-raw-skip-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--raw",
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
      }));
      expect(fs.readFileSync(markdownFile, "utf8")).toBe("please do something");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make rejects interactive --mode values such as tui before research/plan", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-mode-reject-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--mode",
        "tui",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --mode value: tui"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Allowed: wait"));
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).not.toHaveBeenCalled();
      expect(fs.existsSync(markdownFile)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("do defaults mode to wait and runs make then run-all on the same markdown file", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-default-mode-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeDoAndCaptureCalls([
        "do",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], runTask, researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(researchTask).toHaveBeenCalledWith(expect.objectContaining({ mode: "wait", source: markdownFile }));
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({ mode: "wait", source: markdownFile }));
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        mode: "wait",
        runAll: true,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("do rejects interactive --mode values such as tui before bootstrap phases", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-mode-reject-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeDoAndCaptureCalls([
        "do",
        "please do something",
        markdownFile,
        "--mode",
        "tui",
      ], runTask, researchTask, planTask);

      expect(result.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --mode value: tui"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Allowed: wait"));
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).not.toHaveBeenCalled();
      expect(runTask).not.toHaveBeenCalled();
      expect(fs.existsSync(markdownFile)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("do fails fast when bootstrap research fails and does not run execution phase", async () => {
    const researchTask = vi.fn(async () => 2);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-bootstrap-fail-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeDoAndCaptureCalls([
        "do",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], runTask, researchTask, planTask);

      expect(result.exitCode).toBe(2);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).not.toHaveBeenCalled();
      expect(runTask).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make defaults plan scan count to unlimited mode", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-scan-count-default-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        scanCount: undefined,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("do forwards interactive question context to run phase via runAll execution", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-runall-question-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeDoAndCaptureCalls([
        "do",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], runTask, researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        runAll: true,
        mode: "wait",
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("do forwards bounded bootstrap scan count to plan", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-scan-count-forward-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeDoAndCaptureCalls([
        "do",
        "please do something",
        markdownFile,
        "--scan-count",
        "4",
        "--worker",
        "opencode",
        "run",
      ], runTask, researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        scanCount: 4,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make writes seed text verbatim, including quotes, newlines, and shell characters", async () => {
    const seedText = [
      "He said, \"keep 'all' symbols\".",
      "line two: $PATH && rm -rf / ; | `pwd`",
      "line three: !@#$%^&*()[]{}<>?",
    ].join("\n");
    const researchTask = vi.fn(async (...args: unknown[]) => {
      const call = args[0] as { source: string };
      expect(fs.readFileSync(call.source, "utf8")).toBe(seedText);
      return 0;
    });
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-verbatim-seed-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        seedText,
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(fs.readFileSync(markdownFile, "utf8")).toBe(seedText);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make fails fast when research fails and does not run plan", async () => {
    const callOrder: string[] = [];
    const researchTask = vi.fn(async () => {
      callOrder.push("research");
      return 2;
    });
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-research-fail-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(2);
      expect(fs.readFileSync(markdownFile, "utf8")).toBe("please do something");
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).not.toHaveBeenCalled();
      expect(callOrder).toEqual(["research"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make propagates plan failure exit codes and preserves research outputs", async () => {
    const researchOutputContent = [
      "please do something",
      "",
      "## Research Notes",
      "- collected constraints",
    ].join("\n");
    const planTask = vi.fn(async () => 3);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-plan-fail-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");
    const researchOutputArtifact = path.join(tempRoot, "research-output.txt");
    const callOrder: string[] = [];
    const researchTask = vi.fn(async () => {
      callOrder.push("research");
      fs.writeFileSync(markdownFile, researchOutputContent, "utf8");
      fs.writeFileSync(researchOutputArtifact, "research artifact", "utf8");
      return 0;
    });

    planTask.mockImplementationOnce(async () => {
      callOrder.push("plan");
      return 3;
    });

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(3);
      expect(callOrder).toEqual(["research", "plan"]);
      expect(fs.readFileSync(markdownFile, "utf8")).toBe(researchOutputContent);
      expect(fs.readFileSync(researchOutputArtifact, "utf8")).toBe("research artifact");
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make falls back to exit code 1 for non-integer subcommand exit values", async () => {
    const researchTask = vi.fn(async () => Number.NaN as unknown as number);
    const planTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-non-integer-code-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(1);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make rejects non-markdown target path before research/plan", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-bad-ext-"));
    const badPath = path.join(tempRoot, "notes.txt");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        badPath,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid make document path"));
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make validates relative and absolute non-markdown target paths consistently", async () => {
    const tempRoot = fs.mkdtempSync(path.join(process.cwd(), "rundown-make-relative-absolute-invalid-"));
    const absoluteBadPath = path.join(tempRoot, "notes.txt");
    const relativeBadPath = path.relative(process.cwd(), absoluteBadPath);

    try {
      for (const badPath of [relativeBadPath, absoluteBadPath]) {
        const researchTask = vi.fn(async () => 0);
        const planTask = vi.fn(async () => 0);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

        const result = await invokeMakeAndCaptureCalls([
          "make",
          "please do something",
          badPath,
          "--worker",
          "opencode",
          "run",
        ], researchTask, planTask);

        expect(result.exitCode).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid make document path"));
        expect(researchTask).not.toHaveBeenCalled();
        expect(planTask).not.toHaveBeenCalled();
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make refuses to overwrite an existing markdown file", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-collision-"));
    const markdownFile = path.join(tempRoot, "8. Do something.md");
    fs.writeFileSync(markdownFile, "existing content", "utf8");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("File already exists"));
      expect(fs.readFileSync(markdownFile, "utf8")).toBe("existing content");
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make fails clearly when target parent directory is missing", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-missing-parent-"));
    const markdownFile = path.join(tempRoot, "missing-parent", "8. Do something.md");

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Parent directory does not exist"));
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make rejects directory targets before research/plan", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-dir-target-"));
    const markdownDirectory = path.join(tempRoot, "target.md");
    fs.mkdirSync(markdownDirectory);

    try {
      const result = await invokeMakeAndCaptureCalls([
        "make",
        "please do something",
        markdownDirectory,
        "--worker",
        "opencode",
        "run",
      ], researchTask, planTask);

      expect(result.exitCode).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid make document path"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("does not accept directory or glob inputs"));
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("make rejects glob-style markdown targets before research/plan", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await invokeMakeAndCaptureCalls([
      "make",
      "please do something",
      "*.md",
      "--worker",
      "opencode",
      "run",
    ], researchTask, planTask);

    expect(result.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid make document path"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("does not accept directory or glob inputs"));
    expect(researchTask).not.toHaveBeenCalled();
    expect(planTask).not.toHaveBeenCalled();
  });

  it("passes document-mode plan options through with separator worker command", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--scan-count",
      "3",
      "--deep",
      "2",
      "--dry-run",
      "--print-prompt",
      "--keep-artifacts",
      "--vars-file",
      "custom-vars.json",
      "--var",
      "env=prod",
      "--",
      "opencode",
      "run",
    ], planTask);

    expect(call.source).toBe("tasks.md");
    expect(call.scanCount).toBe(3);
    expect(call.deep).toBe(2);
    expect(call.mode).toBe("wait");
    expect(call.showAgentOutput).toBe(false);
    expect(call.dryRun).toBe(true);
    expect(call.printPrompt).toBe(true);
    expect(call.keepArtifacts).toBe(true);
    expect(call.varsFileOption).toBe("custom-vars.json");
    expect(call.cliTemplateVarArgs).toEqual(["env=prod"]);
    expect(call.workerCommand).toEqual(["opencode", "run"]);
    expect(call.ignoreCliBlock).toBe(false);
    expect(call.cliBlockTimeoutMs).toBe(30_000);
  });

  it("forwards --loop flag to plan task", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--loop",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.source).toBe("tasks.md");
    expect(call.loop).toBe(true);
  });

  it("preserves existing plan options when --loop is enabled", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--loop",
      "--scan-count",
      "3",
      "--deep",
      "2",
      "--dry-run",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.source).toBe("tasks.md");
    expect(call.loop).toBe(true);
    expect(call.scanCount).toBe(3);
    expect(call.deep).toBe(2);
    expect(call.dryRun).toBe(true);
    expect(call.printPrompt).toBe(true);
    expect(call.mode).toBe("wait");
  });

  it("passes explicit --cli-block-timeout to plan task", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--cli-block-timeout",
      "1234",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.cliBlockTimeoutMs).toBe(1234);
  });

  it("accepts worker flags after --worker for plan", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--worker",
      "claude",
      "-p",
    ], planTask);

    expect(call.workerCommand).toEqual(["claude", "-p"]);
  });

  it("passes --show-agent-output option to plan task", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--show-agent-output",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.showAgentOutput).toBe(true);
  });

  it("passes --no-show-agent-output option to plan task", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--no-show-agent-output",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.showAgentOutput).toBe(false);
  });

  it("honors last show-agent-output toggle for plan", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--show-agent-output",
      "--no-show-agent-output",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.showAgentOutput).toBe(false);
  });

  it("passes --ignore-cli-block flag to plan task", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--ignore-cli-block",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.ignoreCliBlock).toBe(true);
  });

  it("parses --oldest-first flag for reverify", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--all",
      "--oldest-first",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(call.all).toBe(true);
    expect(call.oldestFirst).toBe(true);
  });

  it("logs a CLI error and exits with code 1 when plan is missing a markdown file path", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("requires exactly one Markdown file path"));
  });

  it("logs a CLI error and exits with code 1 when plan receives multiple markdown file paths", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "one.md",
      "two.md",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("accepts exactly one Markdown file path"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("one.md, two.md"));
  });

  it("logs a CLI error and exits with code 1 when plan file path is not markdown", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.txt",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid plan document path: tasks.txt"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(".md or .markdown"));
  });

  it("accepts .markdown extension for plan file path", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.markdown",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.source).toBe("tasks.markdown");
  });

  it("passes trace option to plan task", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--trace",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.trace).toBe(true);
  });

  it("passes force-unlock option to plan task", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--force-unlock",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.forceUnlock).toBe(true);
  });

  it("defaults plan scan count to unlimited mode", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.scanCount).toBeUndefined();
  });

  it("defaults plan deep to 0", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.deep).toBe(0);
  });

  it("defaults plan loop mode to false when omitted", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.loop).toBe(false);
  });

  it("logs a CLI error and exits with code 1 on non-integer deep value", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--deep",
      "many",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --deep value: many"));
  });

  it("logs a CLI error and exits with code 1 on negative deep value", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--deep",
      "-1",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --deep value: -1"));
  });

  it("logs a CLI error and exits with code 1 on non-integer scan count", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--scan-count",
      "two",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --scan-count value: two"));
  });

  it("logs a CLI error and exits with code 1 on zero scan count", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--scan-count",
      "0",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Must be a positive integer"));
  });

  it("logs a CLI error and exits with code 1 on negative scan count", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--scan-count",
      "-1",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --scan-count value: -1"));
  });

  it("logs a CLI error and exits with code 1 on unsafe scan count", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--scan-count",
      "9007199254740993",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Must be a safe positive integer"));
  });

  it("passes research options through with separator worker command", async () => {
    const researchTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-research-options-"));
    const markdownFile = path.join(tempRoot, "tasks.md");
    fs.writeFileSync(markdownFile, "# Tasks\n", "utf8");

    try {
    const call = await invokeResearchAndCaptureCall([
      "research",
      markdownFile,
      "--mode",
      "wait",
      "--dry-run",
      "--print-prompt",
      "--keep-artifacts",
      "--trace",
      "--force-unlock",
      "--ignore-cli-block",
      "--cli-block-timeout",
      "1234",
      "--vars-file",
      "custom-vars.json",
      "--var",
      "env=prod",
      "--",
      "opencode",
      "run",
    ], researchTask);

    expect(call.source).toBe(markdownFile);
    expect(call.mode).toBe("wait");
    expect(call.dryRun).toBe(true);
    expect(call.printPrompt).toBe(true);
    expect(call.keepArtifacts).toBe(true);
    expect(call.trace).toBe(true);
    expect(call.forceUnlock).toBe(true);
    expect(call.ignoreCliBlock).toBe(true);
    expect(call.cliBlockTimeoutMs).toBe(1234);
    expect(call.varsFileOption).toBe("custom-vars.json");
    expect(call.cliTemplateVarArgs).toEqual(["env=prod"]);
    expect(call.workerCommand).toEqual(["opencode", "run"]);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("defaults research mode to wait", async () => {
    const researchTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-research-mode-default-"));
    const markdownFile = path.join(tempRoot, "tasks.md");
    fs.writeFileSync(markdownFile, "# Tasks\n", "utf8");

    try {
      const call = await invokeResearchAndCaptureCall([
        "research",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], researchTask);

      expect(call.mode).toBe("wait");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("accepts research --mode tui", async () => {
    const researchTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-research-mode-tui-"));
    const markdownFile = path.join(tempRoot, "tasks.md");
    fs.writeFileSync(markdownFile, "# Tasks\n", "utf8");

    try {
      const call = await invokeResearchAndCaptureCall([
        "research",
        markdownFile,
        "--mode",
        "tui",
        "--worker",
        "opencode",
        "run",
      ], researchTask);

      expect(call.mode).toBe("tui");
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("logs a CLI error and exits with code 1 on research detached mode", async () => {
    const researchTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-research-mode-detached-"));
    const markdownFile = path.join(tempRoot, "tasks.md");
    fs.writeFileSync(markdownFile, "# Tasks\n", "utf8");

    try {
      await invokeResearchAndExpectExit([
        "research",
        markdownFile,
        "--mode",
        "detached",
        "--worker",
        "opencode",
        "run",
      ], researchTask);

      expect(researchTask).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --mode value: detached"));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("logs a CLI error and exits with code 1 when research is missing a markdown file path", async () => {
    const researchTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeResearchAndExpectExit([
      "research",
      "--worker",
      "opencode",
      "run",
    ], researchTask);

    expect(researchTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("requires exactly one Markdown file path"));
  });

  it("logs a CLI error and exits with code 1 when research receives multiple markdown file paths", async () => {
    const researchTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeResearchAndExpectExit([
      "research",
      "one.md",
      "two.md",
      "--worker",
      "opencode",
      "run",
    ], researchTask);

    expect(researchTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("accepts exactly one Markdown file path"));
  });

  it("logs a CLI error and exits with code 1 when research file path is not markdown", async () => {
    const researchTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeResearchAndExpectExit([
      "research",
      "tasks.txt",
      "--worker",
      "opencode",
      "run",
    ], researchTask);

    expect(researchTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid research document path: tasks.txt"));
  });

  it("logs a CLI error and exits with code 1 when research file path does not exist", async () => {
    const researchTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const missingMarkdown = path.join(
      os.tmpdir(),
      `rundown-research-missing-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );

    await invokeResearchAndExpectExit([
      "research",
      missingMarkdown,
      "--worker",
      "opencode",
      "run",
    ], researchTask);

    expect(researchTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("requires exactly one existing Markdown file"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("does not exist"));
  });

  it("logs a CLI error and exits with code 1 when research receives a directory path", async () => {
    const researchTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-research-dir-input-"));
    const markdownLikeDirectory = path.join(tempRoot, "notes.md");
    fs.mkdirSync(markdownLikeDirectory, { recursive: true });

    try {
      await invokeResearchAndExpectExit([
        "research",
        markdownLikeDirectory,
        "--worker",
        "opencode",
        "run",
      ], researchTask);

      expect(researchTask).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("requires exactly one existing Markdown file"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("does not accept directory or glob inputs"));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("logs a CLI error and exits with code 1 when research receives a glob path", async () => {
    const researchTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeResearchAndExpectExit([
      "research",
      "tasks*.md",
      "--worker",
      "opencode",
      "run",
    ], researchTask);

    expect(researchTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("requires exactly one existing Markdown file"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("does not accept directory or glob inputs"));
  });

  it("logs a CLI error and exits with code 1 when research receives --scan-count", async () => {
    const researchTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-research-scan-count-"));
    const markdownFile = path.join(tempRoot, "tasks.md");
    fs.writeFileSync(markdownFile, "# Tasks\n", "utf8");

    try {
      await invokeResearchAndExpectExit([
        "research",
        markdownFile,
        "--scan-count",
        "2",
        "--worker",
        "opencode",
        "run",
      ], researchTask);

      expect(researchTask).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported option for `research`: --scan-count"));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("single-pass flow"));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes list options to the application layer", async () => {
    const listTasks = vi.fn(async () => 0);
    const call = await invokeListAndCaptureCall([
      "list",
      "tasks.md",
      "--sort",
      "none",
      "--all",
    ], listTasks);

    expect(call).toEqual({
      source: "tasks.md",
      sortMode: "none",
      includeAll: true,
    });
  });

  it("passes artifacts options with default open fallback", async () => {
    const manageArtifacts = vi.fn(() => 0);
    const call = await invokeArtifactsAndCaptureCall([
      "artifacts",
      "--clean",
      "--failed",
    ], manageArtifacts);

    expect(call).toEqual({
      clean: true,
      json: false,
      failed: true,
      open: "",
    });
  });

  it("dispatches init to the application layer", async () => {
    const initProject = vi.fn(async () => 0);

    await invokeInitAndCaptureCall(["init"], initProject);

    expect(initProject).toHaveBeenCalledTimes(1);
  });

  it("passes unlock source argument to the application layer", async () => {
    const unlockTask = vi.fn(async () => 0);
    const call = await invokeUnlockAndCaptureCall(["unlock", "tasks.md"], unlockTask);

    expect(call).toEqual({ source: "tasks.md" });
  });

  it("do uses run defaults from config when commit flags are omitted", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-run-defaults-"));
    const previousCwd = process.cwd();
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const configDir = path.join(tempRoot, ".rundown");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        run: {
          revertable: true,
          commit: false,
          commitMessage: "cfg: {{task}}",
          commitMode: "file-done",
        },
      }, null, 2) + "\n", "utf-8");
      process.chdir(tempRoot);

      const result = await invokeDoAndCaptureCalls([
        "do",
        "please do something",
        markdownFile,
        "--worker",
        "opencode",
        "run",
      ], runTask, researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
        keepArtifacts: true,
        commitAfterComplete: true,
        commitMode: "file-done",
        commitMessageTemplate: "cfg: {{task}}",
      }));
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("do lets CLI commit flags override config defaults while preserving unrelated defaults", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-run-defaults-override-"));
    const previousCwd = process.cwd();
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const configDir = path.join(tempRoot, ".rundown");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        run: {
          revertable: true,
          commit: false,
          commitMessage: "cfg: {{task}}",
          commitMode: "file-done",
        },
      }, null, 2) + "\n", "utf-8");
      process.chdir(tempRoot);

      const result = await invokeDoAndCaptureCalls([
        "do",
        "please do something",
        markdownFile,
        "--commit",
        "--commit-mode",
        "per-task",
        "--commit-message",
        "cli: {{task}}",
        "--worker",
        "opencode",
        "run",
      ], runTask, researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
        keepArtifacts: true,
        commitAfterComplete: true,
        commitMode: "per-task",
        commitMessageTemplate: "cli: {{task}}",
      }));
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("do lets --revertable override config while preserving configured commit message and mode", async () => {
    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-run-defaults-revertable-override-"));
    const previousCwd = process.cwd();
    const markdownFile = path.join(tempRoot, "8. Do something.md");

    try {
      const configDir = path.join(tempRoot, ".rundown");
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
        run: {
          revertable: false,
          commit: false,
          commitMessage: "cfg: {{task}}",
          commitMode: "file-done",
        },
      }, null, 2) + "\n", "utf-8");
      process.chdir(tempRoot);

      const result = await invokeDoAndCaptureCalls([
        "do",
        "please do something",
        markdownFile,
        "--revertable",
        "--worker",
        "opencode",
        "run",
      ], runTask, researchTask, planTask);

      expect(result.exitCode).toBe(0);
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
        keepArtifacts: true,
        commitAfterComplete: true,
        commitMode: "file-done",
        commitMessageTemplate: "cfg: {{task}}",
      }));
    } finally {
      process.chdir(previousCwd);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("passes workspace unlink options to the application layer", async () => {
    const workspaceUnlinkTask = vi.fn(async () => 0);
    const call = await invokeWorkspaceUnlinkAndCaptureCall([
      "workspace",
      "unlink",
      "--workspace",
      "../linked-project",
      "--all",
      "--dry-run",
    ], workspaceUnlinkTask);

    expect(call).toEqual({
      workspace: "../linked-project",
      all: true,
      dryRun: true,
    });
  });

  it("passes workspace remove options to the application layer", async () => {
    const workspaceRemoveTask = vi.fn(async () => 0);
    const call = await invokeWorkspaceRemoveAndCaptureCall([
      "workspace",
      "remove",
      "--workspace",
      "record-id",
      "--delete-files",
      "--force",
    ], workspaceRemoveTask);

    expect(call).toEqual({
      workspace: "record-id",
      all: false,
      deleteFiles: true,
      dryRun: false,
      force: true,
    });
  });
});

async function invokeRunAndCaptureCall(args: string[], runTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(runTask).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(runTask.mock.calls[0][0] as RunTaskCall);
}

async function invokeDiscussAndCaptureCall(
  args: string[],
  discussTask: ReturnType<typeof vi.fn>,
): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      discussTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(discussTask).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(discussTask.mock.calls[0][0] as RunTaskCall);
}

async function invokeDiscussAndExpectExit(args: string[], discussTask: ReturnType<typeof vi.fn>): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      discussTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (/CLI exited with code \d+/.test(message)) {
      return;
    }
    if (/process\.exit unexpectedly called/.test(message)) {
      return;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokeRunAndExpectExit(args: string[], runTask: ReturnType<typeof vi.fn>): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (/CLI exited with code \d+/.test(message)) {
      return;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokeRunAndCaptureExitCode(args: string[], runTask: ReturnType<typeof vi.fn>): Promise<number> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    const match = /CLI exited with code (\d+)/.exec(message);
    if (match) {
      return Number(match[1]);
    }
    if (/process\.exit unexpectedly called/.test(message)) {
      return 1;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokeRunAndCaptureHelpOutput(
  args: string[],
  runTask: ReturnType<typeof vi.fn>,
): Promise<{ output: string; exitCode: number }> {
  const previousEnv = captureEnv();
  let output = "";

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as never);

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    const match = /CLI exited with code (\d+)/.exec(message);
    if (match) {
      return {
        output,
        exitCode: Number(match[1]),
      };
    }
    if (/process\.exit unexpectedly called/.test(message)) {
      return {
        output,
        exitCode: 1,
      };
    }
    throw error;
  } finally {
    stdoutSpy.mockRestore();
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokeReverifyAndCaptureCall(args: string[], reverifyTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask,
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(reverifyTask).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(reverifyTask.mock.calls[0][0] as RunTaskCall);
}

async function invokeReverifyAndExpectExit(args: string[], reverifyTask: ReturnType<typeof vi.fn>): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask,
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (/CLI exited with code \d+/.test(message)) {
      return;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokePlanAndCaptureCall(args: string[], planTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask,
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(planTask).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(planTask.mock.calls[0][0] as RunTaskCall);
}

async function invokeResearchAndCaptureCall(args: string[], researchTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      researchTask,
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(researchTask).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(researchTask.mock.calls[0][0] as RunTaskCall);
}

async function invokeRunAndExpectExitWithGlobalLogCapture(
  args: string[],
  runTask: ReturnType<typeof vi.fn>,
  writeSpy: ReturnType<typeof vi.fn>,
): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  vi.doMock("../../src/infrastructure/adapters/global-output-log-writer.js", () => ({
    createGlobalOutputLogWriter: vi.fn(() => ({
      write: writeSpy,
      flush: vi.fn(),
    })),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (/CLI exited with code \d+/.test(message) || /process\.exit unexpectedly called/.test(message)) {
      return;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokeRevertAndCaptureCall(args: string[], revertTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask,
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message) && !/process\.exit unexpectedly called/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(revertTask).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(revertTask.mock.calls[0][0] as RunTaskCall);
}

async function invokeRevertAndExpectExit(args: string[], revertTask: ReturnType<typeof vi.fn>): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask,
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (/CLI exited with code \d+/.test(message) || /process\.exit unexpectedly called/.test(message)) {
      return;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokePlanAndExpectExit(args: string[], planTask: ReturnType<typeof vi.fn>): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask,
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (/CLI exited with code \d+/.test(message) || /process\.exit unexpectedly called/.test(message)) {
      return;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokeResearchAndExpectExit(args: string[], researchTask: ReturnType<typeof vi.fn>): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      researchTask,
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (/CLI exited with code \d+/.test(message) || /process\.exit unexpectedly called/.test(message)) {
      return;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokeMakeAndCaptureCalls(
  args: string[],
  researchTask: ReturnType<typeof vi.fn>,
  planTask: ReturnType<typeof vi.fn>,
): Promise<{ exitCode: number }> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      discussTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask,
      researchTask,
      unlockTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  let exitCode = 0;
  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    const match = /CLI exited with code (\d+)/.exec(message);
    if (match) {
      exitCode = Number(match[1]);
    } else if (/process\.exit unexpectedly called/.test(message)) {
      exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  return { exitCode };
}

async function invokeExploreAndCaptureCalls(
  args: string[],
  researchTask: ReturnType<typeof vi.fn>,
  planTask: ReturnType<typeof vi.fn>,
): Promise<{ exitCode: number }> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      discussTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask,
      researchTask,
      unlockTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  let exitCode = 0;
  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    const match = /CLI exited with code (\d+)/.exec(message);
    if (match) {
      exitCode = Number(match[1]);
    } else if (/process\.exit unexpectedly called/.test(message)) {
      exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  return { exitCode };
}

async function invokeDoAndCaptureCalls(
  args: string[],
  runTask: ReturnType<typeof vi.fn>,
  researchTask: ReturnType<typeof vi.fn>,
  planTask: ReturnType<typeof vi.fn>,
): Promise<{ exitCode: number }> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      discussTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask,
      researchTask,
      unlockTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  let exitCode = 0;
  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    const match = /CLI exited with code (\d+)/.exec(message);
    if (match) {
      exitCode = Number(match[1]);
    } else if (/process\.exit unexpectedly called/.test(message)) {
      exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  return { exitCode };
}

async function invokeLogAndCaptureCall(args: string[], logTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      unlockTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
      logTask,
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(logTask).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(logTask.mock.calls[0][0] as RunTaskCall);
}

async function invokeLogAndExpectExit(args: string[], logTask: ReturnType<typeof vi.fn>): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      unlockTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
      logTask,
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (/CLI exited with code \d+/.test(message) || /process\.exit unexpectedly called/.test(message)) {
      return;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokePlanAndCaptureExitCode(args: string[], planTask: ReturnType<typeof vi.fn>): Promise<number> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask,
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    const match = /CLI exited with code (\d+)/.exec(message);
    if (match) {
      return Number(match[1]);
    }
    if (/process\.exit unexpectedly called/.test(message)) {
      return 1;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

async function invokeLoopAndCaptureRunCalls(args: string[], runTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall[]> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  return runTask.mock.calls.map((call) => withLegacyWorkerCommand(call[0] as RunTaskCall));
}

async function invokeLoopAndCaptureRunCallsAndLockReleaseCount(
  args: string[],
  runTask: ReturnType<typeof vi.fn>,
  releaseAllLocks: ReturnType<typeof vi.fn>,
): Promise<{ calls: RunTaskCall[] }> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
      releaseAllLocks,
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  return {
    calls: runTask.mock.calls.map((call) => withLegacyWorkerCommand(call[0] as RunTaskCall)),
  };
}

async function invokeLoopAndCaptureExitCodeWithLockRelease(
  args: string[],
  runTask: ReturnType<typeof vi.fn>,
  releaseAllLocks: ReturnType<typeof vi.fn>,
): Promise<number> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
      releaseAllLocks,
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    const match = /CLI exited with code (\d+)/.exec(message);
    if (match) {
      return Number(match[1]);
    }
    if (/process\.exit unexpectedly called/.test(message)) {
      return 1;
    }
    throw error;
  } finally {
    restoreEnv(previousEnv);
  }

  throw new Error("Expected CLI exit");
}

interface CapturedOutputEvent {
  kind: string;
  message: string;
}

async function invokeLoopAndCaptureOutputEvents(
  args: string[],
  runTask: ReturnType<typeof vi.fn>,
): Promise<CapturedOutputEvent[]> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  const events: CapturedOutputEvent[] = [];

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
      emitOutput: vi.fn((event: CapturedOutputEvent) => {
        events.push(event);
      }),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  return events;
}

async function invokeListAndCaptureCall(args: string[], listTasks: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks,
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(listTasks).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(listTasks.mock.calls[0][0] as RunTaskCall);
}

async function invokeArtifactsAndCaptureCall(args: string[], manageArtifacts: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts,
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(manageArtifacts).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(manageArtifacts.mock.calls[0][0] as RunTaskCall);
}

async function invokeInitAndCaptureCall(args: string[], initProject: ReturnType<typeof vi.fn>): Promise<void> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject,
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }
}

function captureEnv(): Record<(typeof envKeys)[number], string | undefined> {
  return {
    RUNDOWN_DISABLE_AUTO_PARSE: process.env.RUNDOWN_DISABLE_AUTO_PARSE,
    RUNDOWN_TEST_MODE: process.env.RUNDOWN_TEST_MODE,
  };
}

function restoreEnv(previousEnv: Record<(typeof envKeys)[number], string | undefined>): void {
  for (const key of envKeys) {
    const value = previousEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function invokeUnlockAndCaptureCall(args: string[], unlockTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      unlockTask,
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(unlockTask).toHaveBeenCalledTimes(1);
  return withLegacyWorkerCommand(unlockTask.mock.calls[0][0] as RunTaskCall);
}

async function invokeWorkspaceUnlinkAndCaptureCall(
  args: string[],
  workspaceUnlinkTask: ReturnType<typeof vi.fn>,
): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      unlockTask: vi.fn(async () => 0),
      workspaceUnlinkTask,
      workspaceRemoveTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(workspaceUnlinkTask).toHaveBeenCalledTimes(1);
  return workspaceUnlinkTask.mock.calls[0][0] as RunTaskCall;
}

async function invokeWorkspaceRemoveAndCaptureCall(
  args: string[],
  workspaceRemoveTask: ReturnType<typeof vi.fn>,
): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      unlockTask: vi.fn(async () => 0),
      workspaceUnlinkTask: vi.fn(async () => 0),
      workspaceRemoveTask,
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(workspaceRemoveTask).toHaveBeenCalledTimes(1);
  return workspaceRemoveTask.mock.calls[0][0] as RunTaskCall;
}

function normalizeLegacyWorkerPatternArgs(args: string[]): string[] {
  const workerIndex = args.indexOf("--worker");
  if (workerIndex === -1) {
    return args;
  }

  const separatorIndex = args.indexOf("--", workerIndex + 1);
  if (separatorIndex !== -1) {
    return args;
  }

  const tokensAfterWorker = args.slice(workerIndex + 1);
  if (tokensAfterWorker.length === 0) {
    return args;
  }

  return [
    ...args.slice(0, workerIndex + 1),
    tokensAfterWorker.join(" "),
  ];
}

function withLegacyWorkerCommand(call: RunTaskCall): RunTaskCall {
  if (Array.isArray(call.workerCommand)) {
    return call;
  }

  const workerPattern = call.workerPattern;
  if (
    typeof workerPattern === "object"
    && workerPattern !== null
    && Array.isArray((workerPattern as { command?: unknown }).command)
  ) {
    return {
      ...call,
      workerCommand: [...((workerPattern as { command: string[] }).command)],
    };
  }

  return call;
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

interface LoggedOutputContextCapture {
  command: string;
  argv: string[];
}

async function invokeCliAndCaptureLoggedContext(args: string[]): Promise<LoggedOutputContextCapture> {
  const previousEnv = captureEnv();
  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  let captured: LoggedOutputContextCapture | undefined;

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask: vi.fn(async () => 0),
      reverifyTask: vi.fn(async () => 0),
      revertTask: vi.fn(async () => 0),
      nextTask: vi.fn(async () => 0),
      listTasks: vi.fn(async () => 0),
      planTask: vi.fn(async () => 0),
      initProject: vi.fn(async () => 0),
      manageArtifacts: vi.fn(() => 0),
    }),
  }));

  vi.doMock("../../src/presentation/logged-output-port.js", async () => {
    const actual = await vi.importActual<typeof import("../../src/presentation/logged-output-port.js")>(
      "../../src/presentation/logged-output-port.js",
    );

    return {
      ...actual,
      createLoggedOutputPort: vi.fn((options: {
        output: { emit: (event: unknown) => void };
        context: LoggedOutputContextCapture;
      }) => {
        captured = {
          command: options.context.command,
          argv: [...options.context.argv],
        };
        return options.output;
      }),
    };
  });

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(normalizeLegacyWorkerPatternArgs(args));
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message) && !/process\.exit unexpectedly called/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  if (!captured) {
    throw new Error("Expected logged output context to be captured");
  }

  return captured;
}
