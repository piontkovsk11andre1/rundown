import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
  EXIT_CODE_VERIFICATION_FAILURE,
} from "../../src/domain/exit-codes.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";
import {
  createAddCommandAction,
  createWithCommandAction,
  createDesignDiffCommandAction,
  createDesignReleaseCommandAction,
  createDoCommandAction,
  createDocsDiffCommandAction,
  createDocsPublishCommandAction,
  createDocsReleaseCommandAction,
  createDocsSaveCommandAction,
  createHelpCommandAction,
  createLoopCommandAction,
  createMigrateCommandAction,
  createMaterializeCommandAction,
  createMakeCommandAction,
  createPlanCommandAction,
  createQueryCommandAction,
  createReverifyCommandAction,
  createRunCommandAction,
  createStartCommandAction,
  createWorkspaceRemoveCommandAction,
  createWorkspaceUnlinkCommandAction,
  createWorkerHealthCommandAction,
} from "../../src/presentation/cli-command-actions.js";
import type { CliApp } from "../../src/presentation/cli-app-init.js";
import * as sleepModule from "../../src/infrastructure/cancellable-sleep.js";
import { DEFAULT_AGENTS_TEMPLATE } from "../../src/domain/agents-template.js";

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

  it("throttles cooldown status for long waits", async () => {
    vi.useFakeTimers();
    const { action, runTask, outputEvents } = createLoopHarness(async () => 0);

    const completion = Promise.resolve(action("tasks.md", {
      worker: "opencode run",
      iterations: "2",
      cooldown: "12",
    }));

    await Promise.resolve();
    expect(runTask).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(12_000);
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
      "Loop cooldown: 12s remaining before iteration 2.",
      "Loop cooldown: 10s remaining before iteration 2.",
      "Loop cooldown: 9s remaining before iteration 2.",
      "Loop cooldown: 8s remaining before iteration 2.",
      "Loop cooldown: 7s remaining before iteration 2.",
      "Loop cooldown: 6s remaining before iteration 2.",
      "Loop cooldown: 5s remaining before iteration 2.",
      "Loop cooldown: 4s remaining before iteration 2.",
      "Loop cooldown: 3s remaining before iteration 2.",
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

  it("breaks loop immediately when run task surfaces terminal stop", async () => {
    const { action, runTask, outputEvents, setLoopSignalExitCode } = createLoopHarness(
      vi
        .fn<RunTaskFn>()
        .mockImplementationOnce(async (request) => {
          const onTerminalStop = request.onTerminalStop as ((signal: {
            requestedBy: "exit";
            mode: "unconditional";
            reason: string;
            stopRun: boolean;
            stopLoop: boolean;
            exitCode: number;
          }) => void) | undefined;
          onTerminalStop?.({
            requestedBy: "exit",
            mode: "unconditional",
            reason: "terminal stop requested",
            stopRun: true,
            stopLoop: false,
            exitCode: 0,
          });
          return 0;
        })
        .mockResolvedValueOnce(0),
    );

    const exitCode = await action("tasks.md", {
      worker: "opencode run",
      iterations: "3",
      cooldown: "0",
      continueOnError: true,
    });

    expect(exitCode).toBe(0);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(setLoopSignalExitCode).toHaveBeenCalledWith(0);
    expect(outputEvents).toContainEqual({
      kind: "info",
      message: "Loop iteration 1 requested terminal stop; ending loop.",
    });
  });
});

describe("createHelpCommandAction", () => {
  it("prints AGENTS template and skips help worker when --agents is provided", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      return typeof chunk === "string" && chunk === DEFAULT_AGENTS_TEMPLATE;
    }) as typeof process.stdout.write);

    try {
      const action = createHelpCommandAction({
        getApp: () => app,
        getWorkerFromSeparator: () => undefined,
        outputHelp,
        cliVersion: "1.2.3",
        isInteractiveTerminal: () => true,
        getInvocationArgv: () => ["--agents"],
      });

      const exitCode = await action();

      expect(exitCode).toBe(EXIT_CODE_SUCCESS);
      expect(stdoutSpy).toHaveBeenCalledWith(DEFAULT_AGENTS_TEMPLATE);
      expect(helpTask).not.toHaveBeenCalled();
      expect(outputHelp).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it("keeps --agents authoritative when continuation flags are present", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      return typeof chunk === "string" && chunk === DEFAULT_AGENTS_TEMPLATE;
    }) as typeof process.stdout.write);

    try {
      const action = createHelpCommandAction({
        getApp: () => app,
        getWorkerFromSeparator: () => ["opencode", "run"],
        outputHelp,
        cliVersion: "1.2.3",
        isInteractiveTerminal: () => true,
        getInvocationArgv: () => ["--continue", "--agents", "--", "opencode", "run"],
      });

      const exitCode = await action();

      expect(exitCode).toBe(EXIT_CODE_SUCCESS);
      expect(stdoutSpy).toHaveBeenCalledWith(DEFAULT_AGENTS_TEMPLATE);
      expect(helpTask).not.toHaveBeenCalled();
      expect(outputHelp).not.toHaveBeenCalled();
    } finally {
      stdoutSpy.mockRestore();
    }
  });

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

  it("forwards root continuation flag as canonical --continue worker arg", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => ["opencode", "run"],
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => true,
      getInvocationArgv: () => ["-c", "--", "opencode", "run"],
    });

    const exitCode = await action();

    expect(exitCode).toBe(0);
    expect(helpTask).toHaveBeenCalledTimes(1);
    expect(helpTask).toHaveBeenCalledWith(expect.objectContaining({
      continueSession: true,
      workerPattern: expect.objectContaining({
        command: ["opencode", "run", "--continue"],
      }),
    }));
    expect(outputHelp).not.toHaveBeenCalled();
  });

  it("forwards long-form root continuation flag as canonical --continue worker arg", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => ["opencode", "run", "--profile", "fast"],
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => true,
      getInvocationArgv: () => ["--continue", "--", "opencode", "run", "--profile", "fast"],
    });

    const exitCode = await action();

    expect(exitCode).toBe(0);
    expect(helpTask).toHaveBeenCalledTimes(1);
    expect(helpTask).toHaveBeenCalledWith(expect.objectContaining({
      continueSession: true,
      workerPattern: expect.objectContaining({
        command: ["opencode", "run", "--profile", "fast", "--continue"],
      }),
    }));
    expect(outputHelp).not.toHaveBeenCalled();
  });

  it("does not duplicate continuation passed through separator worker args", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => ["opencode", "run", "-c", "--profile", "fast"],
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => true,
      getInvocationArgv: () => ["--continue", "--", "opencode", "run", "-c", "--profile", "fast"],
    });

    const exitCode = await action();

    expect(exitCode).toBe(0);
    expect(helpTask).toHaveBeenCalledTimes(1);
    expect(helpTask).toHaveBeenCalledWith(expect.objectContaining({
      continueSession: true,
      workerPattern: expect.objectContaining({
        command: ["opencode", "run", "-c", "--profile", "fast"],
      }),
    }));
    expect(outputHelp).not.toHaveBeenCalled();
  });

  it("keeps continuation forwarding idempotent when both root flags are provided", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => ["opencode", "run", "--continue", "--profile", "fast"],
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => true,
      getInvocationArgv: () => ["-c", "--continue", "--", "opencode", "run", "--continue", "--profile", "fast"],
    });

    const exitCode = await action();

    expect(exitCode).toBe(0);
    expect(helpTask).toHaveBeenCalledTimes(1);
    expect(helpTask).toHaveBeenCalledWith(expect.objectContaining({
      continueSession: true,
      workerPattern: expect.objectContaining({
        command: ["opencode", "run", "--continue", "--profile", "fast"],
      }),
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

  it("keeps non-interactive static help fallback when continuation flags are present", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => ["opencode", "run"],
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => false,
      getInvocationArgv: () => ["-c", "--", "opencode", "run"],
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

  it("returns static help for non-root command invocation", async () => {
    const helpTask = vi.fn(async () => 0);
    const app = { helpTask } as unknown as CliApp;
    const outputHelp = vi.fn();

    const action = createHelpCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      outputHelp,
      cliVersion: "1.2.3",
      isInteractiveTerminal: () => true,
      getInvocationArgv: () => ["run", "tasks.md"],
    });

    const exitCode = await action();

    expect(exitCode).toBe(EXIT_CODE_SUCCESS);
    expect(helpTask).not.toHaveBeenCalled();
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
      cwd: expect.any(String),
      invocationDir: expect.any(String),
      workspaceDir: expect.any(String),
      workspaceLinkPath: expect.any(String),
      isLinkedWorkspace: expect.any(Boolean),
      format: "markdown",
      output: "./result.md",
      skipResearch: true,
      mode: "wait",
      cliTemplateVarArgs: ["custom=value"],
    }));
  });
});

describe("createPlanCommandAction", () => {
  it("forwards --loop and normalized options to planTask", async () => {
    const planTask = vi.fn(async () => 0);
    const app = { planTask } as unknown as CliApp;
    const action = createPlanCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      plannerModes: ["wait"],
    });

    const exitCode = await action(["roadmap.md"], {
      loop: true,
      scanCount: "4",
      maxItems: "7",
      deep: "2",
      mode: "wait",
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      trace: false,
      forceUnlock: false,
      ignoreCliBlock: false,
      var: ["foo=bar"],
    });

    expect(exitCode).toBe(0);
    expect(planTask).toHaveBeenCalledTimes(1);
    expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "roadmap.md",
      scanCount: 4,
      maxItems: 7,
      deep: 2,
      loop: true,
      mode: "wait",
      cliTemplateVarArgs: ["foo=bar"],
    }));
  });

  it("defaults loop mode to false when --loop is omitted", async () => {
    const planTask = vi.fn(async () => 0);
    const app = { planTask } as unknown as CliApp;
    const action = createPlanCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      plannerModes: ["wait"],
    });

    const exitCode = await action(["roadmap.md"], {
      mode: "wait",
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      trace: false,
      forceUnlock: false,
      ignoreCliBlock: false,
    });

    expect(exitCode).toBe(0);
    expect(planTask).toHaveBeenCalledTimes(1);
    expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "roadmap.md",
      loop: false,
    }));
  });
});

describe("createMakeCommandAction", () => {
  it("returns non-zero when seed file creation fails before bootstrap phases", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-create-fail-"));
    const missingParent = path.join(tempRoot, "missing");
    const targetFile = path.join(missingParent, "seed.md");

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      await expect(action("seed", targetFile, { skipResearch: true }))
        .rejects
        .toThrow("Parent directory does not exist");
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns non-zero when plan fails in default make flow", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-plan-fail-default-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 2);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const exitCode = await action("seed", targetFile, {});

      expect(exitCode).toBe(2);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("returns non-zero when plan fails in skip-research make flow", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-plan-fail-skip-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 2);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const exitCode = await action("seed", targetFile, { skipResearch: true });

      expect(exitCode).toBe(2);
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("normalizes skip flags and bypasses research for make bootstrap", async () => {
    const scenarios: Array<{ label: string; opts: CliOpts }> = [
      { label: "--skip-research", opts: { skipResearch: true } },
      { label: "--raw alias", opts: { raw: true } },
      { label: "both skip flags", opts: { skipResearch: true, raw: true } },
    ];

    for (const scenario of scenarios) {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `rundown-make-skip-normalized-${scenario.label.replace(/\s+/g, "-")}-`));
      const targetFile = path.join(tempRoot, "migrations", "seed.md");
      fs.mkdirSync(path.dirname(targetFile), { recursive: true });

      const researchTask = vi.fn(async () => 0);
      const planTask = vi.fn(async () => 0);
      const app = { researchTask, planTask } as unknown as CliApp;
      const action = createMakeCommandAction({
        getApp: () => app,
        getWorkerFromSeparator: () => undefined,
        makeModes: ["wait"],
      });

      try {
        const exitCode = await action("seed", targetFile, scenario.opts);

        expect(exitCode).toBe(0);
        expect(researchTask).not.toHaveBeenCalled();
        expect(planTask).toHaveBeenCalledTimes(1);
        expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
          source: targetFile,
        }));
      } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it("emits skip-research phase messaging and starts from planning", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-skip-message-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const app = { researchTask, planTask, emitOutput } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const exitCode = await action("seed", targetFile, { skipResearch: true });

      expect(exitCode).toBe(0);
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Make phase 1/2 skipped: research" });
      expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Make transition: start from planning (--skip-research/--raw)" });
      expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Make phase 2/2: plan" });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("treats --raw as skip-research alias with the same phase messaging", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-raw-message-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const app = { researchTask, planTask, emitOutput } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const exitCode = await action("seed", targetFile, { raw: true });

      expect(exitCode).toBe(0);
      expect(researchTask).not.toHaveBeenCalled();
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Make phase 1/2 skipped: research" });
      expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Make transition: start from planning (--skip-research/--raw)" });
      expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Make phase 2/2: plan" });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("createAddCommandAction", () => {
  it("appends seed text with a blank-line boundary before running plan", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-add-append-boundary-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "# Existing\n- item", "utf8");

    const planTask = vi.fn(async () => 0);
    const app = { planTask } as unknown as CliApp;
    const action = createAddCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      addModes: ["wait"],
    });

    try {
      const exitCode = await action("New seed", targetFile, {});

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe("# Existing\n- item\n\nNew seed");
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
        source: targetFile,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reuses an existing trailing blank line boundary without adding extra newlines", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-add-existing-boundary-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "# Existing\n\n", "utf8");

    const planTask = vi.fn(async () => 0);
    const app = { planTask } as unknown as CliApp;
    const action = createAddCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      addModes: ["wait"],
    });

    try {
      const exitCode = await action("New seed", targetFile, {});

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe("# Existing\n\nNew seed");
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not run plan when append fails", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-add-missing-after-validate-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, "# Existing", "utf8");

    const planTask = vi.fn(async () => 0);
    const app = { planTask } as unknown as CliApp;
    const action = createAddCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      addModes: ["wait"],
    });

    const appendSpy = vi.spyOn(fs, "appendFileSync").mockImplementation(() => {
      const error = Object.assign(new Error("simulated ENOENT"), { code: "ENOENT" });
      throw error;
    });

    try {
      await expect(action("New seed", targetFile, {})).rejects.toThrow("Cannot append add document");
      expect(planTask).not.toHaveBeenCalled();
    } finally {
      appendSpy.mockRestore();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("bootstrap seed prefix resolution", () => {
  it("keeps plain non-prefixed seed text unchanged in make", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-plain-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const seedText = "Capture migration scope and acceptance criteria";
      const exitCode = await action(seedText, targetFile, {});

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe(seedText);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("expands bootstrap-applicable template tool prefixes in make seed text", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-prefix-"));
    const configDir = path.join(tempRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const targetFile = path.join(tempRoot, "migrations", "seed.md");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "brief.md"), "# Brief\n\n{{payload}}\n", "utf8");

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const exitCode = await action("brief: Capture migration scope", targetFile, {
        configDir,
      });

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe("# Brief\n\nCapture migration scope\n");
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps unknown prefixes as raw seed text in make", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-unknown-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const seedText = "unknown-prefix: keep this literal";
      const exitCode = await action(seedText, targetFile, {});

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe(seedText);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps malformed prefix expressions as raw seed text in make", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-malformed-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const seedText = "profile: fast, verify: run full suite";
      const exitCode = await action(seedText, targetFile, {});

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe(seedText);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("falls back to raw seed for non-applicable builtin handler prefixes", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-non-applicable-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const seedText = "parallel: verify: smoke checks";
      const exitCode = await action(seedText, targetFile, {});

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe(seedText);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("supports profile modifier in bootstrap prefix chains", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-profile-"));
    const configDir = path.join(tempRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const targetFile = path.join(tempRoot, "migrations", "seed.md");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "brief.md"), "{{profile}}|{{payload}}", "utf8");

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const exitCode = await action("profile=fast, brief: Build release checklist", targetFile, {
        configDir,
      });

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe("fast|Build release checklist");
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps unsupported modifier chains as raw seed text in make", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-unsupported-modifier-"));
    const configDir = path.join(tempRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const targetFile = path.join(tempRoot, "migrations", "seed.md");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "brief.md"), "{{payload}}", "utf8");

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const seedText = "force: 2, brief: Build release checklist";
      const exitCode = await action(seedText, targetFile, {
        configDir,
      });

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe(seedText);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps raw seed text when profile modifier has no applicable handler", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-make-seed-profile-only-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const app = { researchTask, planTask } as unknown as CliApp;
    const action = createMakeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
    });

    try {
      const seedText = "profile=fast";
      const exitCode = await action(seedText, targetFile, {});

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe(seedText);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("reuses the same seed-prefix bootstrap behavior in do", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-seed-prefix-"));
    const configDir = path.join(tempRoot, ".rundown");
    const toolsDir = path.join(configDir, "tools");
    const targetFile = path.join(tempRoot, "migrations", "seed.md");

    fs.mkdirSync(toolsDir, { recursive: true });
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(path.join(toolsDir, "brief.md"), "# Do\n\n{{payload}}\n", "utf8");

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const app = { researchTask, planTask, runTask } as unknown as CliApp;
    const action = createDoCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
      getInvocationArgv: () => ["do"],
    });

    try {
      const exitCode = await action("brief: Execute release rollout", targetFile, {
        configDir,
      });

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe("# Do\n\nExecute release rollout\n");
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps plain non-prefixed seed text unchanged in do", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-do-seed-plain-"));
    const targetFile = path.join(tempRoot, "migrations", "seed.md");
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });

    const researchTask = vi.fn(async () => 0);
    const planTask = vi.fn(async () => 0);
    const runTask = vi.fn(async () => 0);
    const app = { researchTask, planTask, runTask } as unknown as CliApp;
    const action = createDoCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      makeModes: ["wait"],
      getInvocationArgv: () => ["do"],
    });

    try {
      const seedText = "Run rollout preparation checklist";
      const exitCode = await action(seedText, targetFile, {});

      expect(exitCode).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe(seedText);
      expect(researchTask).toHaveBeenCalledTimes(1);
      expect(planTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("verification exit code propagation", () => {
  it("returns verification exit code from run command action", async () => {
    const runTask = vi.fn(async () => EXIT_CODE_VERIFICATION_FAILURE);
    const app = { runTask } as unknown as CliApp;
    const action = createRunCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      runnerModes: ["wait"],
    });

    const exitCode = await action("tasks.md", {
      mode: "wait",
      sort: "name-sort",
      verify: true,
      onlyVerify: false,
      forceExecute: false,
      forceAttempts: "2",
      noRepair: false,
      repairAttempts: "2",
      resolveRepairAttempts: "1",
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      trace: false,
      traceStats: false,
      traceOnly: false,
      varsFile: false,
      var: [],
      commit: false,
      commitMode: "per-task",
      showAgentOutput: false,
      all: false,
      redo: false,
      resetAfter: false,
      clean: false,
      forceUnlock: false,
      ignoreCliBlock: false,
      cacheCliBlocks: false,
      verbose: false,
      worker: "opencode run",
    });

    expect(exitCode).toBe(EXIT_CODE_VERIFICATION_FAILURE);
  });

  it("returns verification exit code from reverify command action", async () => {
    const reverifyTask = vi.fn(async () => EXIT_CODE_VERIFICATION_FAILURE);
    const app = { reverifyTask } as unknown as CliApp;
    const action = createReverifyCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
    });

    const exitCode = await action({
      run: "latest",
      repairAttempts: "2",
      resolveRepairAttempts: "1",
      noRepair: false,
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      trace: false,
      ignoreCliBlock: false,
      var: [],
      showAgentOutput: false,
      verbose: false,
      worker: "opencode run",
    });

    expect(exitCode).toBe(EXIT_CODE_VERIFICATION_FAILURE);
  });
});

describe("createMaterializeCommandAction", () => {
  it("matches run --all --revertable core action fields", async () => {
    const runViaRunTask = vi.fn(async (_request: Record<string, unknown>) => 0);
    const runViaMaterializeTask = vi.fn(async (_request: Record<string, unknown>) => 0);
    const runApp = { runTask: runViaRunTask } as unknown as CliApp;
    const materializeApp = { runTask: runViaMaterializeTask } as unknown as CliApp;

    const runAction = createRunCommandAction({
      getApp: () => runApp,
      getWorkerFromSeparator: () => undefined,
      runnerModes: ["wait", "tui", "detached"],
      getInvocationArgv: () => ["run", "tasks.md", "--all", "--revertable"],
    });
    const materializeAction = createMaterializeCommandAction({
      getApp: () => materializeApp,
      getWorkerFromSeparator: () => undefined,
      runnerModes: ["wait", "tui", "detached"],
      getInvocationArgv: () => ["materialize", "tasks.md"],
    });

    await runAction("tasks.md", {
      all: true,
      revertable: true,
      worker: "opencode run",
    });
    await materializeAction("tasks.md", {
      worker: "opencode run",
    });

    expect(runViaRunTask).toHaveBeenCalledTimes(1);
    expect(runViaMaterializeTask).toHaveBeenCalledTimes(1);

    const runRequest = runViaRunTask.mock.calls[0][0];
    const materializeRequest = runViaMaterializeTask.mock.calls[0][0];

    expect(materializeRequest).toEqual(expect.objectContaining({
      runAll: runRequest.runAll,
      commitAfterComplete: runRequest.commitAfterComplete,
      keepArtifacts: runRequest.keepArtifacts,
    }));
    expect(materializeRequest).toEqual(expect.objectContaining({
      runAll: true,
      commitAfterComplete: true,
      keepArtifacts: true,
    }));
  });

  it("enforces run --all --revertable semantics", async () => {
    const runTask = vi.fn(async () => 0);
    const app = { runTask } as unknown as CliApp;
    const action = createMaterializeCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      runnerModes: ["wait", "tui", "detached"],
    });

    const exitCode = await action("tasks.md", {
      worker: "opencode run",
    });

    expect(exitCode).toBe(0);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "tasks.md",
      runAll: true,
      keepArtifacts: true,
      commitAfterComplete: true,
    }));
  });

  it("injects --revertable before worker separator for config-aware defaults", async () => {
    const runTask = vi.fn(async () => 0);
    const app = { runTask } as unknown as CliApp;
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-materialize-argv-"));
    const configDir = path.join(tempRoot, ".rundown");

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({
      run: {
        revertable: false,
        commit: false,
      },
    }, null, 2) + "\n", "utf8");

    try {
      const action = createMaterializeCommandAction({
        getApp: () => app,
        getWorkerFromSeparator: () => ["opencode", "run"],
        runnerModes: ["wait", "tui", "detached"],
        getInvocationArgv: () => [
          "--config-dir",
          configDir,
          "materialize",
          "tasks.md",
          "--",
          "opencode",
          "run",
        ],
      });

      const exitCode = await action("tasks.md", {});

      expect(exitCode).toBe(0);
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
        source: "tasks.md",
        runAll: true,
        keepArtifacts: true,
        commitAfterComplete: true,
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("preserves explicit commit CLI overrides while forcing materialize defaults", async () => {
    const runTask = vi.fn(async () => 0);
    const app = { runTask } as unknown as CliApp;
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
    }, null, 2) + "\n", "utf8");

    try {
      const action = createMaterializeCommandAction({
        getApp: () => app,
        getWorkerFromSeparator: () => ["opencode", "run"],
        runnerModes: ["wait", "tui", "detached"],
        getInvocationArgv: () => [
          "--config-dir",
          configDir,
          "materialize",
          "tasks.md",
          "--commit-mode",
          "per-task",
          "--commit-message",
          "cli: {{task}}",
          "--",
          "opencode",
          "run",
        ],
      });

      const exitCode = await action("tasks.md", {
        commitMode: "per-task",
        commitMessage: "cli: {{task}}",
      });

      expect(exitCode).toBe(0);
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
        source: "tasks.md",
        runAll: true,
        keepArtifacts: true,
        commitAfterComplete: true,
        commitMode: "per-task",
        commitMessageTemplate: "cli: {{task}}",
      }));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("createWorkerHealthCommandAction", () => {
  it("forwards --json to viewWorkerHealthStatus", () => {
    const viewWorkerHealthStatus = vi.fn(() => 0);
    const app = { viewWorkerHealthStatus } as unknown as CliApp;
    const action = createWorkerHealthCommandAction({
      getApp: () => app,
    });

    const exitCode = action({ json: true });

    expect(exitCode).toBe(0);
    expect(viewWorkerHealthStatus).toHaveBeenCalledTimes(1);
    expect(viewWorkerHealthStatus).toHaveBeenCalledWith({ json: true });
  });
});

describe("createWithCommandAction", () => {
  it("forwards harness argument to withTask, renders output, then starts discuss tui", async () => {
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const discussTask = vi.fn(async () => 0);
    const withTask = vi.fn(async () => ({
      exitCode: 0,
      harnessKey: "opencode",
      source: "preset" as const,
      changed: true,
      configPath: "/workspace/.rundown/config.json",
      configuredKeys: [
        {
          keyPath: "workers.default",
          status: "set",
          value: ["opencode", "run", "--file", "$file", "$bootstrap"],
        },
        {
          keyPath: "workers.tui",
          status: "set",
          value: ["opencode"],
        },
        {
          keyPath: "commands.discuss",
          status: "set",
          value: ["opencode"],
        },
        {
          keyPath: "workers.fallbacks",
          status: "preserved",
        },
      ] as const,
    }));
    const app = { withTask, discussTask } as unknown as CliApp;
    (app as unknown as { emitOutput: typeof emitOutput }).emitOutput = emitOutput;
    const action = createWithCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      isInteractiveTerminal: () => true,
    });

    const exitCode = await action("opencode");

    expect(exitCode).toBe(0);
    expect(withTask).toHaveBeenCalledTimes(1);
    expect(withTask).toHaveBeenCalledWith({ harness: "opencode" });
    expect(discussTask).toHaveBeenCalledTimes(1);
    expect(discussTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "",
      mode: "tui",
      sortMode: "name-sort",
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      showAgentOutput: false,
      trace: false,
      forceUnlock: false,
      ignoreCliBlock: false,
      verbose: false,
      workerPattern: expect.objectContaining({
        command: [],
      }),
    }));
    expect(emitOutput).toHaveBeenCalledWith({ kind: "success", message: "Applied harness preset: opencode" });
    expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Path: /workspace/.rundown/config.json" });
    expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Configured keys:" });
    expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Starting interactive discuss session..." });
    expect(emitOutput).toHaveBeenCalledWith({
      kind: "info",
      message: "- workers.default = [\"opencode\",\"run\",\"--file\",\"$file\",\"$bootstrap\"]",
    });
  });

  it("warns and reports custom source when unknown harness is configured interactively", async () => {
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const withTask = vi.fn(async () => ({
      exitCode: 0,
      harnessKey: "mytool",
      source: "custom" as const,
      changed: true,
      configPath: "/workspace/.rundown/config.json",
      configuredKeys: [
        {
          keyPath: "workers.default" as const,
          status: "set" as const,
          value: ["mytool", "run", "--file", "$file", "$bootstrap"],
        },
        {
          keyPath: "workers.tui" as const,
          status: "removed" as const,
        },
        {
          keyPath: "commands.discuss" as const,
          status: "removed" as const,
        },
        {
          keyPath: "workers.fallbacks" as const,
          status: "preserved" as const,
        },
      ],
    }));

    const discussTask = vi.fn(async () => 0);
    const app = { withTask, discussTask } as unknown as CliApp;
    (app as unknown as { emitOutput: typeof emitOutput }).emitOutput = emitOutput;
    const action = createWithCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      isInteractiveTerminal: () => true,
    });

    const exitCode = await action("mytool");

    expect(exitCode).toBe(0);
    expect(withTask).toHaveBeenCalledWith({ harness: "mytool" });
    expect(emitOutput).toHaveBeenCalledWith({
      kind: "warn",
      message: "Harness \"mytool\" is not in the preset registry. Saved custom invocation mapping.",
    });
    expect(emitOutput).toHaveBeenCalledWith({
      kind: "success",
      message: "Applied custom harness mapping: mytool",
    });
    expect(discussTask).not.toHaveBeenCalled();
  });

  it("starts discuss tui even when opencode preset application is a no-op", async () => {
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const discussTask = vi.fn(async () => 0);
    const withTask = vi.fn(async () => ({
      exitCode: 0,
      harnessKey: "opencode",
      source: "preset" as const,
      changed: false,
      configPath: "/workspace/.rundown/config.json",
      configuredKeys: [
        {
          keyPath: "workers.default" as const,
          status: "set" as const,
          value: ["opencode", "run", "--file", "$file", "$bootstrap"],
        },
        {
          keyPath: "workers.tui" as const,
          status: "set" as const,
          value: ["opencode"],
        },
        {
          keyPath: "commands.discuss" as const,
          status: "set" as const,
          value: ["opencode"],
        },
        {
          keyPath: "workers.fallbacks" as const,
          status: "preserved" as const,
        },
      ],
    }));

    const app = { withTask, discussTask } as unknown as CliApp;
    (app as unknown as { emitOutput: typeof emitOutput }).emitOutput = emitOutput;
    const action = createWithCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      isInteractiveTerminal: () => true,
    });

    const exitCode = await action("opencode");

    expect(exitCode).toBe(0);
    expect(discussTask).toHaveBeenCalledTimes(1);
    expect(emitOutput).toHaveBeenCalledWith({
      kind: "info",
      message: "No change: harness preset opencode is already configured.",
    });
    expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Starting interactive discuss session..." });
  });

  it("does not start discuss tui when with-task fails even if interactive keys are present", async () => {
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const discussTask = vi.fn(async () => 0);
    const withTask = vi.fn(async () => ({
      exitCode: 9,
      harnessKey: "opencode",
      source: "preset" as const,
      changed: true,
      configPath: "/workspace/.rundown/config.json",
      configuredKeys: [
        {
          keyPath: "workers.default" as const,
          status: "set" as const,
          value: ["opencode", "run", "--file", "$file", "$bootstrap"],
        },
        {
          keyPath: "workers.tui" as const,
          status: "set" as const,
          value: ["opencode"],
        },
        {
          keyPath: "commands.discuss" as const,
          status: "set" as const,
          value: ["opencode"],
        },
        {
          keyPath: "workers.fallbacks" as const,
          status: "preserved" as const,
        },
      ],
    }));

    const app = { withTask, discussTask } as unknown as CliApp;
    (app as unknown as { emitOutput: typeof emitOutput }).emitOutput = emitOutput;
    const action = createWithCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      isInteractiveTerminal: () => true,
    });

    const exitCode = await action("opencode");

    expect(exitCode).toBe(9);
    expect(discussTask).not.toHaveBeenCalled();
    expect(emitOutput).not.toHaveBeenCalledWith({
      kind: "info",
      message: "Starting interactive discuss session...",
    });
  });

  it("returns with-task exit code and skips tui launch when no interactive worker is configured", async () => {
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const discussTask = vi.fn(async () => 0);
    const withTask = vi.fn(async () => ({
      exitCode: 7,
      harnessKey: "custom-only",
      source: "custom" as const,
      changed: false,
      configPath: "/workspace/.rundown/config.json",
      configuredKeys: [
        {
          keyPath: "workers.default" as const,
          status: "set" as const,
          value: ["custom-only", "run", "--file", "$file", "$bootstrap"],
        },
        {
          keyPath: "workers.tui" as const,
          status: "removed" as const,
        },
        {
          keyPath: "commands.discuss" as const,
          status: "removed" as const,
        },
        {
          keyPath: "workers.fallbacks" as const,
          status: "preserved" as const,
        },
      ],
    }));

    const app = { withTask, discussTask } as unknown as CliApp;
    (app as unknown as { emitOutput: typeof emitOutput }).emitOutput = emitOutput;
    const action = createWithCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      isInteractiveTerminal: () => true,
    });

    const exitCode = await action("custom-only");

    expect(exitCode).toBe(7);
    expect(discussTask).not.toHaveBeenCalled();
    expect(emitOutput).not.toHaveBeenCalledWith({
      kind: "info",
      message: "Starting interactive discuss session...",
    });
  });

  it("keeps existing non-interactive behavior by skipping tui launch", async () => {
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const discussTask = vi.fn(async () => 0);
    const withTask = vi.fn(async () => ({
      exitCode: 0,
      harnessKey: "opencode",
      source: "preset" as const,
      changed: true,
      configPath: "/workspace/.rundown/config.json",
      configuredKeys: [
        {
          keyPath: "workers.default" as const,
          status: "set" as const,
          value: ["opencode", "run", "--file", "$file", "$bootstrap"],
        },
        {
          keyPath: "workers.tui" as const,
          status: "set" as const,
          value: ["opencode"],
        },
        {
          keyPath: "commands.discuss" as const,
          status: "set" as const,
          value: ["opencode"],
        },
        {
          keyPath: "workers.fallbacks" as const,
          status: "preserved" as const,
        },
      ],
    }));

    const app = { withTask, discussTask } as unknown as CliApp;
    (app as unknown as { emitOutput: typeof emitOutput }).emitOutput = emitOutput;
    const action = createWithCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
      isInteractiveTerminal: () => false,
    });

    const exitCode = await action("opencode");

    expect(exitCode).toBe(0);
    expect(discussTask).not.toHaveBeenCalled();
    expect(emitOutput).not.toHaveBeenCalledWith({
      kind: "info",
      message: "Starting interactive discuss session...",
    });
  });
});

describe("workspace command actions", () => {
  it("forwards normalized options to workspaceUnlinkTask", async () => {
    const workspaceUnlinkTask = vi.fn(async () => 0);
    const app = { workspaceUnlinkTask } as unknown as CliApp;
    const action = createWorkspaceUnlinkCommandAction({
      getApp: () => app,
    });

    const exitCode = await action({
      workspace: "../linked-project",
      all: true,
      dryRun: true,
    });

    expect(exitCode).toBe(0);
    expect(workspaceUnlinkTask).toHaveBeenCalledTimes(1);
    expect(workspaceUnlinkTask).toHaveBeenCalledWith({
      workspace: "../linked-project",
      all: true,
      dryRun: true,
    });
  });

  it("forwards remove options including deleteFiles/force", async () => {
    const workspaceRemoveTask = vi.fn(async () => 0);
    const app = { workspaceRemoveTask } as unknown as CliApp;
    const action = createWorkspaceRemoveCommandAction({
      getApp: () => app,
    });

    const exitCode = await action({
      workspace: "record-id",
      all: false,
      deleteFiles: true,
      dryRun: false,
      force: true,
    });

    expect(exitCode).toBe(0);
    expect(workspaceRemoveTask).toHaveBeenCalledTimes(1);
    expect(workspaceRemoveTask).toHaveBeenCalledWith({
      workspace: "record-id",
      all: false,
      deleteFiles: true,
      dryRun: false,
      force: true,
    });
  });
});

describe("createMigrateCommandAction", () => {
  it("forwards explicit --slug-worker override separately from --worker", async () => {
    const migrateTask = vi.fn(async () => 0);
    const app = { migrateTask } as unknown as CliApp;
    const action = createMigrateCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
    });

    const exitCode = await action("up", undefined, {
      dir: "migrations",
      workspace: "../workspace-source",
      worker: "opencode run --model gpt-5.3-codex",
      slugWorker: "opencode run --model gpt-5.3-mini",
    });

    expect(exitCode).toBe(0);
    expect(migrateTask).toHaveBeenCalledTimes(1);
    expect(migrateTask).toHaveBeenCalledWith(expect.objectContaining({
      action: "up",
      dir: "migrations",
      workspace: "../workspace-source",
      workerPattern: {
        command: ["opencode", "run", "--model", "gpt-5.3-codex"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      slugWorkerPattern: {
        command: ["opencode", "run", "--model", "gpt-5.3-mini"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
    }));
  });

  it("does not pass slugWorkerPattern when --slug-worker is omitted", async () => {
    const migrateTask = vi.fn(async () => 0);
    const app = { migrateTask } as unknown as CliApp;
    const action = createMigrateCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
    });

    const exitCode = await action(undefined, undefined, {
      dir: "migrations",
      worker: "opencode run --model gpt-5.3-codex",
    });

    expect(exitCode).toBe(0);
    expect(migrateTask).toHaveBeenCalledTimes(1);
    const request = (migrateTask as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(request?.workerPattern).toEqual({
      command: ["opencode", "run", "--model", "gpt-5.3-codex"],
      usesBootstrap: false,
      usesFile: false,
      appendFile: true,
    });
    expect(request?.slugWorkerPattern).toBeUndefined();
  });

  it("rejects removed migrate revision actions without compatibility aliases", () => {
    const migrateTask = vi.fn(async () => 0);
    const app = { migrateTask } as unknown as CliApp;
    const action = createMigrateCommandAction({
      getApp: () => app,
      getWorkerFromSeparator: () => undefined,
    });

    expect(() => action("save", undefined, {})).toThrow("Invalid migrate action: save");
    expect(() => action("diff", undefined, {})).toThrow("Invalid migrate action: diff");
    expect(() => action("preview", undefined, {})).toThrow("Invalid migrate action: preview");
    expect(migrateTask).not.toHaveBeenCalled();
  });
});

describe("createDesignReleaseCommandAction", () => {
  it("routes design release to designTask release action", async () => {
    const designTask = vi.fn(async () => 0);
    const app = { designTask } as unknown as CliApp;
    const action = createDesignReleaseCommandAction({
      getApp: () => app,
    });

    const exitCode = await action({
      dir: "migrations",
      workspace: "../workspace-source",
      label: "Initial baseline",
      worker: "opencode run --model gpt-5.3-codex",
    });

    expect(exitCode).toBe(0);
    expect(designTask).toHaveBeenCalledTimes(1);
    expect(designTask).toHaveBeenCalledWith({
      action: "release",
      dir: "migrations",
      workspace: "../workspace-source",
      label: "Initial baseline",
    });
  });

  it("falls back to docsTask release action when designTask is unavailable", async () => {
    const docsTask = vi.fn(async () => 0);
    const app = { docsTask } as unknown as CliApp;
    const action = createDesignReleaseCommandAction({
      getApp: () => app,
    });

    const exitCode = await action({
      dir: "migrations",
      workspace: "../workspace-source",
      label: "Initial baseline",
    });

    expect(exitCode).toBe(0);
    expect(docsTask).toHaveBeenCalledTimes(1);
    expect(docsTask).toHaveBeenCalledWith({
      action: "release",
      dir: "migrations",
      workspace: "../workspace-source",
      label: "Initial baseline",
    });
  });
});

describe("createDocsReleaseCommandAction", () => {
  it("routes docs release to designTask release action with deprecation warning", async () => {
    const designTask = vi.fn(async () => 0);
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const app = { designTask, emitOutput } as unknown as CliApp;
    const action = createDocsReleaseCommandAction({
      getApp: () => app,
    });

    const exitCode = await action({
      dir: "migrations",
      workspace: "../workspace-source",
      label: "Initial baseline",
      worker: "opencode run --model gpt-5.3-codex",
    });

    expect(exitCode).toBe(0);
    expect(emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      kind: "warn",
      message: "`rundown docs release` is deprecated; use `rundown design release`.",
    }));
    expect(designTask).toHaveBeenCalledTimes(1);
    expect(designTask).toHaveBeenCalledWith({
      action: "release",
      dir: "migrations",
      workspace: "../workspace-source",
      label: "Initial baseline",
    });
  });
});

describe("createDocsPublishCommandAction", () => {
  it("routes docs publish to designTask release action for compatibility", async () => {
    const designTask = vi.fn(async () => 0);
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const app = { designTask, emitOutput } as unknown as CliApp;
    const action = createDocsPublishCommandAction({
      getApp: () => app,
    });

    const exitCode = await action({
      dir: "migrations",
      workspace: "../workspace-source",
      label: "Initial baseline",
      worker: "opencode run --model gpt-5.3-codex",
    });

    expect(exitCode).toBe(0);
    expect(designTask).toHaveBeenCalledTimes(1);
    expect(emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      kind: "warn",
      message: "`rundown docs publish` is deprecated; use `rundown design release`.",
    }));
    expect(designTask).toHaveBeenCalledWith({
      action: "release",
      dir: "migrations",
      workspace: "../workspace-source",
      label: "Initial baseline",
    });
  });
});

describe("createDocsSaveCommandAction", () => {
  it("throws actionable guidance for removed docs save alias", () => {
    const action = createDocsSaveCommandAction();
    expect(() => action()).toThrow("`rundown docs save` was removed. Use `rundown design release` (preferred) or `rundown docs publish` (deprecated alias).");
  });
});

describe("createDesignDiffCommandAction", () => {
  it("routes shorthand defaults and preview target to design diff action", async () => {
    const designTask = vi.fn(async () => 0);
    const app = { designTask } as unknown as CliApp;
    const action = createDesignDiffCommandAction({
      getApp: () => app,
    });

    const defaultExitCode = await action(undefined, {
      dir: "migrations",
      workspace: "../workspace-source",
    });
    const previewExitCode = await action("preview", {
      dir: "migrations",
      workspace: "../workspace-source",
    });

    expect(defaultExitCode).toBe(0);
    expect(previewExitCode).toBe(0);
    expect(designTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      action: "diff",
      target: "current",
      dir: "migrations",
      workspace: "../workspace-source",
    }));
    expect(designTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      action: "diff",
      target: "preview",
      dir: "migrations",
      workspace: "../workspace-source",
    }));
  });

  it("accepts explicit --from/--to selectors with deterministic current target", async () => {
    const designTask = vi.fn(async () => 0);
    const app = { designTask } as unknown as CliApp;
    const action = createDesignDiffCommandAction({
      getApp: () => app,
    });

    const exitCode = await action(undefined, {
      dir: "migrations",
      from: "rev.1",
      to: "current",
    });

    expect(exitCode).toBe(0);
    expect(designTask).toHaveBeenCalledWith(expect.objectContaining({
      action: "diff",
      target: "current",
      dir: "migrations",
    }));
  });

  it("rejects invalid selector combinations and values", async () => {
    const designTask = vi.fn(async () => 0);
    const app = { designTask } as unknown as CliApp;
    const action = createDesignDiffCommandAction({
      getApp: () => app,
    });

    expect(() => action("preview", {
      from: "rev.1",
      to: "current",
    })).toThrow("[target] shorthand cannot be combined");

    expect(() => action(undefined, {
      from: "rev.1",
    })).toThrow("--from and --to must be provided together");

    expect(() => action(undefined, {
      from: "release-1",
      to: "current",
    })).toThrow("Invalid design diff --from selector");

    expect(() => action(undefined, {
      from: "rev.1",
      to: "rev.2",
    })).toThrow("Unsupported design diff selector combination");
  });
});

describe("createDocsDiffCommandAction", () => {
  it("routes docs diff to designTask diff action with deprecation warning", async () => {
    const designTask = vi.fn(async () => 0);
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const app = { designTask, emitOutput } as unknown as CliApp;
    const action = createDocsDiffCommandAction({
      getApp: () => app,
    });

    const exitCode = await action("preview", {
      dir: "migrations",
      workspace: "../workspace-source",
    });

    expect(exitCode).toBe(0);
    expect(emitOutput).toHaveBeenCalledWith(expect.objectContaining({
      kind: "warn",
      message: "`rundown docs diff` is deprecated; use `rundown design diff`.",
    }));
    expect(designTask).toHaveBeenCalledWith(expect.objectContaining({
      action: "diff",
      target: "preview",
      dir: "migrations",
      workspace: "../workspace-source",
    }));
  });
});

describe("createStartCommandAction", () => {
  it("forwards directory override options to startProject", async () => {
    const startProject = vi.fn(async () => 0);
    const app = { startProject } as unknown as CliApp;
    const action = createStartCommandAction({
      getApp: () => app,
    });

    const exitCode = await action("Ship auth flow", {
      dir: "./predict-auth",
      designDir: "design-docs",
      designPlacement: "workdir",
      specsDir: "assertions",
      specsPlacement: "sourcedir",
      migrationsDir: "changes",
      migrationsPlacement: "workdir",
    });

    expect(exitCode).toBe(0);
    expect(startProject).toHaveBeenCalledTimes(1);
    expect(startProject).toHaveBeenCalledWith({
      description: "Ship auth flow",
      dir: "./predict-auth",
      designDir: "design-docs",
      designPlacement: "workdir",
      specsDir: "assertions",
      specsPlacement: "sourcedir",
      migrationsDir: "changes",
      migrationsPlacement: "workdir",
    });
  });
});
