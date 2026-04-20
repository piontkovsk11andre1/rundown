import { describe, expect, it, vi } from "vitest";
import { forLoopHandler } from "../../../src/domain/builtin-tools/for-loop.js";
import { resolveForLoopItems } from "../../../src/domain/for-loop.js";
import { parseTasks } from "../../../src/domain/parser.js";
import type { ToolHandlerContext } from "../../../src/domain/ports/tool-handler-port.js";

function createContext(overrides: Partial<ToolHandlerContext> = {}): ToolHandlerContext {
  const payload = typeof overrides.payload === "string"
    ? overrides.payload
    : "This, That, Omg";
  const defaultRunWorker = vi.fn(async () => ({
    exitCode: 0,
    stdout: JSON.stringify({
      results: payload
        .split(/[\r\n,]+/)
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    }),
    stderr: "",
  }));

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
    payload,
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
      runWorker: defaultRunWorker,
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
      payload,
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
    const runWorkerCall = (context.workerExecutor.runWorker as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(runWorkerCall?.prompt ?? "").toContain("Return one item per line using plain lines or Markdown list items (bulleted/numbered).");
    expect(runWorkerCall?.prompt ?? "").toContain("Do not wrap output in code fences.");
    expect(runWorkerCall?.prompt ?? "").toContain("Use one item per line; do not use JSON or nested structures.");
    expect(runWorkerCall?.prompt ?? "").toContain("Do not include the literal `for-item:` prefix unless it is part of the value.");
    expect(context.emit).toHaveBeenCalledWith({
      kind: "info",
      message: "For loop baked 3 items from research: This, That, Omg",
    });
    expect(context.emit).toHaveBeenCalledWith({
      kind: "info",
      message: "For loop current item: This",
    });
  });

  it("loads research output contract from .rundown template when configured", async () => {
    const context = createContext({
      templates: {
        researchOutputContract: [
          "- Custom line for {{itemLabel}}",
          "- Prefix token {{metadataPrefix}}",
          "- Empty rule {{emptyConditionLabel}}",
        ].join("\n"),
      },
    });

    await forLoopHandler(context);

    const runWorkerCall = (context.workerExecutor.runWorker as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    const prompt = runWorkerCall?.prompt ?? "";
    expect(prompt).toContain("Custom line for item");
    expect(prompt).toContain("Prefix token for-item:");
    expect(prompt).toContain("Empty rule items are found");
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
    expect(context.workerExecutor.runWorker).not.toHaveBeenCalled();
  });

  it("preserves payload item order and duplicates", async () => {
    const context = createContext({
      payload: "This, That, This, Omg, That",
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: This",
      "for-item: That",
      "for-item: This",
      "for-item: Omg",
      "for-item: That",
    ]);
  });

  it("parses markdown bullet output and normalizes missing for-item prefixes", async () => {
    const context = createContext({
      payload: "Ignored",
      workerExecutor: {
        ...createContext().workerExecutor,
        runWorker: vi.fn(async () => ({
          exitCode: 0,
          stdout: [
            "- for-item: Alpha",
            "- Beta",
            "3. for-item: Gamma",
            "4) Delta",
          ].join("\n"),
          stderr: "",
        })),
      },
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: Alpha",
      "for-item: Beta",
      "for-item: Gamma",
      "for-item: Delta",
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

  it("preserves duplicate existing for-item metadata values", async () => {
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
      "for-item: Existing A",
      "for-item: Existing B",
    ]);
  });

  it("parses mixed prefixed and unprefixed ordered-list variants", async () => {
    const context = createContext({
      payload: "Ignored",
      workerExecutor: {
        ...createContext().workerExecutor,
        runWorker: vi.fn(async () => ({
          exitCode: 0,
          stdout: [
            "1. for-item: Alpha",
            "2) Beta",
            "3. Gamma",
            "4) for-item: Delta",
          ].join("\n"),
          stderr: "",
        })),
      },
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: Alpha",
      "for-item: Beta",
      "for-item: Gamma",
      "for-item: Delta",
    ]);
  });

  it("ignores tilde-fenced for-item-like lines in worker output parsing", async () => {
    const context = createContext({
      payload: "Ignored",
      workerExecutor: {
        ...createContext().workerExecutor,
        runWorker: vi.fn(async () => ({
          exitCode: 0,
          stdout: [
            "~~~md",
            "- for-item: Example inside fence",
            "~~~",
            "- Actual",
          ].join("\n"),
          stderr: "",
        })),
      },
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: Actual",
    ]);
  });

  it("strips only the first for-item prefix token and preserves later colons", async () => {
    const context = createContext({
      payload: "Ignored",
      workerExecutor: {
        ...createContext().workerExecutor,
        runWorker: vi.fn(async () => ({
          exitCode: 0,
          stdout: "- for-item: key: value",
          stderr: "",
        })),
      },
    });

    const result = await forLoopHandler(context);

    expect(result.childTasks).toEqual([
      "for-item: key: value",
    ]);
  });

  it("keeps parse -> persist -> parse loop metadata idempotent with duplicates and escapes", async () => {
    const context = createContext({
      payload: "Ignored",
      workerExecutor: {
        ...createContext().workerExecutor,
        runWorker: vi.fn(async () => ({
          exitCode: 0,
          stdout: [
            "- keep `code`",
            "2) keep `code`",
            "3) key: value",
            "4) [label]",
          ].join("\n"),
          stderr: "",
        })),
      },
    });

    const first = await forLoopHandler(context);

    const childTasks = first.childTasks ?? [];

    expect(childTasks).toEqual([
      "for-item: keep \\`code\\`",
      "for-item: keep \\`code\\`",
      "for-item: key: value",
      "for-item: \\[label\\]",
    ]);

    const persistedSource = [
      "- [ ] for: controllers",
      ...childTasks.map((line) => `  - ${line}`),
      "  - [ ] Do this",
      "",
    ].join("\n");
    const reparsed = parseTasks(persistedSource, "tasks.md")[0];
    const secondResolved = resolveForLoopItems(reparsed?.subItems ?? [], "ignored");

    expect(secondResolved).toEqual({
      source: "metadata",
      items: [
        "keep `code`",
        "keep `code`",
        "key: value",
        "[label]",
      ],
    });
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
