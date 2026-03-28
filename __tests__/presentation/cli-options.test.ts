import { afterEach, describe, expect, it, vi } from "vitest";

type RunTaskCall = Record<string, unknown>;

const envKeys = ["RUNDOWN_DISABLE_AUTO_PARSE", "RUNDOWN_TEST_MODE"] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("../../src/create-app.js");
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
    expect(call.hideAgentOutput).toBe(false);
    expect(call.runAll).toBe(false);
    expect(call.noRepair).toBe(false);
    expect(call.repairAttempts).toBe(1);
    expect(call.forceExecute).toBe(false);
  });

  it("passes hide-agent-output option to run task", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--hide-agent-output",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.hideAgentOutput).toBe(true);
  });

  it("defaults hide-agent-output to false when omitted", async () => {
    const runTask = vi.fn(async () => 0);
    const call = await invokeRunAndCaptureCall([
      "run",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.hideAgentOutput).toBe(false);
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
    expect(call.transport).toBe("arg");
    expect(call.repairAttempts).toBe(2);
    expect(call.noRepair).toBe(true);
    expect(call.dryRun).toBe(true);
    expect(call.printPrompt).toBe(true);
    expect(call.keepArtifacts).toBe(true);
    expect(call.workerCommand).toEqual(["opencode", "run"]);
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

describe("CLI plan and utility command normalization", () => {
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
    expect(call.dryRun).toBe(true);
    expect(call.printPrompt).toBe(true);
    expect(call.keepArtifacts).toBe(true);
    expect(call.varsFileOption).toBe("custom-vars.json");
    expect(call.cliTemplateVarArgs).toEqual(["env=prod"]);
    expect(call.workerCommand).toEqual(["opencode", "run"]);
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

  it("defaults plan scan count to 1", async () => {
    const planTask = vi.fn(async () => 0);
    const call = await invokePlanAndCaptureCall([
      "plan",
      "tasks.md",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(call.scanCount).toBe(1);
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

  it("rejects deprecated --at option for plan with migration guidance", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--at",
      "tasks.md:12",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--at option is no longer supported for `plan`"));
  });

  it("emits stable deprecation output and exits with code 1 for --at", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await invokePlanAndCaptureExitCode([
      "plan",
      "tasks.md",
      "--at",
      "tasks.md:12",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(stripAnsi(String(errorSpy.mock.calls[0]?.[0] ?? ""))).toBe(
      "✖ Error: The --at option is no longer supported for `plan`. `plan` now operates on the entire <markdown-file>. Remove --at and pass the target document as the command argument.",
    );
  });

  it("rejects deprecated --at option for plan even when empty", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--at",
      "",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--at option is no longer supported for `plan`"));
  });

  it("rejects deprecated --sort option for plan", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--sort",
      "none",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--sort option is no longer supported for `plan`"));
  });

  it("emits stable deprecation output and exits with code 1 for --sort", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const exitCode = await invokePlanAndCaptureExitCode([
      "plan",
      "tasks.md",
      "--sort",
      "none",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(stripAnsi(String(errorSpy.mock.calls[0]?.[0] ?? ""))).toBe(
      "✖ Error: The --sort option is no longer supported for `plan`. Planning no longer selects a task from multiple files. Remove --sort and pass only the target <markdown-file>.",
    );
  });

  it("rejects deprecated --sort option for plan even when empty", async () => {
    const planTask = vi.fn(async () => 0);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await invokePlanAndExpectExit([
      "plan",
      "tasks.md",
      "--sort",
      "",
      "--worker",
      "opencode",
      "run",
    ], planTask);

    expect(planTask).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--sort option is no longer supported for `plan`"));
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
    if (!/CLI exited with code \d+/.test(message)) {
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
    if (/CLI exited with code \d+/.test(message)) {
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
    if (/CLI exited with code \d+/.test(message)) {
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

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}
