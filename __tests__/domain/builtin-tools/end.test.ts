import { describe, expect, it, vi } from "vitest";
import { endHandler } from "../../../src/domain/builtin-tools/end.js";
import type { ToolHandlerContext } from "../../../src/domain/ports/tool-handler-port.js";

function createContext(params: {
  payload?: string;
  runWorker: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
}): ToolHandlerContext {
  const { payload = "there is no output to process", runWorker, emit } = params;
  return {
    allTasks: [],
    payload,
    workerExecutor: { runWorker },
    workerPattern: {
      command: ["opencode", "run"],
      usesBootstrap: false,
      usesFile: false,
      appendFile: true,
    },
    mode: "wait",
    trace: false,
    cwd: "C:/workspace",
    executionEnv: undefined,
    configDir: undefined,
    artifactContext: {
      runId: "run-1",
      rootDir: "C:/workspace/.rundown/runs/run-1",
      cwd: "C:/workspace",
      keepArtifacts: false,
      commandName: "run",
    },
    showAgentOutput: false,
    emit,
  } as unknown as ToolHandlerContext;
}

describe("builtin-tools/end endHandler", () => {
  it("returns skipRemainingSiblings when condition evaluates to true", async () => {
    const runWorker = vi.fn(async () => ({ exitCode: 0, stdout: "yes", stderr: "" }));
    const emit = vi.fn();
    const context = createContext({ runWorker, emit });

    const result = await endHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      skipRemainingSiblings: {
        reason: "there is no output to process",
      },
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ kind: "info", message: "Evaluating end condition." });
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "End condition met; skipping remaining sibling tasks.",
    });
  });

  it("returns skipExecution only when condition evaluates to false", async () => {
    const runWorker = vi.fn(async () => ({ exitCode: 0, stdout: "no", stderr: "" }));
    const emit = vi.fn();
    const context = createContext({ payload: "there is still output to process", runWorker, emit });

    const result = await endHandler(context);

    expect(result).toEqual({ skipExecution: true });
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "End condition not met; continuing execution.",
    });
  });

  it("returns error when worker invocation fails", async () => {
    const runWorker = vi.fn(async () => {
      throw new Error("worker unavailable");
    });
    const emit = vi.fn();
    const context = createContext({ runWorker, emit });

    const result = await endHandler(context);

    expect(result).toEqual({
      exitCode: 1,
      failureMessage: "Failed to evaluate end condition: worker unavailable",
      failureReason: "End condition worker invocation failed.",
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Failed to evaluate end condition: worker unavailable",
    });
  });
});
