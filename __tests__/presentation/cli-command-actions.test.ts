import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
  EXIT_CODE_VERIFICATION_FAILURE,
} from "../../src/domain/exit-codes.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";
import {
  createWithCommandAction,
  createDesignDiffCommandAction,
  createDesignReleaseCommandAction,
  createDocsDiffCommandAction,
  createDocsPublishCommandAction,
  createDocsReleaseCommandAction,
  createDocsSaveCommandAction,
  createHelpCommandAction,
  createLoopCommandAction,
  createMigrateCommandAction,
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
  it("forwards harness argument to withTask and renders output", () => {
    const emitOutput = vi.fn<(event: ApplicationOutputEvent) => void>();
    const withTask = vi.fn(() => ({
      exitCode: 0,
      harnessKey: "opencode",
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
    const app = { withTask } as unknown as CliApp;
    (app as unknown as { emitOutput: typeof emitOutput }).emitOutput = emitOutput;
    const action = createWithCommandAction({
      getApp: () => app,
    });

    const exitCode = action("opencode");

    expect(exitCode).toBe(0);
    expect(withTask).toHaveBeenCalledTimes(1);
    expect(withTask).toHaveBeenCalledWith({ harness: "opencode" });
    expect(emitOutput).toHaveBeenCalledWith({ kind: "success", message: "Applied harness preset: opencode" });
    expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Path: /workspace/.rundown/config.json" });
    expect(emitOutput).toHaveBeenCalledWith({ kind: "info", message: "Configured keys:" });
    expect(emitOutput).toHaveBeenCalledWith({
      kind: "info",
      message: "- workers.default = [\"opencode\",\"run\",\"--file\",\"$file\",\"$bootstrap\"]",
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
