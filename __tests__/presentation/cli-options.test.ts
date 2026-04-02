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
    expect(call.commitMessageTemplate).toBeUndefined();
    expect(call.onCompleteCommand).toBeUndefined();
    expect(call.onFailCommand).toBeUndefined();
    expect(call.showAgentOutput).toBe(false);
    expect(call.runAll).toBe(false);
    expect(call.noRepair).toBe(false);
    expect(call.repairAttempts).toBe(1);
    expect(call.forceExecute).toBe(false);
    expect(call.ignoreCliBlock).toBe(false);
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
    expect(call.commitMessageTemplate).toBe("done: {{task}}");
    expect(call.onCompleteCommand).toBe("node scripts/after.js");
    expect(call.onFailCommand).toBe("node scripts/handle-fail.js");
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

  it("expands all alias to run --all", async () => {
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
    expect(call.mode).toBe("tui");
    expect(call.transport).toBe("file");
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
      "--transport",
      "arg",
      "--sort",
      "old-first",
      "--print-prompt",
      "--keep-artifacts",
      "--",
      "opencode",
      "run",
    ], discussTask);

    expect(call.mode).toBe("wait");
    expect(call.transport).toBe("arg");
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
        "opencode",
        "run",
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
      "opencode",
      "run",
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
        "opencode",
        "run",
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
      "opencode",
      "run",
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
        "opencode",
        "run",
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
  });

  it("passes reverify options to application layer", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const call = await invokeReverifyAndCaptureCall([
      "reverify",
      "--run",
      "run-123",
      "--transport",
      "arg",
      "--repair-attempts",
      "2",
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
    expect(call.transport).toBe("arg");
    expect(call.repairAttempts).toBe(2);
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

  it("logs a CLI error and exits with code 1 on invalid transport", async () => {
    const reverifyTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokeReverifyAndExpectExit([
      "reverify",
      "--transport",
      "stdin",
      "--worker",
      "opencode",
      "run",
    ], reverifyTask);

    expect(reverifyTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid --transport value: stdin"));
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
      await expect(parseCliArgs(["reverify", "--worker", "opencode", "run"]))
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
      "opencode",
      "run",
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

  it("records run command in invocation context for all alias", async () => {
    const context = await invokeCliAndCaptureLoggedContext(["all", "tasks.md", "--worker", "opencode", "run"]);

    expect(context.command).toBe("run");
    expect(context.argv).toEqual(["run", "--all", "tasks.md", "--worker", "opencode", "run"]);
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

    expect(() => (sigintHandler as () => void)()).toThrow(/130/);
    expect(releaseAllLocks).toHaveBeenCalledTimes(1);

    expect(() => (sigtermHandler as () => void)()).toThrow(/143/);
    expect(releaseAllLocks).toHaveBeenCalledTimes(2);
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
        "--transport",
        "arg",
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
        transport: "arg",
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
        workerCommand: ["opencode", "run"],
      }));

      expect(planTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        scanCount: 5,
        mode: "wait",
        transport: "arg",
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
        workerCommand: ["opencode", "run"],
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
        "--transport",
        "arg",
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
        transport: "arg",
        keepArtifacts: true,
        showAgentOutput: true,
        trace: true,
        forceUnlock: true,
        ignoreCliBlock: true,
        cliBlockTimeoutMs: 5678,
        varsFileOption: "vars.local.json",
        cliTemplateVarArgs: ["env=prod", "region=eu"],
        workerCommand: ["opencode", "run", "--model", "gpt-5"],
      }));

      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: markdownFile,
        mode: "wait",
        transport: "arg",
        keepArtifacts: true,
        showAgentOutput: true,
        trace: true,
        forceUnlock: true,
        ignoreCliBlock: true,
        cliBlockTimeoutMs: 5678,
        varsFileOption: "vars.local.json",
        cliTemplateVarArgs: ["env=prod", "region=eu"],
        workerCommand: ["opencode", "run", "--model", "gpt-5"],
      }));
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
    expect(call.mode).toBe("wait");
    expect(call.transport).toBe("file");
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

  it("defaults plan scan count to 3", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.scanCount).toBe(3);
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
      "--transport",
      "arg",
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
    expect(call.transport).toBe("arg");
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(runTask).toHaveBeenCalledTimes(1);
  return runTask.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(discussTask).toHaveBeenCalledTimes(1);
  return discussTask.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(reverifyTask).toHaveBeenCalledTimes(1);
  return reverifyTask.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(planTask).toHaveBeenCalledTimes(1);
  return planTask.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(researchTask).toHaveBeenCalledTimes(1);
  return researchTask.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message) && !/process\.exit unexpectedly called/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(revertTask).toHaveBeenCalledTimes(1);
  return revertTask.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(logTask).toHaveBeenCalledTimes(1);
  return logTask.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(listTasks).toHaveBeenCalledTimes(1);
  return listTasks.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(manageArtifacts).toHaveBeenCalledTimes(1);
  return manageArtifacts.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
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
    await parseCliArgs(args);
  } catch (error) {
    const message = String(error);
    if (!/CLI exited with code \d+/.test(message)) {
      throw error;
    }
  } finally {
    restoreEnv(previousEnv);
  }

  expect(unlockTask).toHaveBeenCalledTimes(1);
  return unlockTask.mock.calls[0][0] as RunTaskCall;
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
    await parseCliArgs(args);
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
