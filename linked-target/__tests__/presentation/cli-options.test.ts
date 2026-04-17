import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS } from "../../../src/domain/ports/command-executor.js";
import { createPlanCommandAction } from "../../../src/presentation/cli-command-actions.js";
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
