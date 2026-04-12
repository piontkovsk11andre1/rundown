import { describe, expect, it, vi } from "vitest";
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
    const { context, writeText, runWorker } = createContext({
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
  });

  it("refreshes existing get-result sub-items when get-mode is refresh", async () => {
    const source = "- [ ] get: All current names of this and that\n  - get-mode: refresh\n  - get-result: This\n";
    const { context, writeText, runWorker } = createContext({
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
    expect(writeText).toHaveBeenCalledTimes(1);
    const writtenSource = writeText.mock.calls[0]?.[1] ?? "";
    expect(writtenSource).toBe(
      "- [ ] get: All current names of this and that\n"
      + "  - get-mode: refresh\n"
      + "  - get-result: That\n",
    );
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
    const { context, writeText, runWorker } = createContext({
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
  });

  it("wraps markdown-significant get-result values so parsed sub-items round-trip", async () => {
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
      + "  - get-result: `core: [parser]*module*`\n",
    );

    const reparsed = parseTasks(writtenSource, "C:/workspace/todo.md")[0];
    expect(reparsed?.subItems[0]?.text).toBe("get-result: core: [parser]*module*");
    expect(reparsed?.children).toEqual([]);
  });

  it("uses larger code fences when get-result values contain backticks", async () => {
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
      + "  - get-result: ``name with `tick` and : colon``\n",
    );
  });

  it("persists an explicit empty marker when extraction succeeds but returns no values", async () => {
    const { context, writeText } = createContext({
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
  });

  it("fails empty extraction when get-empty policy is fail", async () => {
    const { context, writeText } = createContext({
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
});
