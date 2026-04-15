import { describe, expect, it, vi } from "vitest";
import { checkTaskUsingFileSystem } from "../../../src/application/checkbox-operations.js";
import { getHandler } from "../../../src/domain/builtin-tools/get.js";
import { parseTasks } from "../../../src/domain/parser.js";
import type { ToolHandlerContext } from "../../../src/domain/ports/tool-handler-port.js";

interface CreateContextOptions {
  payload?: string;
  source: string;
  subItems?: Array<{ text: string; line: number; depth: number }>;
  line?: number;
  runWorker?: ReturnType<typeof vi.fn>;
}

function createContext(options: CreateContextOptions): {
  context: ToolHandlerContext;
  writeText: ReturnType<typeof vi.fn>;
  runWorker: ReturnType<typeof vi.fn>;
  emit: ReturnType<typeof vi.fn>;
} {
  const {
    payload = "All current names of this and that",
    source,
    subItems = [],
    line = 1,
    runWorker = vi.fn(async () => ({ exitCode: 0, stdout: '{"results":["This","That"]}', stderr: "" })),
  } = options;

  let fileBody = source;
  const writeText = vi.fn((filePath: string, next: string) => {
    fileBody = next;
    return filePath;
  });
  const emit = vi.fn();

  const context = {
    task: {
      text: "get: All current names of this and that",
      checked: false,
      line,
      column: 1,
      index: 0,
      offsetStart: 0,
      offsetEnd: 0,
      file: "C:/workspace/todo.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems,
    },
    allTasks: [],
    payload,
    source,
    contextBefore: "",
    fileSystem: {
      exists: vi.fn(() => true),
      readText: vi.fn(() => fileBody),
      writeText,
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
      task: "get: All current names of this and that",
      payload,
      file: "C:/workspace/todo.md",
      context: "",
      taskIndex: 0,
      taskLine: line,
      source,
    },
    emit,
  } as unknown as ToolHandlerContext;

  return { context, writeText, runWorker, emit };
}

describe("builtin-tools/get getHandler", () => {
  it.each(["", "  ", "\t\n  "])("fails when payload is empty or whitespace-only: %j", async (payload) => {
    const { context, writeText, runWorker } = createContext({ payload, source: "- [ ] get:\n" });

    const result = await getHandler(context);

    expect(result.exitCode).toBe(1);
    expect(result.failureMessage).toBe("Get tool requires query text payload.");
    expect(result.failureReason).toBe("Get payload is empty.");
    expect(runWorker).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("reuses existing get-result sub-items and skips worker execution", async () => {
    const { context, writeText, runWorker, emit } = createContext({
      source: "- [ ] get: All current names of this and that\n  - get-result: This\n",
      subItems: [{ text: "get-result: This", line: 2, depth: 1 }],
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(runWorker).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Get outcome: reused; rerun-policy=reuse; existing-results=1.",
    });
  });

  it("refreshes existing get-result sub-items when get-mode is refresh", async () => {
    const source = "- [ ] get: All current names of this and that\n  - get-mode: refresh\n  - get-result: This\n";
    const { context, writeText, runWorker, emit } = createContext({
      source,
      subItems: [
        { text: "get-mode: refresh", line: 2, depth: 1 },
        { text: "get-result: This", line: 3, depth: 1 },
      ],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["That"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
    const runWorkerPrompt = runWorker.mock.calls[0]?.[0]?.prompt ?? "";
    expect(runWorkerPrompt).toContain("You are a full-scale research agent resolving a task query against the current project.");
    expect(runWorkerPrompt).toContain("Task:");
    expect(runWorkerPrompt).toContain("get: All current names of this and that");
    expect(runWorkerPrompt).toContain("Full source document:");
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] get: All current names of this and that\n"
      + "  - get-mode: refresh\n"
      + "  - get-result: That\n",
    );
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Get outcome: replaced; result-count=1; rerun-policy=refresh.",
    });
  });

  it("fails when get-mode value is invalid", async () => {
    const { context, writeText, runWorker } = createContext({
      source: "- [ ] get: All current names of this and that\n  - get-mode: replace\n",
      subItems: [{ text: "get-mode: replace", line: 2, depth: 1 }],
    });

    const result = await getHandler(context);

    expect(result.exitCode).toBe(1);
    expect(result.failureMessage).toBe("Get rerun policy must be `reuse` or `refresh`; received: replace.");
    expect(result.failureReason).toBe("Get rerun policy is invalid.");
    expect(runWorker).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("extracts results and writes get-result sub-items", async () => {
    const source = "- [ ] get: All current names of this and that\n  - note: keep context\n";
    const { context, writeText, runWorker, emit } = createContext({
      source,
      subItems: [{ text: "note: keep context", line: 2, depth: 1 }],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["This","That"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] get: All current names of this and that\n"
      + "  - get-result: This\n"
      + "  - get-result: That\n"
      + "  - note: keep context\n",
    );
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Get outcome: generated; result-count=2; rerun-policy=reuse.",
    });
  });

  it("preserves extracted value order and duplicates", async () => {
    const source = "- [ ] get: All current names of this and that\n";
    const { context, writeText } = createContext({
      source,
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["This","That","This","Another","That"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] get: All current names of this and that\n"
      + "  - get-result: This\n"
      + "  - get-result: That\n"
      + "  - get-result: This\n"
      + "  - get-result: Another\n"
      + "  - get-result: That\n",
    );
  });

  it("writes extracted get-result lines before task is marked checked", async () => {
    const source = "- [ ] get: All current names of this and that\n  - note: keep context\n";
    const { context, writeText } = createContext({
      source,
      subItems: [{ text: "note: keep context", line: 2, depth: 1 }],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["This","That"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);
    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });

    checkTaskUsingFileSystem(context.task, context.fileSystem);

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText.mock.calls[0]?.[1]).toBe(
      "- [ ] get: All current names of this and that\n"
      + "  - get-result: This\n"
      + "  - get-result: That\n"
      + "  - note: keep context\n",
    );
    expect(writeText.mock.calls[1]?.[1]).toBe(
      "- [x] get: All current names of this and that\n"
      + "  - get-result: This\n"
      + "  - get-result: That\n"
      + "  - note: keep context\n",
    );
  });

  it("escapes markdown-significant get-result values so parsed sub-items round-trip", async () => {
    const source = "- [ ] get: All current names of this and that\n";
    const { context, writeText } = createContext({
      source,
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["core: [parser]*module*"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] get: All current names of this and that\n"
      + "  - get-result: core: \\[parser\\]\\*module\\*\n",
    );

    const reparsed = parseTasks(writtenSource, "C:/workspace/todo.md")[0];
    expect(reparsed?.subItems[0]?.text).toBe("get-result: core: [parser]*module*");
    expect(reparsed?.children).toEqual([]);
  });

  it("escapes backticks when get-result values contain backticks", async () => {
    const source = "- [ ] get: All current names of this and that\n";
    const { context, writeText } = createContext({
      source,
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["name with `tick` and : colon"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] get: All current names of this and that\n"
      + "  - get-result: name with \\`tick\\` and : colon\n",
    );
  });

  it("parses mixed line-style output without requiring get-result prefix", async () => {
    const source = "- [ ] get: All current names of this and that\n";
    const { context, writeText } = createContext({
      source,
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: [
          "- Alpha",
          "2) Beta",
          "Gamma",
          "- get-result: Delta",
        ].join("\n"),
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText.mock.calls[0]?.[1] ?? "").toBe([
      "- [ ] get: All current names of this and that",
      "  - get-result: Alpha",
      "  - get-result: Beta",
      "  - get-result: Gamma",
      "  - get-result: Delta",
      "",
    ].join("\n"));
  });

  it("falls back to line parsing for wrong-shape JSON and preserves mixed prefixed lines", async () => {
    const source = "- [ ] get: All current names of this and that\n";
    const { context, writeText } = createContext({
      source,
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: [
          "{\"unexpected\":[\"shape\"]}",
          "get-result: X",
          "Y",
        ].join("\n"),
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText.mock.calls[0]?.[1] ?? "").toBe([
      "- [ ] get: All current names of this and that",
      "  - get-result: {\"unexpected\":\\[\"shape\"\\]}",
      "  - get-result: X",
      "  - get-result: Y",
      "",
    ].join("\n"));
  });

  it("falls back to line parsing when worker output starts with invalid JSON", async () => {
    const source = "- [ ] get: All current names of this and that\n";
    const { context, writeText } = createContext({
      source,
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: [
          "{\"results\":[",
          "- Alpha",
          "2) Beta",
          "Gamma",
        ].join("\n"),
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText.mock.calls[0]?.[1] ?? "").toBe([
      "- [ ] get: All current names of this and that",
      "  - get-result: {\"results\":\\[",
      "  - get-result: Alpha",
      "  - get-result: Beta",
      "  - get-result: Gamma",
      "",
    ].join("\n"));
  });

  it("persists an explicit empty marker when extraction succeeds but returns no values", async () => {
    const { context, writeText, emit } = createContext({
      source: "- [ ] get: All current names of this and that\n",
      subItems: [],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":[]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] get: All current names of this and that\n"
      + "  - get-result: (empty)\n",
    );
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Get outcome: empty; empty-result-policy=marker; action=persisted-empty-marker.",
    });
  });

  it("reuses explicit empty marker on rerun and skips worker execution", async () => {
    const source = "- [ ] get: All current names of this and that\n  - get-result: (empty)\n";
    const { context, writeText, runWorker } = createContext({
      source,
      subItems: [{ text: "get-result: (empty)", line: 2, depth: 1 }],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["ShouldNotRun"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(runWorker).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("fails empty extraction when get-empty policy is fail", async () => {
    const { context, writeText, emit } = createContext({
      source: "- [ ] get: All current names of this and that\n  - get-empty: fail\n",
      subItems: [{ text: "get-empty: fail", line: 2, depth: 1 }],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":[]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result.exitCode).toBe(1);
    expect(result.failureMessage).toBe("Get extraction returned no results (empty-result policy: fail).");
    expect(result.failureReason).toBe("Get extraction produced an empty result set and empty-result policy is fail.");
    expect(writeText).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Get outcome: empty; empty-result-policy=fail; action=task-failed.",
    });
  });

  it("uses nested indentation and preserves CRLF endings", async () => {
    const source = "- [ ] parent\r\n  - [ ] get: All current names of this and that\r\n    - note: keep context\r\n";
    const { context, writeText } = createContext({
      source,
      line: 2,
      subItems: [{ text: "note: keep context", line: 3, depth: 2 }],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '- get-result: This\n- get-result: That',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] parent\r\n"
      + "  - [ ] get: All current names of this and that\r\n"
      + "    - get-result: This\r\n"
      + "    - get-result: That\r\n"
      + "    - note: keep context\r\n",
    );
  });

  it("refreshes only real child get-result lines and preserves fenced examples", async () => {
    const source = [
      "- [ ] get: All current names of this and that",
      "  ```md",
      "  - get-result: Example inside fence",
      "  ```",
      "  - get-mode: refresh",
      "  - get-result: Legacy",
      "",
    ].join("\n");
    const { context, writeText } = createContext({
      source,
      subItems: [
        { text: "get-mode: refresh", line: 5, depth: 1 },
        { text: "get-result: Legacy", line: 6, depth: 1 },
      ],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["This","That"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe([
      "- [ ] get: All current names of this and that",
      "  ```md",
      "  - get-result: Example inside fence",
      "  ```",
      "  - get-mode: refresh",
      "  - get-result: This",
      "  - get-result: That",
      "",
    ].join("\n"));
  });

  it("keeps legacy inline-coded get-result metadata byte-stable in reuse mode", async () => {
    const source = "- [ ] get: All current names of this and that\n  - get-result: `core: [parser]*module*`\n";
    const { context, writeText, runWorker } = createContext({
      source,
      subItems: [{ text: "get-result: `core: [parser]*module*`", line: 2, depth: 1 }],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["ShouldNotRun"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(runWorker).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("rewrites legacy inline-coded get-result metadata to canonical escaping in refresh mode", async () => {
    const source = [
      "- [ ] get: All current names of this and that",
      "  - get-mode: refresh",
      "  - get-result: `core: [parser]*module*`",
      "",
    ].join("\n");
    const { context, writeText } = createContext({
      source,
      subItems: [
        { text: "get-mode: refresh", line: 2, depth: 1 },
        { text: "get-result: `core: [parser]*module*`", line: 3, depth: 1 },
      ],
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["core: [parser]*module*"]}',
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    const updated = writeText.mock.calls[0]?.[1] ?? "";
    expect(updated).toContain("  - get-result: core: \\[parser\\]\\*module\\*");
    expect(updated).not.toContain("  - get-result: `core: [parser]*module*`");

    const reparsed = parseTasks(updated, "C:/workspace/todo.md")[0];
    expect(reparsed?.subItems[0]?.text).toBe("get-mode: refresh");
    expect(reparsed?.subItems[1]?.text).toBe("get-result: core: [parser]*module*");
  });

  it("ignores tilde-fenced get-result-like lines in worker output parsing", async () => {
    const source = "- [ ] get: All current names of this and that\n";
    const { context, writeText } = createContext({
      source,
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: [
          "~~~md",
          "- get-result: Example inside fence",
          "~~~",
          "- Actual",
        ].join("\n"),
        stderr: "",
      })),
    });

    const result = await getHandler(context);

    expect(result).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(writeText.mock.calls[0]?.[1] ?? "").toBe([
      "- [ ] get: All current names of this and that",
      "  - get-result: Actual",
      "",
    ].join("\n"));
  });

  it("round-trips escaped get-result values through parser and deterministic rerun", async () => {
    const source = "- [ ] get: All current names of this and that\n";
    const firstRun = createContext({
      source,
      runWorker: vi.fn(async () => ({
        exitCode: 0,
        stdout: '{"results":["`edge` : [parser]*module*"]}',
        stderr: "",
      })),
    });

    const firstResult = await getHandler(firstRun.context);
    expect(firstResult).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });

    const writtenSource = firstRun.writeText.mock.calls[0]?.[1] ?? "";
    const reparsedTask = parseTasks(writtenSource, "C:/workspace/todo.md")[0];
    const secondRunWorker = vi.fn(async () => ({
      exitCode: 0,
      stdout: '{"results":["ShouldNotRun"]}',
      stderr: "",
    }));

    const secondRun = createContext({
      source: writtenSource,
      subItems: (reparsedTask?.subItems ?? []).map((subItem) => ({
        text: subItem.text,
        line: subItem.line,
        depth: subItem.depth,
      })),
      runWorker: secondRunWorker,
    });

    const secondResult = await getHandler(secondRun.context);

    expect(secondResult).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
    expect(secondRunWorker).not.toHaveBeenCalled();
    expect(secondRun.writeText).not.toHaveBeenCalled();
  });
});
