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
    expect(call.noRepair).toBe(false);
    expect(call.repairAttempts).toBe(1);
    expect(call.forceExecute).toBe(false);
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
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.commitAfterComplete).toBe(true);
    expect(call.commitMessageTemplate).toBeUndefined();
    expect(call.onCompleteCommand).toBeUndefined();
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
      "--worker",
      "opencode",
      "run",
    ], runTask);

    expect(call.commitAfterComplete).toBe(true);
    expect(call.commitMessageTemplate).toBe("done: {{task}}");
    expect(call.onCompleteCommand).toBe("node scripts/after.js");
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
    expect(call.transport).toBe("arg");
    expect(call.repairAttempts).toBe(2);
    expect(call.noRepair).toBe(true);
    expect(call.dryRun).toBe(true);
    expect(call.printPrompt).toBe(true);
    expect(call.keepArtifacts).toBe(true);
    expect(call.workerCommand).toEqual(["opencode", "run"]);
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
