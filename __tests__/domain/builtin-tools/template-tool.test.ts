import { describe, expect, it, vi } from "vitest";
import { createTemplateToolHandler } from "../../../src/domain/builtin-tools/template-tool.js";
import type { ToolHandlerContext } from "../../../src/domain/ports/tool-handler-port.js";

function createContext(overrides: Partial<ToolHandlerContext> = {}): {
  context: ToolHandlerContext;
  runWorker: ReturnType<typeof vi.fn>;
  cliExecute: ReturnType<typeof vi.fn>;
} {
  const runWorker = vi.fn(async () => ({
    exitCode: 0,
    stdout: "",
    stderr: "",
  }));
  const cliExecute = vi.fn(async () => ({
    exitCode: 0,
    stdout: "hello",
    stderr: "",
  }));

  const context = {
    task: {
      text: "tool: generate follow-ups",
      checked: false,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 26,
      file: "tasks.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    },
    allTasks: [],
    payload: "payload value",
    source: "- [ ] tool: generate follow-ups\n",
    contextBefore: "",
    fileSystem: {
      readText: vi.fn(() => ""),
      writeText: vi.fn(),
    },
    pathOperations: {},
    emit: vi.fn(),
    workerExecutor: { runWorker },
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
    templateVars: {
      task: "tool: generate follow-ups",
      payload: "payload value",
      file: "tasks.md",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "- [ ] tool: generate follow-ups\n",
    },
    showAgentOutput: false,
    cliBlockExecutor: {
      execute: cliExecute,
    },
    ...overrides,
  } as unknown as ToolHandlerContext;

  return { context, runWorker, cliExecute };
}

describe("builtin-tools/template-tool createTemplateToolHandler", () => {
  it("expands cli fences into worker prompt", async () => {
    const handler = createTemplateToolHandler([
      "Task: {{task}}",
      "```cli",
      "echo hello",
      "```",
    ].join("\n"));
    const { context, runWorker, cliExecute } = createContext();

    const result = await handler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
      childTasks: [],
    });
    expect(cliExecute).toHaveBeenCalledTimes(1);
    expect(runWorker).toHaveBeenCalledTimes(1);
    const prompt = runWorker.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("Task: tool: generate follow-ups");
    expect(prompt).toContain("<command>echo hello</command>");
    expect(prompt).toContain("<output>");
    expect(prompt).toContain("hello");
    expect(prompt).not.toContain("```cli");
  });

  it("leaves cli fences raw when cliExpansionEnabled is false", async () => {
    const handler = createTemplateToolHandler("```cli\necho hello\n```");
    const { context, runWorker, cliExecute } = createContext({
      cliExpansionEnabled: false,
    });

    const result = await handler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
      childTasks: [],
    });
    expect(cliExecute).not.toHaveBeenCalled();
    expect(runWorker).toHaveBeenCalledTimes(1);
    const prompt = runWorker.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("```cli");
    expect(prompt).toContain("echo hello");
  });

  it("returns non-zero result when tool-template cli expansion fails", async () => {
    const handler = createTemplateToolHandler("```cli\nexit 1\n```");
    const { context, runWorker } = createContext({
      cliBlockExecutor: {
        execute: vi.fn(async () => ({
          exitCode: 23,
          stdout: "",
          stderr: "boom",
        })),
      },
    });

    const result = await handler(context);

    expect(result.exitCode).toBe(1);
    expect(result.failureMessage).toContain("Tool template CLI block expansion failed");
    expect(result.failureReason).toContain("tool template");
    expect(runWorker).not.toHaveBeenCalled();
  });

  it("runs unchanged when cliBlockExecutor is missing", async () => {
    const handler = createTemplateToolHandler("```cli\necho hello\n```");
    const { context, runWorker } = createContext();
    delete (context as Partial<ToolHandlerContext>).cliBlockExecutor;

    const result = await handler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
      childTasks: [],
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
    const prompt = runWorker.mock.calls[0]?.[0]?.prompt ?? "";
    expect(prompt).toContain("```cli");
    expect(prompt).toContain("echo hello");
    expect(prompt).not.toContain("<command>echo hello</command>");
  });
});
