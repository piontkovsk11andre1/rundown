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
});

async function invokeRunAndCaptureCall(args: string[], runTask: ReturnType<typeof vi.fn>): Promise<RunTaskCall> {
  const previousEnv = captureEnv();

  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.doMock("../../src/create-app.js", () => ({
    createApp: () => ({
      runTask,
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
