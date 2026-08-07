import { describe, expect, it, vi } from "vitest";
import { endHandler, terminalHandler } from "../../src/domain/builtin-tools/end.js";
import type { ToolHandlerContext } from "../../src/domain/ports/tool-handler-port.js";

describe("endHandler", () => {
  it("returns error when condition payload is empty", async () => {
    const runWorker = vi.fn();
    const emit = vi.fn();

    const context = {
      allTasks: [],
      payload: "   ",
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

    const result = await endHandler(context);

    expect(result).toEqual({
      exitCode: 1,
      failureMessage: "End tool requires a non-empty condition payload.",
      failureReason: "End condition payload is empty.",
    });
    expect(runWorker).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "End tool requires a non-empty condition payload.",
    });
  });

  it("returns skipRemainingSiblings with reason when condition evaluates to yes", async () => {
    const runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "yes",
      stderr: "",
    }));
    const emit = vi.fn();

    const context = {
      allTasks: [],
      payload: "  there is no output to process  ",
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

  it("returns skipExecution only when condition evaluates to no", async () => {
    const runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "no",
      stderr: "",
    }));
    const emit = vi.fn();

    const context = {
      allTasks: [],
      payload: "there is still output to process",
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

    const result = await endHandler(context);

    expect(result).toEqual({ skipExecution: true });
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Condition:\nthere is still output to process"),
      artifactPhase: "execute",
      artifactExtra: { taskType: "terminal-condition-evaluation" },
    }));
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Optional condition not met; continuing execution.",
    });
  });

  it("uses the JSON yes/no prompt format for evaluation", async () => {
    const runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "{\"decision\":\"no\"}",
      stderr: "",
    }));
    const emit = vi.fn();

    const context = {
      allTasks: [],
      payload: "there is no output to process",
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

    await endHandler(context);

    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Return JSON only: {\"decision\":\"yes\"} or {\"decision\":\"no\"}."),
    }));
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("Question: Is this condition true right now?"),
    }));
  });

  it("parses JSON decision responses", async () => {
    const runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "{\"decision\":\"yes\"}",
      stderr: "",
    }));
    const emit = vi.fn();

    const context = {
      allTasks: [],
      payload: "there is no output to process",
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

    const result = await endHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      skipRemainingSiblings: {
        reason: "there is no output to process",
      },
    });
  });

  it("defaults to no when worker response is ambiguous", async () => {
    const runWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: "maybe",
      stderr: "",
    }));
    const emit = vi.fn();

    const context = {
      allTasks: [],
      payload: "there is no output to process",
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

    const result = await endHandler(context);

    expect(result).toEqual({ skipExecution: true });
    expect(emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Optional condition response was ambiguous; defaulting to no and continuing execution.",
    });
  });

  it("returns error when worker invocation fails", async () => {
    const runWorker = vi.fn(async () => {
      throw new Error("worker unavailable");
    });
    const emit = vi.fn();

    const context = {
      allTasks: [],
      payload: "there is no output to process",
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

describe("terminalHandler", () => {
  function createContext(overrides: Partial<ToolHandlerContext> = {}): ToolHandlerContext {
    const runWorker = vi.fn(async () => ({ exitCode: 0, stdout: "yes", stderr: "" }));
    const emit = vi.fn();

    return {
      task: {
        text: "exit:",
        file: "C:/workspace/tasks.md",
        line: 1,
        index: 0,
        depth: 0,
        checked: false,
        subItems: [],
        children: [],
      } as unknown as ToolHandlerContext["task"],
      allTasks: [],
      payload: "",
      source: "- [ ] exit:",
      contextBefore: "",
      fileSystem: {
        readText: vi.fn(),
        writeText: vi.fn(),
        exists: vi.fn(),
        mkdir: vi.fn(),
        stat: vi.fn(),
        readdir: vi.fn(),
      } as unknown as ToolHandlerContext["fileSystem"],
      pathOperations: {
        resolve: vi.fn((value: string) => value),
      } as unknown as ToolHandlerContext["pathOperations"],
      emit,
      workerExecutor: { runWorker } as unknown as ToolHandlerContext["workerExecutor"],
      workerPattern: {
        command: ["opencode", "run"],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      workerCommand: ["opencode", "run"],
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
      keepArtifacts: false,
      templateVars: {},
      showAgentOutput: false,
      ...overrides,
    } as unknown as ToolHandlerContext;
  }

  it("treats empty payload as unconditional terminal stop", async () => {
    const context = createContext({
      task: { text: "exit:" } as unknown as ToolHandlerContext["task"],
      payload: "   ",
    });

    const result = await terminalHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      terminalStop: {
        requestedBy: "exit",
        mode: "unconditional",
        reason: "exit: (no condition)",
        stopRun: true,
        stopLoop: true,
        exitCode: 0,
      },
    });
    expect(context.workerExecutor.runWorker).not.toHaveBeenCalled();
  });

  it("uses conditional terminal stop when condition evaluates yes", async () => {
    const context = createContext({
      task: { text: "quit: there is no output" } as unknown as ToolHandlerContext["task"],
      payload: "there is no output",
      workerExecutor: {
        runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "yes", stderr: "" })),
      } as unknown as ToolHandlerContext["workerExecutor"],
    });

    const result = await terminalHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      terminalStop: {
        requestedBy: "quit",
        mode: "conditional",
        reason: "there is no output",
        stopRun: true,
        stopLoop: true,
        exitCode: 0,
      },
    });
    expect(context.workerExecutor.runWorker).toHaveBeenCalledTimes(1);
  });

  it("continues when conditional terminal check evaluates no", async () => {
    const context = createContext({
      task: { text: "end: condition" } as unknown as ToolHandlerContext["task"],
      payload: "condition",
      workerExecutor: {
        runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "no", stderr: "" })),
      } as unknown as ToolHandlerContext["workerExecutor"],
    });

    const result = await terminalHandler(context);

    expect(result).toEqual({ skipExecution: true });
  });
});
