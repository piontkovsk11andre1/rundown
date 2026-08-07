import { describe, expect, it, vi } from "vitest";
import { createExploreTask } from "../../src/application/explore-task.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";

describe("explore-task", () => {
  it("runs plan on the selected source", async () => {
    const planTask = vi.fn(async () => 0);
    const events: Array<{ kind: string; message: string }> = [];

    const exploreTask = createExploreTask({
      output: {
        emit: (event) => {
          if (event.kind === "info") {
            events.push({ kind: event.kind, message: event.message });
          }
        },
      },
      planTask,
    });

    const code = await exploreTask({
      source: "/workspace/design/current/Target.md",
      cwd: "/workspace",
      mode: "wait",
      workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      showAgentOutput: false,
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      varsFileOption: undefined,
      cliTemplateVarArgs: [],
      trace: false,
      forceUnlock: false,
      ignoreCliBlock: false,
      scanCount: 3,
      deep: 1,
      maxItems: 9,
      verbose: true,
      emitPhaseMessages: true,
    });

    expect(code).toBe(0);
    expect(planTask).toHaveBeenCalledTimes(1);

    expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "/workspace/design/current/Target.md",
      cwd: "/workspace",
      mode: "wait",
      scanCount: 3,
      deep: 1,
      maxItems: 9,
    }));

    expect(events).toEqual([
      { kind: "info", message: "Explore phase 1/1: plan" },
    ]);
  });

  it("returns the plan failure exit code", async () => {
    const planTask = vi.fn(async () => 2);

    const exploreTask = createExploreTask({
      output: { emit: () => {} },
      planTask,
    });

    const code = await exploreTask({
      source: "/workspace/migrations/1.initialize.md",
      cwd: "/workspace",
      mode: "wait",
      workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      showAgentOutput: false,
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      varsFileOption: undefined,
      cliTemplateVarArgs: [],
      trace: false,
      forceUnlock: false,
      ignoreCliBlock: false,
    });

    expect(code).toBe(2);
    expect(planTask).toHaveBeenCalledTimes(1);
  });
});
