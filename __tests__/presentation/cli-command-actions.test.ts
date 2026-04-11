import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../../src/domain/exit-codes.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";
import {
  createHelpCommandAction,
  createLoopCommandAction,
  createQueryCommandAction,
} from "../../src/presentation/cli-command-actions.js";
import type { CliApp } from "../../src/presentation/cli-app-init.js";
import * as sleepModule from "../../src/infrastructure/cancellable-sleep.js";

type RunTaskRequest = Record<string, unknown>;
type RunTaskFn = (request: RunTaskRequest) => Promise<number>;
type CliOpts = Record<string, string | string[] | boolean>;

interface LoopHarness {
  action: ReturnType<typeof createLoopCommandAction>;
  runTask: ReturnType<typeof vi.fn<RunTaskFn>>;
  emitOutput: ReturnType<typeof vi.fn<(event: ApplicationOutputEvent) => void>>;
  releaseAllLocks: ReturnType<typeof vi.fn<() => void>>;
  outputEvents: ApplicationOutputEvent[];
  setLoopSignalExitCode: ReturnType<typeof vi.fn<(code: number) => void>>;
}

function createLoopHarness(runTaskImpl: RunTaskFn = async () => 0): LoopHarness {
  const outputEvents: ApplicationOutputEvent[] = [];
  const runTask = vi.fn<RunTaskFn>(runTaskImpl);
  const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>((event) => {
    outputEvents.push(event);
  });
  const releaseAllLocks = vi.fn<() => void>();
  const setLoopSignalExitCode = vi.fn<(code: number) => void>();
  const app = {
    runTask,
    emitOutput,
    releaseAllLocks,
  } as unknown as CliApp;

  const action = createLoopCommandAction({
    getApp: () => app,
    getWorkerFromSeparator: () => undefined,
    runnerModes: ["wait", "tui"],
    setLoopSignalExitCode,
  });

  return {
    action,
    runTask,
    emitOutput,
    releaseAllLocks,
    outputEvents,
    setLoopSignalExitCode,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("createLoopCommandAction", () => {
  it("runs exactly --iterations full call-style passes", async () => {
    const { action, runTask, releaseAllLocks } = createLoopHarness(async () => 0);

    const exitCode = await action("tasks.md", {
      worker: "opencode run",
      iterations: "3",
      cooldown: "0",
    });

    expect(exitCode).toBe(0);
    expect(runTask).toHaveBeenCalledTimes(3);
    expect(releaseAllLocks).toHaveBeenCalledTimes(3);
    expect(runTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source: "tasks.md",
      runAll: true,
      clean: true,
      redo: true,
      resetAfter: true,
      cacheCliBlocks: true,
    }));
    expect(runTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source: "tasks.md",
      runAll: true,
      clean: true,
      redo: true,
      resetAfter: true,
      cacheCliBlocks: true,
    }));
    expect(runTask).toHaveBeenNthCalledWith(3, expect.objectContaining({
      source: "tasks.md",
      runAll: true,
      clean: true,
      redo: true,
      resetAfter: true,
      cacheCliBlocks: true,
    }));
  });

  it("waits for the configured cooldown between iterations", async () => {
    vi.useFakeTimers();
    const { action, runTask, outputEvents } = createLoopHarness(async () => 0);

    const completion = Promise.resolve(action("tasks.md", {
      worker: "opencode run",
      iterations: "2",
      cooldown: "2",
    }));

    let settled = false;
    void completion.then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    await completion;

    expect(runTask).toHaveBeenCalledTimes(2);
    const cooldownMessages = outputEvents
      .filter((event) => event.kind === "info")
      .map((event) => {
        if ("message" in event) {
          return event.message;
        }
        return "";
      })
      .filter((message) => message.startsWith("Loop cooldown:"));
    expect(cooldownMessages).toEqual([
      "Loop cooldown: 2s remaining before iteration 2.",
      "Loop cooldown: 1s remaining before iteration 2.",
    ]);
  });

  it("continues on failed iterations when --continue-on-error is enabled", async () => {
    const { action, runTask, outputEvents } = createLoopHarness(
      vi
        .fn<RunTaskFn>()
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(0),
    );

    const exitCode = await action("tasks.md", {
      worker: "opencode run",
      iterations: "2",
      cooldown: "0",
      continueOnError: true,
    });

    expect(exitCode).toBe(0);
    expect(runTask).toHaveBeenCalledTimes(2);
    expect(outputEvents).toContainEqual({
      kind: "warn",
      message: "Loop iteration 1 failed with exit code 2; starting next iteration immediately.",
    });
  });

  it("stops gracefully on SIGINT during cooldown", async () => {
    const sleepSpy = vi.spyOn(sleepModule, "cancellableSleep").mockImplementation(() => {
      process.emit("SIGINT");
      return {
        promise: Promise.resolve(),
        cancel: () => {},
      };
    });

    const { action, runTask, setLoopSignalExitCode } = createLoopHarness(async () => 0);

    const exitCode = await action("tasks.md", {
      worker: "opencode run",
      cooldown: "5",
    });

    expect(exitCode).toBe(0);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(setLoopSignalExitCode).toHaveBeenCalledWith(0);
    expect(sleepSpy).toHaveBeenCalled();
  });
});

describe("createHelpCommandAction", () => {
  it("forwards --trace to helpTask on root interactive invocation", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => true,
      getInvocationArgv: () => ["--trace"],
    });

    const exitCode = await action();

    expect(exitCode).toBe(0);
    expect(helpTask).toHaveBeenCalledTimes(1);
    expect(helpTask).toHaveBeenCalledWith(expect.objectContaining({
      trace: true,
      cliVersion: "1.2.3",
    }));
    expect(outputHelp).not.toHaveBeenCalled();
  });

  it("falls back to static help when terminal is non-interactive", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => false,
      getInvocationArgv: () => [],
    });

    const exitCode = await action();

    expect(exitCode).toBe(EXIT_CODE_SUCCESS);
    expect(helpTask).not.toHaveBeenCalled();
    expect(outputHelp).toHaveBeenCalledTimes(1);
  });

  it("falls back to static help when no worker is available", async () => {
    const helpTask = vi.fn(async () => EXIT_CODE_NO_WORK);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => true,
      getInvocationArgv: () => [],
    });

    const exitCode = await action();

    expect(exitCode).toBe(EXIT_CODE_SUCCESS);
    expect(helpTask).toHaveBeenCalledTimes(1);
    expect(outputHelp).toHaveBeenCalledTimes(1);
  });

  it("falls back to static help when helpTask throws", async () => {
    const helpTask = vi.fn(async () => {
      throw new Error("worker failed");
    });
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => true,
      getInvocationArgv: () => [],
    });

    const exitCode = await action();

    expect(exitCode).toBe(EXIT_CODE_SUCCESS);
    expect(helpTask).toHaveBeenCalledTimes(1);
    expect(outputHelp).toHaveBeenCalledTimes(1);
  });
});

describe("createQueryCommandAction", () => {
  it("forwards --skip-research and normalized options to queryTask", async () => {
    const queryTask = vi.fn(async () => 0);
    const app = { queryTask } as unknown as CliApp;
    const action = createQueryCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      queryModes: ["wait"],
    });

    const exitCode = await action("check auth flow", {
      dir: "./src",
      format: "markdown",
      output: "./result.md",
      skipResearch: true,
      mode: "wait",
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      trace: false,
      forceUnlock: false,
      ignoreCliBlock: false,
      worker: "opencode run",
      var: ["custom=value"],
    });

    expect(exitCode).toBe(0);
    expect(queryTask).toHaveBeenCalledTimes(1);
    expect(queryTask).toHaveBeenCalledWith(expect.objectContaining({
      queryText: "check auth flow",
      dir: path.resolve("./src"),
      format: "markdown",
      output: "./result.md",
      skipResearch: true,
      mode: "wait",
      cliTemplateVarArgs: ["custom=value"],
    }));
  });
});
