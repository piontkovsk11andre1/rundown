import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createQueryTask, type QueryTaskDependencies, type QueryTaskOptions } from "../../src/application/query-task.js";
import {
  DEFAULT_QUERY_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
} from "../../src/domain/defaults.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
import type { ApplicationOutputEvent, ArtifactStore, FileSystem } from "../../src/domain/ports/index.js";

describe("query-task", () => {
  it("runs research -> plan -> run with file mode wiring and resolved dir", async () => {
    const cwd = "/workspace/current";
    const requestedDir = "C:\\workspace\\target";
    const resolvedDir = requestedDir;
    const { dependencies, events, artifactStore, fileSystem, researchTask, planTask, runTask } = createDependencies({ cwd });
    const runRoot = "/runs/run-query";

    const queryTask = createQueryTask(dependencies);
    const code = await queryTask(createOptions({
      dir: requestedDir,
      format: "json",
      output: undefined,
      cliTemplateVarArgs: ["query=from-cli", "custom=value"],
      showAgentOutput: false,
      verbose: true,
    }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).toHaveBeenCalledWith({
      commandName: "query",
      cwd: resolvedDir,
      mode: "wait",
      keepArtifacts: false,
    });

    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith(runRoot, { recursive: true });
    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]runs[\\/]run-query[\\/]workdir$/),
      { recursive: true },
    );

    expect(researchTask).toHaveBeenCalledTimes(1);
    expect(planTask).toHaveBeenCalledTimes(1);
    expect(runTask).toHaveBeenCalledTimes(1);

    const researchCallOrder = vi.mocked(researchTask).mock.invocationCallOrder[0];
    const planCallOrder = vi.mocked(planTask).mock.invocationCallOrder[0];
    const runCallOrder = vi.mocked(runTask).mock.invocationCallOrder[0];
    expect(researchCallOrder).toBeLessThan(planCallOrder);
    expect(planCallOrder).toBeLessThan(runCallOrder);

    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]runs[\\/]run-query[\\/]query\.md$/),
      expect.stringContaining("# Query: Is auth enforced?"),
    );
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]runs[\\/]run-query[\\/]query\.md$/),
      expect.stringContaining(`\`${resolvedDir}\``),
    );

    const queryDocumentPath = vi.mocked(fileSystem.writeText).mock.calls[0]?.[0] as string;
    const workdirPath = vi.mocked(fileSystem.mkdir).mock.calls[1]?.[0] as string;

    expect(researchTask).toHaveBeenCalledWith(expect.objectContaining({
      source: queryDocumentPath,
      cwd: resolvedDir,
      cliTemplateVarArgs: expect.arrayContaining([
        "query=from-cli",
        "custom=value",
        `dir=${resolvedDir}`,
        `workdir=${workdirPath}`,
      ]),
    }));

    expect(planTask).toHaveBeenCalledWith(expect.objectContaining({
      source: queryDocumentPath,
      cwd: resolvedDir,
      cliTemplateVarArgs: expect.arrayContaining([
        "query=from-cli",
        "custom=value",
        `dir=${resolvedDir}`,
        `workdir=${workdirPath}`,
      ]),
    }));

    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      source: queryDocumentPath,
      cwd: resolvedDir,
      runAll: true,
      taskTemplateOverride: DEFAULT_QUERY_EXECUTION_TEMPLATE,
      showAgentOutput: false,
    }));

    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-query" }),
      expect.objectContaining({
        status: "completed",
        preserve: false,
      }),
    );
    expect(events).toContainEqual({ kind: "info", message: "Query phase 1/3: research" });
    expect(events).toContainEqual({ kind: "info", message: "Query phase 2/3: plan" });
    expect(events).toContainEqual({ kind: "info", message: "Query phase 3/3: execute (file mode)" });
  });

  it("skips research when requested and uses stream execution template", async () => {
    const { dependencies, events, researchTask, runTask } = createDependencies({ cwd: "/workspace" });
    const queryTask = createQueryTask(dependencies);

    const code = await queryTask(createOptions({
      format: "markdown",
      output: undefined,
      skipResearch: true,
      showAgentOutput: false,
    }));

    expect(code).toBe(0);
    expect(researchTask).not.toHaveBeenCalled();
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      taskTemplateOverride: DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
      showAgentOutput: true,
    }));
    expect(events).toContainEqual({ kind: "info", message: "Query phase 1/3 skipped: research" });
    expect(events).toContainEqual({ kind: "info", message: "Query phase 3/3: execute (stream mode)" });
  });

  it("aggregates file-mode output and returns failure exit code for success-error verdict", async () => {
    const { dependencies, fileSystem, runTask } = createDependencies({ cwd: "/workspace" });
    const queryTask = createQueryTask(dependencies);

    vi.mocked(fileSystem.readdir).mockReturnValue([
      { name: "step-1.md", isFile: true, isDirectory: false },
    ]);
    vi.mocked(fileSystem.readText).mockImplementation((filePath: string) => {
      if (/step-1\.md$/.test(filePath)) {
        return "# Verdict\n\nfailure: coverage missing";
      }
      return "";
    });

    const code = await queryTask(createOptions({
      format: "success-error",
      output: "/tmp/query/result.txt",
      showAgentOutput: false,
    }));

    expect(code).toBe(1);
    expect(runTask).toHaveBeenCalledWith(expect.objectContaining({
      taskTemplateOverride: DEFAULT_QUERY_EXECUTION_TEMPLATE,
      showAgentOutput: false,
    }));
    expect(vi.mocked(fileSystem.mkdir)).toHaveBeenCalledWith("/tmp/query", { recursive: true });
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledWith(
      "/tmp/query/result.txt",
      "failure: coverage missing",
    );
  });
});

function createDependencies(options: { cwd: string }): {
  dependencies: QueryTaskDependencies;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
  researchTask: ReturnType<typeof vi.fn<(options: unknown) => Promise<number>>>;
  planTask: ReturnType<typeof vi.fn<(options: unknown) => Promise<number>>>;
  runTask: ReturnType<typeof vi.fn<(options: unknown) => Promise<number>>>;
} {
  const events: ApplicationOutputEvent[] = [];
  const researchTask = vi.fn(async () => 0);
  const planTask = vi.fn(async () => 0);
  const runTask = vi.fn(async () => 0);

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-query",
      rootDir: "/runs/run-query",
      cwd: options.cwd,
      keepArtifacts: false,
      commandName: "query",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => "/runs/run-query"),
    rootDir: vi.fn(() => "/runs"),
    listSaved: vi.fn(() => []),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => null),
    find: vi.fn(() => null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn((status) => typeof status === "string" && status.includes("failed")),
  };

  const fileSystem: FileSystem = {
    exists: vi.fn(() => true),
    readText: vi.fn(() => ""),
    writeText: vi.fn(),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  const dependencies: QueryTaskDependencies = {
    runTask,
    researchTask,
    planTask,
    artifactStore,
    fileSystem,
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    workingDirectory: {
      cwd: vi.fn(() => options.cwd),
    },
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    dependencies,
    events,
    artifactStore,
    fileSystem,
    researchTask,
    planTask,
    runTask,
  };
}

function createOptions(overrides: Partial<QueryTaskOptions> = {}): QueryTaskOptions {
  return {
    queryText: "Is auth enforced?",
    dir: "/workspace",
    format: "markdown",
    output: undefined,
    skipResearch: false,
    mode: "wait",
    workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
    showAgentOutput: false,
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    varsFileOption: false,
    cliTemplateVarArgs: [],
    trace: false,
    forceUnlock: false,
    ignoreCliBlock: false,
    cliBlockTimeoutMs: undefined,
    scanCount: undefined,
    maxItems: undefined,
    deep: 0,
    verbose: false,
    configDirOption: undefined,
    ...overrides,
  };
}
