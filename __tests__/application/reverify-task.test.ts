import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createReverifyTask,
  type ReverifyTaskDependencies,
  type ReverifyTaskOptions,
} from "../../src/application/reverify-task.js";
import type {
  ApplicationOutputEvent,
  ArtifactRunMetadata,
  ArtifactStoreStatus,
  ArtifactStore,
  FileSystem,
  TaskRepairResult,
  VerificationSidecar,
} from "../../src/domain/ports/index.js";
import type { Task } from "../../src/domain/parser.js";

describe("reverify-task", () => {
  it("prints verify prompt and exits without running verification", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n- [x] Build release\n",
    });

    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 2,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification, taskRepair, verificationSidecar } =
      createDependencies({
        cwd,
        fileSystem,
        runs: [completedRun],
      });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", printPrompt: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationSidecar.remove)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "text" && event.text.includes("Build release"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("## Phase"))).toBe(true);
  });

  it("dry-run reports planned command and skips verification execution", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n- [x] Build release\n",
    });

    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 2,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification, taskRepair, verificationSidecar } =
      createDependencies({
        cwd,
        fileSystem,
        runs: [completedRun],
      });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationSidecar.remove)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run - would run verification with: opencode run"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Prompt length:"))).toBe(true);
  });

  it("re-verifies latest completed task and does not mutate markdown checkboxes", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n- [x] Build release\n- [ ] Publish docs\n",
    });

    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 2,
        index: 0,
        source: "roadmap.md",
      },
    });
    const failedRun = createRunMetadata({
      runId: "run-failed",
      status: "verification-failed",
      task: {
        text: "Publish docs",
        file: taskFile,
        line: 3,
        index: 1,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T18:01:00.000Z",
    });

    const { dependencies, events, artifactStore, taskVerification, taskRepair, verificationSidecar } =
      createDependencies({
        cwd,
        fileSystem,
        runs: [failedRun, completedRun],
      });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationSidecar.remove)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "reverify-completed", preserve: false }),
    );
    expect(events.some((event) => event.kind === "success" && event.message === "Re-verification passed.")).toBe(true);
  });

  it("returns 2 with reverify-failed status when verification does not pass", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const { dependencies, artifactStore, taskVerification, taskRepair, verificationSidecar } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(false);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", noRepair: true, repairAttempts: 2 }));

    expect(code).toBe(2);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(taskRepair.repair)).not.toHaveBeenCalled();
    expect(vi.mocked(verificationSidecar.remove)).not.toHaveBeenCalled();
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "reverify-failed", preserve: false }),
    );
  });

  it("returns 3 when no completed saved run can be resolved", async () => {
    const cwd = "/workspace";
    const fileSystem = createInMemoryFileSystem({});
    const failedRun = createRunMetadata({
      runId: "run-failed",
      status: "verification-failed",
      task: {
        text: "Build release",
        file: path.join(cwd, "roadmap.md"),
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, artifactStore, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [failedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(vi.mocked(artifactStore.createContext)).not.toHaveBeenCalled();
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("latest completed"))).toBe(true);
  });

  it("resolves latest target by skipping non-reverifiable saved runs", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });

    const completedWithoutTask = {
      ...createRunMetadata({
        runId: "run-no-task",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      task: undefined,
    } as ArtifactRunMetadata;

    const completedWithTask = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedWithoutTask, completedWithTask],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest", workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ text: "Build release", line: 1, index: 0 }),
    }));
  });

  it("returns 3 when explicit run id points to non-completed run", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });

    const failedRun = createRunMetadata({
      runId: "run-failed",
      status: "verification-failed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
      startedAt: "2026-03-19T17:59:00.000Z",
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [failedRun, completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-failed" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("not completed"))).toBe(true);
  });

  it("returns 3 with actionable error when selected run metadata is missing", async () => {
    const cwd = "/workspace";
    const fileSystem = createInMemoryFileSystem({});
    const runWithMissingMetadata = createRunMetadata({
      runId: "run-metadata-missing",
      status: "metadata-missing",
      task: {
        text: "Build release",
        file: path.join(cwd, "roadmap.md"),
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [runWithMissingMetadata],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-metadata-missing" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("run.json"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("--keep-artifacts"))).toBe(true);
  });

  it("returns 3 with actionable error when selected run has no task metadata", async () => {
    const cwd = "/workspace";
    const fileSystem = createInMemoryFileSystem({});
    const completedRunWithoutTask = {
      ...createRunMetadata({
        runId: "run-no-task",
        status: "completed",
        task: {
          text: "Build release",
          file: path.join(cwd, "roadmap.md"),
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      task: undefined,
    } as ArtifactRunMetadata;

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRunWithoutTask],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-no-task" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("no task metadata"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("different run"))).toBe(true);
  });

  it("returns 3 with actionable error when selected run task metadata is invalid", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n",
    });
    const completedRunWithInvalidTask = {
      ...createRunMetadata({
        runId: "run-invalid-task-metadata",
        status: "completed",
        task: {
          text: "Build release",
          file: taskFile,
          line: 1,
          index: 0,
          source: "roadmap.md",
        },
      }),
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: -1,
        source: "roadmap.md",
      },
    } as ArtifactRunMetadata;

    const { dependencies, events, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRunWithInvalidTask],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-invalid-task-metadata" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("invalid task metadata"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("non-negative integer"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("regenerate runtime artifacts"))).toBe(true);
  });

  it("returns 3 when historical task metadata cannot be resolved in markdown", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Different task text\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
  });

  it("returns 3 when metadata does not uniquely match task text", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "- [x] Build release\n- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 99,
        index: 99,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
  });

  it("returns 3 when metadata file path no longer exists", async () => {
    const cwd = "/workspace";
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: path.join(cwd, "missing.md"),
        line: 1,
        index: 0,
        source: "missing.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem: createInMemoryFileSystem({}),
      runs: [completedRun],
    });

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "latest" }));

    expect(code).toBe(3);
    expect(vi.mocked(taskVerification.verify)).not.toHaveBeenCalled();
  });

  it("resolves moved task by index and text fallback", async () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "roadmap.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "# Roadmap\n\n- [x] Build release\n",
    });
    const completedRun = createRunMetadata({
      runId: "run-completed",
      status: "completed",
      task: {
        text: "Build release",
        file: taskFile,
        line: 1,
        index: 0,
        source: "roadmap.md",
      },
    });

    const { dependencies, taskVerification } = createDependencies({
      cwd,
      fileSystem,
      runs: [completedRun],
    });
    vi.mocked(taskVerification.verify).mockResolvedValue(true);

    const reverifyTask = createReverifyTask(dependencies);
    const code = await reverifyTask(createOptions({ runId: "run-completed", workerCommand: ["opencode", "run"] }));

    expect(code).toBe(0);
    expect(vi.mocked(taskVerification.verify)).toHaveBeenCalledWith(expect.objectContaining({
      task: expect.objectContaining({ text: "Build release", index: 0, line: 3 }),
    }));
  });
});

function createDependencies(options: {
  cwd: string;
  fileSystem: FileSystem;
  runs: ArtifactRunMetadata[];
}): {
  dependencies: ReverifyTaskDependencies;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  taskVerification: { verify: ReturnType<typeof vi.fn> };
  taskRepair: { repair: ReturnType<typeof vi.fn> };
  verificationSidecar: VerificationSidecar;
} {
  const events: ApplicationOutputEvent[] = [];

  const taskVerification = {
    verify: vi.fn(async () => true),
  };

  const taskRepair = {
    repair: vi.fn(async (): Promise<TaskRepairResult> => ({
      valid: false,
      attempts: 0,
    })),
  };

  const verificationSidecar: VerificationSidecar = {
    filePath: vi.fn(() => ""),
    read: vi.fn(() => null),
    remove: vi.fn(),
  };

  const context = {
    runId: "run-reverify",
    rootDir: path.join(options.cwd, ".rundown", "runs", "run-reverify"),
    cwd: options.cwd,
    keepArtifacts: false,
    commandName: "reverify",
    workerCommand: ["opencode", "run"],
    mode: "wait",
    transport: "file",
  };

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => context),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => ".rundown/runs/run-reverify"),
    rootDir: vi.fn(() => path.join(options.cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => options.runs),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => options.runs[0] ?? null),
    find: vi.fn((runId: string) => options.runs.find((run) => run.runId === runId) ?? null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const dependencies: ReverifyTaskDependencies = {
    artifactStore,
    taskVerification,
    taskRepair,
    verificationSidecar,
    workingDirectory: {
      cwd: vi.fn(() => options.cwd),
    },
    fileSystem: options.fileSystem,
    pathOperations: {
      join: (...parts) => path.join(...parts),
      resolve: (...parts) => path.resolve(...parts),
      dirname: (filePath) => path.dirname(filePath),
      relative: (from, to) => path.relative(from, to),
      isAbsolute: (filePath) => path.isAbsolute(filePath),
    },
    templateLoader: {
      load: vi.fn(() => null),
    },
    output: {
      emit: (event) => {
        events.push(event);
      },
    },
  };

  return {
    dependencies,
    events,
    artifactStore,
    taskVerification,
    taskRepair,
    verificationSidecar,
  };
}

function createRunMetadata(options: {
  runId: string;
  status: ArtifactStoreStatus;
  task: {
    text: string;
    file: string;
    line: number;
    index: number;
    source: string;
  };
  startedAt?: string;
}): ArtifactRunMetadata {
  return {
    runId: options.runId,
    rootDir: path.join("/workspace", ".rundown", "runs", options.runId),
    relativePath: `.rundown/runs/${options.runId}`,
    commandName: "run",
    workerCommand: ["opencode", "run"],
    mode: "wait",
    transport: "file",
    source: "roadmap.md",
    task: options.task,
    keepArtifacts: true,
    startedAt: options.startedAt ?? "2026-03-19T18:00:00.000Z",
    completedAt: "2026-03-19T18:00:30.000Z",
    status: options.status,
  };
}

function createInMemoryFileSystem(initialFiles: Record<string, string>): FileSystem {
  const files = new Map(Object.entries(initialFiles));

  return {
    exists: vi.fn((filePath: string) => files.has(filePath)),
    readText: vi.fn((filePath: string) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw new Error("ENOENT: " + filePath);
      }
      return content;
    }),
    writeText: vi.fn((filePath: string, content: string) => {
      files.set(filePath, content);
    }),
    mkdir: vi.fn(),
    readdir: vi.fn(() => []),
    stat: vi.fn(() => null),
    unlink: vi.fn(),
    rm: vi.fn(),
  };
}

function createOptions(overrides: Partial<ReverifyTaskOptions>): ReverifyTaskOptions {
  return {
    runId: "latest",
    transport: "file",
    repairAttempts: 0,
    noRepair: false,
    dryRun: false,
    printPrompt: false,
    keepArtifacts: false,
    workerCommand: [],
    ...overrides,
  };
}
