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
    task: {
      text: "end: there is no output to process",
      checked: false,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 10,
      file: "tasks.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    },
    source: "- [ ] end: there is no output to process\n",
    contextBefore: "",
    fileSystem: {
      exists: vi.fn(() => true),
      readText: vi.fn(() => ""),
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(() => []),
      stat: vi.fn(() => null),
      unlink: vi.fn(),
      rm: vi.fn(),
    },
    pathOperations: {
      resolve: (...parts: string[]) => parts.join("/"),
      relative: (from: string, to: string) => `${from}->${to}`,
      dirname: (input: string) => input,
      basename: (input: string) => input,
      extname: () => ".md",
      join: (...parts: string[]) => parts.join("/"),
      isAbsolute: (input: string) => input.startsWith("/") || /^[A-Za-z]:\\/.test(input),
      normalize: (input: string) => input,
      parse: (input: string) => ({ root: "", dir: "", base: input, ext: "", name: input }),
      sep: "/",
    },
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
    keepArtifacts: false,
    templateVars: {
      task: "end: there is no output to process",
      payload,
      file: "tasks.md",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "- [ ] end: there is no output to process\n",
    },
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
    expect(emit).toHaveBeenCalledWith({ kind: "info", message: "Evaluating optional skip condition." });
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Optional condition met; skipping remaining sibling tasks.",
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
      message: "Optional condition not met; continuing execution.",
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
      failureMessage: "Failed to evaluate condition: worker unavailable",
      failureReason: "Condition worker invocation failed.",
    });
    expect(emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Failed to evaluate condition: worker unavailable",
    });
  });
});
