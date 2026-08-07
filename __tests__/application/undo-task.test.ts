import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createUndoTask,
  type UndoTaskDependencies,
  type UndoTaskOptions,
} from "../../src/application/undo-task.js";
import type {
  ApplicationOutputEvent,
  ArtifactRunMetadata,
  ArtifactStore,
  FileSystem,
  GitClient,
  TaskVerificationPort,
  WorkerExecutorPort,
} from "../../src/domain/ports/index.js";

describe("undo-task", () => {
  it("undoes --last <n> completed runs", async () => {
    const taskFile = "/workspace/tasks.md";
    const source = [
      "- [x] First task",
      "- [x] Second task",
      "- [ ] Third task",
      "",
    ].join("\n");
    const runs = [
      createRunMetadata({ runId: "run-2", text: "Second task", line: 2, index: 1 }),
      createRunMetadata({ runId: "run-1", text: "First task", line: 1, index: 0 }),
    ];
    const { undoTask, fileSystem, artifactStore } = createDependencies({
      files: { [taskFile]: source },
      runs,
      verifyValid: true,
    });

    const code = await undoTask(createOptions({ last: 2 }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toContain("- [ ] First task");
    expect(fileSystem.readText(taskFile)).toContain("- [ ] Second task");
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        extra: expect.objectContaining({
          undoneRunIds: ["run-2", "run-1"],
          undoneCount: 2,
        }),
      }),
    );
  });

  it("renders undo prompt from artifact data for reversal execution", async () => {
    const taskFile = "/workspace/tasks.md";
    const run = createRunMetadata({
      runId: "run-1",
      text: "Apply schema migration",
      line: 1,
      index: 0,
      executionOutput: "created table users",
    });
    const { undoTask, workerExecutor } = createDependencies({
      files: {
        [taskFile]: "- [x] Apply schema migration\n",
      },
      runs: [run],
      template: "Task: {{taskText}}\nOutput: {{executionOutput}}",
      verifyValid: true,
    });

    const code = await undoTask(createOptions({ runId: "latest" }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Task: Apply schema migration"),
      }),
    );
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Output: created table users"),
      }),
    );
  });

  it("fails and restores checkbox when verification fails", async () => {
    const taskFile = "/workspace/tasks.md";
    const run = createRunMetadata({ runId: "run-1", text: "Rollback flag", line: 1, index: 0 });
    const { undoTask, fileSystem, artifactStore } = createDependencies({
      files: {
        [taskFile]: "- [x] Rollback flag\n",
      },
      runs: [run],
      verifyValid: false,
    });

    const code = await undoTask(createOptions({ runId: "latest" }));

    expect(code).toBe(1);
    expect(fileSystem.readText(taskFile)).toContain("- [x] Rollback flag");
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "failed",
        extra: expect.objectContaining({
          undoneCount: 0,
          error: expect.stringContaining("verification failed"),
        }),
      }),
    );
  });

  it("updates checkbox from checked to unchecked on successful undo", async () => {
    const taskFile = "/workspace/tasks.md";
    const run = createRunMetadata({ runId: "run-1", text: "Cleanup migration", line: 1, index: 0 });
    const { undoTask, fileSystem, taskVerification } = createDependencies({
      files: {
        [taskFile]: "- [x] Cleanup migration\n",
      },
      runs: [run],
      verifyValid: true,
    });

    const code = await undoTask(createOptions({ runId: "latest" }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] Cleanup migration\n");
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(1);
  });

  it("blocks undo when worktree is dirty by default", async () => {
    const taskFile = "/workspace/tasks.md";
    const run = createRunMetadata({ runId: "run-1", text: "Cleanup migration", line: 1, index: 0 });
    const { undoTask, events } = createDependencies({
      files: {
        [taskFile]: "- [x] Cleanup migration\n",
      },
      runs: [run],
      verifyValid: true,
      gitStatusOutput: " M tasks.md\n",
    });

    const code = await undoTask(createOptions({ runId: "latest" }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Working directory is not clean"))).toBe(true);
  });

  it("allows undo with --force when worktree is dirty", async () => {
    const taskFile = "/workspace/tasks.md";
    const run = createRunMetadata({ runId: "run-1", text: "Cleanup migration", line: 1, index: 0 });
    const { undoTask, fileSystem, events } = createDependencies({
      files: {
        [taskFile]: "- [x] Cleanup migration\n",
      },
      runs: [run],
      verifyValid: true,
      gitStatusOutput: " M tasks.md\n",
    });

    const code = await undoTask(createOptions({ runId: "latest", force: true }));

    expect(code).toBe(0);
    expect(fileSystem.readText(taskFile)).toBe("- [ ] Cleanup migration\n");
    expect(events.some((event) => event.kind === "info" && event.message.includes("--force enabled"))).toBe(true);
  });
});

function createDependencies(options: {
  files: Record<string, string>;
  runs: ArtifactRunMetadata[];
  template?: string;
  verifyValid: boolean;
  gitStatusOutput?: string;
}): {
  undoTask: (options: UndoTaskOptions) => Promise<number>;
  fileSystem: FileSystem;
  workerExecutor: WorkerExecutorPort;
  taskVerification: TaskVerificationPort;
  artifactStore: ArtifactStore;
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];
  const files = new Map<string, string>(Object.entries(options.files));

  const fileSystem: FileSystem = {
    exists: vi.fn((filePath: string) => files.has(filePath)),
    readText: vi.fn((filePath: string) => files.get(filePath) ?? ""),
    writeText: vi.fn((filePath: string, content: string) => {
      files.set(filePath, content);
    }),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-undo",
      rootDir: "/workspace/.rundown/runs/run-undo",
      cwd: "/workspace",
      keepArtifacts: false,
      commandName: "undo",
      mode: "wait",
      transport: "pattern",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => ".rundown/runs/run-undo"),
    rootDir: vi.fn(() => "/workspace/.rundown/runs"),
    listSaved: vi.fn(() => options.runs),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => options.runs[0] ?? null),
    find: vi.fn((runId: string) => options.runs.find((run) => run.runId === runId) ?? null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const workerExecutor: WorkerExecutorPort = {
    runWorker: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeInlineCli: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
    executeRundownTask: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
  };

  const taskVerification: TaskVerificationPort = {
    verify: vi.fn(async () => ({ valid: options.verifyValid })),
  };

  const gitClient: GitClient = {
    run: vi.fn(async (args: string[]) => {
      if (args[0] === "rev-parse" && args[1] === "--is-inside-work-tree") {
        return "true\n";
      }
      if (args[0] === "status" && args[1] === "--porcelain") {
        return options.gitStatusOutput ?? "";
      }
      return "";
    }),
  };

  const dependencies: UndoTaskDependencies = {
    artifactStore,
    workerExecutor,
    taskVerification,
    fileSystem,
    gitClient,
    templateLoader: {
      load: vi.fn(() => options.template ?? null),
    },
    workingDirectory: {
      cwd: vi.fn(() => "/workspace"),
    },
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    undoTask: createUndoTask(dependencies),
    fileSystem,
    workerExecutor,
    taskVerification,
    artifactStore,
    events,
  };
}

function createRunMetadata(options: {
  runId: string;
  text: string;
  line: number;
  index: number;
  executionOutput?: string;
}): ArtifactRunMetadata {
  return {
    runId: options.runId,
    rootDir: path.join("/workspace", ".rundown", "runs", options.runId),
    relativePath: `.rundown/runs/${options.runId}`,
    commandName: "run",
    workerCommand: ["opencode", "run"],
    mode: "wait",
    transport: "pattern",
    source: "tasks.md",
    task: {
      text: options.text,
      file: "/workspace/tasks.md",
      line: options.line,
      index: options.index,
      source: "tasks.md",
    },
    keepArtifacts: true,
    startedAt: "2026-04-11T00:00:00.000Z",
    completedAt: "2026-04-11T00:01:00.000Z",
    status: "completed",
    extra: options.executionOutput
      ? { executionOutput: options.executionOutput }
      : undefined,
  };
}

function createOptions(overrides: Partial<UndoTaskOptions>): UndoTaskOptions {
  return {
    runId: "latest",
    last: undefined,
    workerPattern: {
      command: ["opencode", "run"],
      usesBootstrap: false,
      usesFile: false,
      appendFile: true,
    },
    dryRun: false,
    keepArtifacts: false,
    showAgentOutput: false,
    ...overrides,
  };
}
