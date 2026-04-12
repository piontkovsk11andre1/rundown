import { describe, expect, it, vi } from "vitest";
import { forLoopHandler } from "../../../src/domain/builtin-tools/for-loop.js";
import type { ToolHandlerContext } from "../../../src/domain/ports/tool-handler-port.js";

function createContext(overrides: Partial<ToolHandlerContext> = {}): ToolHandlerContext {
  return {
    task: {
      text: "for: controllers",
      checked: false,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 20,
      file: "tasks.md",
      isInlineCli: false,
      depth: 0,
      children: [
        {
          text: "Do this",
          checked: false,
          index: 1,
          line: 2,
          column: 1,
          offsetStart: 0,
          offsetEnd: 10,
          file: "tasks.md",
          isInlineCli: false,
          depth: 1,
          children: [],
          subItems: [],
        },
      ],
      subItems: [],
    },
    allTasks: [],
    payload: "This, That, Omg",
    source: "- [ ] for: controllers\n",
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
      join: (...parts: string[]) => parts.join("/"),
      resolve: (...parts: string[]) => parts.join("/"),
      dirname: (input: string) => input,
      relative: (from: string, to: string) => `${from}->${to}`,
      isAbsolute: (input: string) => input.startsWith("/") || /^[A-Za-z]:\\/.test(input),
    },
    emit: vi.fn(),
    configDir: undefined,
    workerExecutor: {
      runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    },
    workerPattern: {
      command: ["opencode", "run"],
      usesBootstrap: false,
      usesFile: false,
      appendFile: true,
    },
    workerCommand: ["opencode", "run"],
    mode: "wait",
    trace: false,
    cwd: "/workspace",
    executionEnv: undefined,
    artifactContext: {
      runId: "run-1",
      rootDir: "/workspace/.rundown/runs/run-1",
      cwd: "/workspace",
      keepArtifacts: false,
      commandName: "run",
    },
    keepArtifacts: false,
    templateVars: {
      task: "for: controllers",
      payload: "This, That, Omg",
      file: "tasks.md",
      context: "",
      taskIndex: 0,
      taskLine: 1,
      source: "- [ ] for: controllers\n",
    },
    showAgentOutput: false,
    ...overrides,
  } as ToolHandlerContext;
}

describe("builtin-tools/for-loop", () => {
  it("bakes item metadata lines from payload values", async () => {
    const context = createContext();

    const result = await forLoopHandler(context);

    expect(result.skipExecution).toBe(true);
    expect(result.shouldVerify).toBe(false);
    expect(result.childTasks).toEqual([
      "for-item: This",
      "for-item: That",
      "for-item: Omg",
    ]);
    expect(context.emit).toHaveBeenCalledWith({
      kind: "info",
      message: "For loop baked 3 unique items from payload: This, That, Omg",
    });
    expect(context.emit).toHaveBeenCalledWith({
      kind: "info",
      message: "For loop current item: This",
    });
  });

  it("reuses existing for-item metadata when present", async () => {
    const context = createContext({
      task: {
        ...createContext().task,
        subItems: [
          { text: "for-item: Existing A", line: 2, depth: 1 },
          { text: "for-item: Existing B", line: 3, depth: 1 },
          { text: "for-current: Existing A", line: 4, depth: 1 },
        ],
      },
      payload: "Ignored, values",
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: Existing A",
      "for-item: Existing B",
    ]);
  });

  it("deduplicates payload items while preserving first-seen order", async () => {
    const context = createContext({
      payload: "This, That, This, Omg, That",
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: This",
      "for-item: That",
      "for-item: Omg",
    ]);
  });

  it("escapes markdown-sensitive metadata text in baked for-item lines", async () => {
    const context = createContext({
      payload: "use * wildcard, keep `code`, path\\to\\file, [brackets], <html>",
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: use \\* wildcard",
      "for-item: keep \\`code\\`",
      "for-item: path\\\\to\\\\file",
      "for-item: \\[brackets\\]",
      "for-item: \\<html\\>",
    ]);
  });

  it("deduplicates existing for-item metadata values", async () => {
    const context = createContext({
      task: {
        ...createContext().task,
        subItems: [
          { text: "for-item: Existing A", line: 2, depth: 1 },
          { text: "for-item: Existing A", line: 3, depth: 1 },
          { text: "for-item: Existing B", line: 4, depth: 1 },
        ],
      },
      payload: "Ignored, values",
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: Existing A",
      "for-item: Existing B",
    ]);
  });

  it("returns an error when loop task has no checkbox children", async () => {
    const context = createContext({
      task: {
        ...createContext().task,
        children: [],
      },
    });

    const result = await forLoopHandler(context);

    expect(result).toEqual({
      exitCode: 1,
      failureMessage: "For loop task requires nested checkbox child tasks.",
      failureReason: "For loop task has no nested checkbox children.",
    });
  });
});
