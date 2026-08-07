import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createUndoTask,
  type UndoTaskDependencies,
  type UndoTaskOptions,
} from "../../src/application/undo-task.js";
import type {
  ApplicationOutputEvent,
  ArtifactStore,
  GitClient,
  TaskVerificationPort,
  WorkerExecutorPort,
} from "../../src/domain/ports/index.js";
import type { ParsedWorkerPattern } from "../../src/domain/worker-pattern.js";
import {
  createFsArtifactStore,
  createFsTemplateLoader,
  createNodeFileSystem,
  createNodePathOperationsAdapter,
} from "../../src/infrastructure/adapters/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  vi.restoreAllMocks();
});

describe("undo-task integration", () => {
  it("undoes only the last N completed runs", async () => {
    const workspace = makeTempWorkspace();
    const taskFile = path.join(workspace, "tasks.md");
    fs.writeFileSync(taskFile, [
      "- [x] First task",
      "- [x] Second task",
      "- [x] Third task",
      "",
    ].join("\n"), "utf-8");

    const { undoTask, artifactStore } = createDependencies(workspace, { verifyValid: true });

    await createCompletedRunArtifact({
      artifactStore,
      workspace,
      taskFile,
      text: "First task",
      line: 1,
      index: 0,
    });
    await sleep(5);
    await createCompletedRunArtifact({
      artifactStore,
      workspace,
      taskFile,
      text: "Second task",
      line: 2,
      index: 1,
    });
    await sleep(5);
    await createCompletedRunArtifact({
      artifactStore,
      workspace,
      taskFile,
      text: "Third task",
      line: 3,
      index: 2,
    });

    const code = await undoTask(createOptions({ runId: "latest", last: 2 }));

    expect(code).toBe(0);
    const updated = fs.readFileSync(taskFile, "utf-8");
    expect(updated).toContain("- [x] First task");
    expect(updated).toContain("- [ ] Second task");
    expect(updated).toContain("- [ ] Third task");
  });

  it("renders undo prompt with execution artifacts", async () => {
    const workspace = makeTempWorkspace();
    const taskFile = path.join(workspace, "tasks.md");
    fs.writeFileSync(taskFile, "- [x] Rebuild index\n", "utf-8");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "undo.md"),
      "Task={{taskText}}\nArtifacts={{executionOutput}}",
      "utf-8",
    );

    const { undoTask, artifactStore, workerExecutor } = createDependencies(workspace, { verifyValid: true });

    await createCompletedRunArtifact({
      artifactStore,
      workspace,
      taskFile,
      text: "Rebuild index",
      line: 1,
      index: 0,
      executionOutput: "created index user_by_email",
    });

    const code = await undoTask(createOptions({ runId: "latest" }));

    expect(code).toBe(0);
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Task=Rebuild index"),
      }),
    );
    expect(vi.mocked(workerExecutor.runWorker)).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining("Artifacts=created index user_by_email"),
      }),
    );
  });

  it("returns failure and restores checkbox when verification fails", async () => {
    const workspace = makeTempWorkspace();
    const taskFile = path.join(workspace, "tasks.md");
    fs.writeFileSync(taskFile, "- [x] Toggle feature flag\n", "utf-8");

    const { undoTask, artifactStore, events } = createDependencies(workspace, { verifyValid: false });

    await createCompletedRunArtifact({
      artifactStore,
      workspace,
      taskFile,
      text: "Toggle feature flag",
      line: 1,
      index: 0,
    });

    const code = await undoTask(createOptions({ runId: "latest" }));

    expect(code).toBe(1);
    expect(fs.readFileSync(taskFile, "utf-8")).toBe("- [x] Toggle feature flag\n");
    expect(events.some((event) => event.kind === "error" && event.message.includes("verification failed"))).toBe(true);
  });

  it("updates checked task to unchecked on successful undo", async () => {
    const workspace = makeTempWorkspace();
    const taskFile = path.join(workspace, "tasks.md");
    fs.writeFileSync(taskFile, "- [x] Remove obsolete migration\n", "utf-8");

    const { undoTask, artifactStore, taskVerification } = createDependencies(workspace, { verifyValid: true });

    await createCompletedRunArtifact({
      artifactStore,
      workspace,
      taskFile,
      text: "Remove obsolete migration",
      line: 1,
      index: 0,
    });

    const code = await undoTask(createOptions({ runId: "latest" }));

    expect(code).toBe(0);
    expect(fs.readFileSync(taskFile, "utf-8")).toBe("- [ ] Remove obsolete migration\n");
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(1);
  });

  it("blocks undo with a dirty worktree unless --force is set", async () => {
    const workspace = makeTempWorkspace();
    const taskFile = path.join(workspace, "tasks.md");
    fs.writeFileSync(taskFile, "- [x] Remove obsolete migration\n", "utf-8");

    const { undoTask, artifactStore, events } = createDependencies(workspace, {
      verifyValid: true,
      gitStatusOutput: " M tasks.md\n",
    });

    await createCompletedRunArtifact({
      artifactStore,
      workspace,
      taskFile,
      text: "Remove obsolete migration",
      line: 1,
      index: 0,
    });

    const code = await undoTask(createOptions({ runId: "latest" }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Working directory is not clean"))).toBe(true);
    expect(fs.readFileSync(taskFile, "utf-8")).toBe("- [x] Remove obsolete migration\n");
  });

  it("allows undo on dirty worktree with --force", async () => {
    const workspace = makeTempWorkspace();
    const taskFile = path.join(workspace, "tasks.md");
    fs.writeFileSync(taskFile, "- [x] Remove obsolete migration\n", "utf-8");

    const { undoTask, artifactStore, events } = createDependencies(workspace, {
      verifyValid: true,
      gitStatusOutput: " M tasks.md\n",
    });

    await createCompletedRunArtifact({
      artifactStore,
      workspace,
      taskFile,
      text: "Remove obsolete migration",
      line: 1,
      index: 0,
    });

    const code = await undoTask(createOptions({ runId: "latest", force: true }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("--force enabled"))).toBe(true);
    expect(fs.readFileSync(taskFile, "utf-8")).toBe("- [ ] Remove obsolete migration\n");
  });
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-undo-int-"));
  tempDirs.push(dir);
  return dir;
}

function createDependencies(
  workspace: string,
  options: {
    verifyValid: boolean;
    gitStatusOutput?: string;
  },
): {
  undoTask: (options: UndoTaskOptions) => Promise<number>;
  artifactStore: ArtifactStore;
  workerExecutor: WorkerExecutorPort;
  taskVerification: TaskVerificationPort;
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];
  const artifactStore = createFsArtifactStore();
  const workerExecutor: WorkerExecutorPort = {
    runWorker: vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })),
    executeInlineCli: vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })),
    executeRundownTask: vi.fn(async () => ({
      exitCode: 0,
      stdout: "",
      stderr: "",
    })),
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
    fileSystem: createNodeFileSystem(),
    gitClient,
    templateLoader: createFsTemplateLoader(),
    workingDirectory: {
      cwd: () => workspace,
    },
    pathOperations: createNodePathOperationsAdapter(),
    configDir: {
      configDir: path.join(workspace, ".rundown"),
      isExplicit: false,
    },
    output: {
      emit: (event) => {
        events.push(event);
      },
    },
  };

  return {
    undoTask: createUndoTask(dependencies),
    artifactStore,
    workerExecutor,
    taskVerification,
    events,
  };
}

async function createCompletedRunArtifact(options: {
  artifactStore: ArtifactStore;
  workspace: string;
  taskFile: string;
  text: string;
  line: number;
  index: number;
  executionOutput?: string;
}): Promise<void> {
  const context = options.artifactStore.createContext({
    cwd: options.workspace,
    configDir: path.join(options.workspace, ".rundown"),
    commandName: "run",
    workerCommand: ["opencode", "run"],
    mode: "wait",
    source: path.basename(options.taskFile),
    task: {
      text: options.text,
      file: options.taskFile,
      line: options.line,
      index: options.index,
      source: path.basename(options.taskFile),
    },
    keepArtifacts: true,
  });
  options.artifactStore.finalize(context, {
    status: "completed",
    preserve: true,
    extra: options.executionOutput
      ? { executionOutput: options.executionOutput }
      : undefined,
  });
}

function createOptions(overrides: Partial<UndoTaskOptions>): UndoTaskOptions {
  return {
    runId: "latest",
    workerPattern: DEFAULT_WORKER_PATTERN,
    ...overrides,
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

const DEFAULT_WORKER_PATTERN: ParsedWorkerPattern = {
  command: ["opencode", "run"],
  usesBootstrap: false,
  usesFile: false,
  appendFile: true,
};
