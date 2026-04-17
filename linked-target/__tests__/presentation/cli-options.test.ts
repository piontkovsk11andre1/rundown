import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS } from "../../../src/domain/ports/command-executor.js";
import { createLoopCommandAction, createPlanCommandAction } from "../../../src/presentation/cli-command-actions.js";
import type { CliApp } from "../../../src/presentation/cli-app-init.js";

type CliOpts = Record<string, string | string[] | boolean>;

function createPlanAction(planTask: ReturnType<typeof vi.fn>) {
  const app = { planTask } as unknown as CliApp;
  return createPlanCommandAction({
    getApp: () => app,
    getWorkerFromSeparator: () => undefined,
    plannerModes: ["wait"],
  });
}

function createLoopAction(
  runTask: ReturnType<typeof vi.fn>,
  getInvocationArgv: () => string[],
) {
  const app = {
    runTask,
    emitOutput: vi.fn(),
    releaseAllLocks: vi.fn(),
  } as unknown as CliApp;

  return createLoopCommandAction({
    getApp: () => app,
    getWorkerFromSeparator: () => undefined,
    runnerModes: ["wait"],
    getInvocationArgv,
  });
}

describe("plan CLI option forwarding", () => {
  it("forwards --loop to planTask request", async () => {
    const planTask = vi.fn(async () => 0);
    const action = createPlanAction(planTask);

    const exitCode = await action(["tasks.md"], { loop: true });

    expect(exitCode).toBe(0);
    expect(planTask).toHaveBeenCalledTimes(1);
    expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "tasks.md",
      loop: true,
    }));
  });

  it("keeps existing plan flags behavior when --loop is enabled", async () => {
    const planTask = vi.fn(async () => 0);
    const action = createPlanAction(planTask);
    const baseOpts: CliOpts = {
      scanCount: "2",
      maxItems: "7",
      deep: "3",
      mode: "wait",
      dryRun: true,
      printPrompt: true,
      keepArtifacts: true,
      trace: true,
      showAgentOutput: true,
      forceUnlock: true,
      ignoreCliBlock: true,
      cliBlockTimeout: "1234",
      varsFile: "vars.json",
      var: ["env=prod", "owner=ops"],
      verbose: true,
    };

    await action(["tasks.md"], baseOpts);
    await action(["tasks.md"], { ...baseOpts, loop: true });

    expect(planTask).toHaveBeenCalledTimes(2);
    expect(planTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      source: "tasks.md",
      scanCount: 2,
      maxItems: 7,
      deep: 3,
      mode: "wait",
      dryRun: true,
      printPrompt: true,
      keepArtifacts: true,
      trace: true,
      showAgentOutput: true,
      forceUnlock: true,
      ignoreCliBlock: true,
      cliBlockTimeoutMs: 1234,
      varsFileOption: "vars.json",
      cliTemplateVarArgs: ["env=prod", "owner=ops"],
      verbose: true,
      loop: false,
    }));

    expect(planTask).toHaveBeenNthCalledWith(2, expect.objectContaining({
      source: "tasks.md",
      scanCount: 2,
      maxItems: 7,
      deep: 3,
      mode: "wait",
      dryRun: true,
      printPrompt: true,
      keepArtifacts: true,
      trace: true,
      showAgentOutput: true,
      forceUnlock: true,
      ignoreCliBlock: true,
      cliBlockTimeoutMs: 1234,
      varsFileOption: "vars.json",
      cliTemplateVarArgs: ["env=prod", "owner=ops"],
      verbose: true,
      loop: true,
    }));
  });

  it("defaults --loop to false when omitted", async () => {
    const planTask = vi.fn(async () => 0);
    const action = createPlanAction(planTask);

    await action(["tasks.md"], {});

    expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "tasks.md",
      loop: false,
      deep: 0,
      cliBlockTimeoutMs: DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS,
    }));
  });
});

describe("loop CLI commit option forwarding", () => {
  it("forwards explicit --commit options to loop iterations", async () => {
    const runTask = vi.fn(async () => 0);
    const action = createLoopAction(
      runTask,
      () => [
        "loop",
        "tasks.md",
        "--commit",
        "--commit-message",
        "loop: {{task}}",
        "--commit-mode",
        "file-done",
      ],
    );

    const exitCode = await action("tasks.md", {
      iterations: "1",
      cooldown: "0",
      commit: true,
      commitMessage: "loop: {{task}}",
      commitMode: "file-done",
    });

    expect(exitCode).toBe(0);
    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "tasks.md",
      commitAfterComplete: true,
      commitMessageTemplate: "loop: {{task}}",
      commitMode: "file-done",
      runAll: true,
      clean: true,
      redo: true,
      resetAfter: true,
      cacheCliBlocks: true,
    }));
  });

  it("defaults commit behavior to disabled when --commit is omitted", async () => {
    const runTask = vi.fn(async () => 0);
    const action = createLoopAction(
      runTask,
      () => ["loop", "tasks.md"],
    );

    await action("tasks.md", {
      iterations: "1",
      cooldown: "0",
    });

    expect(runTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "tasks.md",
      commitAfterComplete: false,
      commitMode: "per-task",
    }));
  });
});

describe("loop CLI time-limit option parsing", () => {
  it("accepts positive integer --time-limit values", async () => {
    const runTask = vi.fn(async () => 0);
    const action = createLoopAction(
      runTask,
      () => ["loop", "tasks.md", "--iterations", "1", "--cooldown", "0", "--time-limit", "1"],
    );

    const exitCode = await action("tasks.md", {
      iterations: "1",
      cooldown: "0",
      timeLimit: "1",
    });

    expect(exitCode).toBe(0);
    expect(runTask).toHaveBeenCalledTimes(1);
  });

  it("rejects zero --time-limit", async () => {
    const runTask = vi.fn(async () => 0);
    const action = createLoopAction(
      runTask,
      () => ["loop", "tasks.md", "--time-limit", "0"],
    );

    await expect(action("tasks.md", {
      timeLimit: "0",
    })).rejects.toThrow("Invalid --time-limit value: 0");
    expect(runTask).not.toHaveBeenCalled();
  });

  it("rejects negative --time-limit", async () => {
    const runTask = vi.fn(async () => 0);
    const action = createLoopAction(
      runTask,
      () => ["loop", "tasks.md", "--time-limit", "-1"],
    );

    await expect(action("tasks.md", {
      timeLimit: "-1",
    })).rejects.toThrow("Invalid --time-limit value: -1");
    expect(runTask).not.toHaveBeenCalled();
  });

  it("rejects non-integer --time-limit", async () => {
    const runTask = vi.fn(async () => 0);
    const action = createLoopAction(
      runTask,
      () => ["loop", "tasks.md", "--time-limit", "abc"],
    );

    await expect(action("tasks.md", {
      timeLimit: "abc",
    })).rejects.toThrow("Invalid --time-limit value: abc");
    expect(runTask).not.toHaveBeenCalled();
  });
});
