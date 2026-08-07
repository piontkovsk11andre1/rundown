import { describe, expect, it, vi } from "vitest";
import { createExploreTask } from "../../src/application/explore-task.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";

describe("explore-task", () => {
  it("runs research then plan on the same source", async () => {
    const researchTask = vi.fn(async () => 0);
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
      researchTask,
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
    expect(researchTask).toHaveBeenCalledTimes(1);
    expect(planTask).toHaveBeenCalledTimes(1);

    const researchOrder = vi.mocked(researchTask).mock.invocationCallOrder[0];
    const planOrder = vi.mocked(planTask).mock.invocationCallOrder[0];
    expect(researchOrder).toBeLessThan(planOrder);

    expect(researchTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "/workspace/design/current/Target.md",
      cwd: "/workspace",
      mode: "wait",
    }));
    expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
      source: "/workspace/design/current/Target.md",
      cwd: "/workspace",
      mode: "wait",
      scanCount: 3,
      deep: 1,
      maxItems: 9,
    }));

    expect(events).toEqual([
      { kind: "info", message: "Explore phase 1/2: research" },
      { kind: "info", message: "Explore transition: research -> plan" },
      { kind: "info", message: "Explore phase 2/2: plan" },
    ]);
  });

  it("returns early when research fails", async () => {
    const researchTask = vi.fn(async () => 2);
    const planTask = vi.fn(async () => 0);

    const exploreTask = createExploreTask({
      output: { emit: () => {} },
      researchTask,
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
    expect(researchTask).toHaveBeenCalledTimes(1);
    expect(planTask).not.toHaveBeenCalled();
  });
});
