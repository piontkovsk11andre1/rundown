import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FileLockError } from "../../src/domain/ports/file-lock.js";
import {
  createRevertTask,
  type RevertTaskDependencies,
  type RevertTaskOptions,
} from "../../src/application/revert-task.js";
import type {
  ApplicationOutputEvent,
  ArtifactRunMetadata,
  ArtifactStore,
  ArtifactStoreStatus,
  FileLock,
  FileSystem,
  GitClient,
} from "../../src/domain/ports/index.js";

describe("revert-task", () => {
  it("returns 1 for --all with --last", async () => {
    const { revertTask, events } = createDependencies([]);

    const code = await revertTask(createOptions({ all: true, last: 1 }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Cannot combine --all with --last."))).toBe(true);
  });

  it("uses latest snapshot-revertable run when newest completed run has no snapshot metadata", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-newest-no-snapshot",
        status: "completed",
        startedAt: "2026-03-19T18:00:30.000Z",
      }),
      createRunMetadata({
        runId: "run-next-revertable",
        status: "completed",
        startedAt: "2026-03-19T18:00:20.000Z",
        implementationSnapshotTargets: [
          {
            laneKind: "root",
            migrationNumber: 198,
            snapshotPath: "/workspace/implementation/snapshots/root/198",
          },
        ],
      }),
    ];

    const { revertTask, events } = createDependencies(runs);

    const code = await revertTask(createOptions({ runId: "latest", dryRun: true }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-next-revertable"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-newest-no-snapshot"))).toBe(false);
  });

  it("returns 3 for explicit completed run without snapshot metadata", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-no-snapshot", status: "completed" }),
    ];

    const { revertTask, events } = createDependencies(runs);

    const code = await revertTask(createOptions({ runId: "run-no-snapshot" }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("extra.implementationSnapshotTargets"))).toBe(true);
  });

  it("returns 3 for explicit completed run when snapshot payload is missing", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({
        runId: "run-missing-snapshot",
        status: "completed",
        implementationSnapshotTargets: [
          {
            laneKind: "root",
            migrationNumber: 198,
            snapshotPath: "/workspace/implementation/snapshots/root/198-missing",
          },
        ],
      }),
    ];

    const { revertTask, events } = createDependencies(runs);

    const code = await revertTask(createOptions({ runId: "run-missing-snapshot" }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "error" && event.message.includes("payload is missing on disk"))).toBe(true);
  });

  it("acquires and releases implementation and task locks", async () => {
    const run = createRunMetadata({
      runId: "run-1",
      status: "completed",
      implementationSnapshotTargets: [
        {
          laneKind: "root",
          migrationNumber: 198,
          snapshotPath: "/workspace/implementation/snapshots/root/198",
        },
      ],
    });

    const fileLock = createNoopFileLock();
    const { revertTask } = createDependencies([run], { fileLock });

    const code = await revertTask(createOptions({ dryRun: true }));

    expect(code).toBe(0);
    expect(vi.mocked(fileLock.acquire)).toHaveBeenCalledWith(expect.stringMatching(/[\\/]implementation$/), { command: "revert" });
    expect(vi.mocked(fileLock.acquire)).toHaveBeenCalledWith(expect.stringMatching(/[\\/]roadmap\.md$/), { command: "revert" });
    expect(vi.mocked(fileLock.releaseAll)).toHaveBeenCalledTimes(1);
  });

  it("returns 1 when source file lock is held by another process", async () => {
    const run = createRunMetadata({
      runId: "run-1",
      status: "completed",
      implementationSnapshotTargets: [
        {
          laneKind: "root",
          migrationNumber: 198,
          snapshotPath: "/workspace/implementation/snapshots/root/198",
        },
      ],
    });
    const fileLock = createNoopFileLock();
    vi.mocked(fileLock.acquire).mockImplementation(() => {
      throw new FileLockError(
        "/workspace/implementation",
        { pid: 4242, command: "run", startTime: "2026-03-28T07:00:00.000Z" },
      );
    });

    const { revertTask, events } = createDependencies([run], { fileLock });

    const code = await revertTask(createOptions({ dryRun: true }));

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Source file is locked"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("rundown unlock"))).toBe(true);
  });

  it("restores implementation tree from snapshot and preserves snapshots directory", async () => {
    const run = createRunMetadata({
      runId: "run-restore",
      status: "completed",
      implementationSnapshotTargets: [
        {
          laneKind: "root",
          migrationNumber: 198,
          snapshotPath: "/workspace/implementation/snapshots/root/198",
        },
      ],
    });

    const { revertTask, fileSystem } = createDependencies([run], {
      initialFiles: {
        "/workspace/implementation/current.txt": "live",
        "/workspace/implementation/sub/deep.txt": "live-deep",
        "/workspace/implementation/snapshots/keep.txt": "keep",
        "/workspace/implementation/snapshots/root/198/current.txt": "snapshot",
        "/workspace/implementation/snapshots/root/198/sub/deep.txt": "snapshot-deep",
      },
    });

    const code = await revertTask(createOptions({ method: "revert" }));

    expect(code).toBe(0);
    expect(fileSystem.readText("/workspace/implementation/current.txt")).toBe("snapshot");
    expect(fileSystem.readText("/workspace/implementation/sub/deep.txt")).toBe("snapshot-deep");
    expect(fileSystem.readText("/workspace/implementation/snapshots/keep.txt")).toBe("keep");
  });

  it("applies --last after filtering snapshot-revertable runs", async () => {
    const runs: ArtifactRunMetadata[] = [
      createRunMetadata({ runId: "run-1-no-snapshot", status: "completed" }),
      createRunMetadata({
        runId: "run-2",
        status: "completed",
        implementationSnapshotTargets: [
          {
            laneKind: "root",
            migrationNumber: 198,
            snapshotPath: "/workspace/implementation/snapshots/root/198",
          },
        ],
      }),
      createRunMetadata({
        runId: "run-3",
        status: "completed",
        implementationSnapshotTargets: [
          {
            laneKind: "root",
            migrationNumber: 197,
            snapshotPath: "/workspace/implementation/snapshots/root/197",
          },
        ],
      }),
    ];

    const { revertTask, events } = createDependencies(runs);

    const code = await revertTask(createOptions({ last: 1, dryRun: true }));

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-2"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("run-3"))).toBe(false);
  });

  it("records reverted artifact metadata for snapshot restore", async () => {
    const run = createRunMetadata({
      runId: "run-1",
      status: "completed",
      implementationSnapshotTargets: [
        {
          laneKind: "root",
          migrationNumber: 198,
          snapshotPath: "/workspace/implementation/snapshots/root/198",
        },
      ],
    });

    const { revertTask, artifactStore } = createDependencies([run]);

    const code = await revertTask(createOptions({ method: "reset", keepArtifacts: true }));

    expect(code).toBe(0);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "reverted",
        preserve: true,
        extra: expect.objectContaining({
          method: "snapshot-restore",
          requestedMethod: "reset",
          runIds: ["run-1"],
          revertedRunIds: ["run-1"],
          revertedCount: 1,
          restoredSnapshotPath: "/workspace/implementation/snapshots/root/198",
        }),
      }),
    );
  });

  it("finalizes revert-failed when snapshot restore fails", async () => {
    const run = createRunMetadata({
      runId: "run-1",
      status: "completed",
      implementationSnapshotTargets: [
        {
          laneKind: "root",
          migrationNumber: 198,
          snapshotPath: "/workspace/implementation/snapshots/root/198",
        },
      ],
    });

    const { revertTask, artifactStore, fileSystem } = createDependencies([run], {
      initialFiles: {
        "/workspace/implementation/current.txt": "live",
      },
    });
    vi.mocked(fileSystem.readText).mockImplementation((filePath: string) => {
      if (filePath.replace(/\\/g, "/").endsWith("/implementation/snapshots/root/198/current.txt")) {
        throw new Error("read failure");
      }
      return "ok";
    });

    const code = await revertTask(createOptions({ method: "revert", keepArtifacts: true }));

    expect(code).toBe(1);
    expect(vi.mocked(artifactStore.finalize)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "revert-failed",
        preserve: true,
        extra: expect.objectContaining({
          method: "snapshot-restore",
          runIds: ["run-1"],
          attemptedRunIds: ["run-1"],
          revertedRunIds: [],
          revertedCount: 0,
          failedRunId: "run-1",
        }),
      }),
    );
  });
});

function createDependencies(
  runs: ArtifactRunMetadata[],
  options: {
    cwd?: string;
    configDir?: { configDir: string; isExplicit: boolean };
    fileLock?: FileLock;
    initialFiles?: Record<string, string>;
  } = {},
): {
  revertTask: (options: RevertTaskOptions) => Promise<number>;
  events: ApplicationOutputEvent[];
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
} {
  const cwd = options.cwd ?? "/workspace";
  const events: ApplicationOutputEvent[] = [];

  const artifactStore: ArtifactStore = {
    createContext: vi.fn(() => ({
      runId: "run-revert",
      rootDir: path.join(cwd, ".rundown", "runs", "run-revert"),
      cwd,
      keepArtifacts: false,
      commandName: "revert",
      mode: "wait",
      transport: "file",
    })),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(() => ".rundown/runs/run-revert"),
    rootDir: vi.fn(() => path.join(cwd, ".rundown", "runs")),
    listSaved: vi.fn(() => runs),
    listFailed: vi.fn(() => []),
    latest: vi.fn(() => runs[0] ?? null),
    find: vi.fn((runId: string) => runs.find((run) => run.runId === runId) ?? null),
    removeSaved: vi.fn(() => 0),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };

  const gitClient: GitClient = {
    run: vi.fn(async () => ""),
  };

  const fileSystem = createInMemoryFileSystem({
    cwd,
    initialFiles: options.initialFiles,
  });

  const dependencies: RevertTaskDependencies = {
    artifactStore,
    gitClient,
    configDir: options.configDir,
    workingDirectory: {
      cwd: vi.fn(() => cwd),
    },
    fileLock: options.fileLock ?? createNoopFileLock(),
    fileSystem,
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
    revertTask: createRevertTask(dependencies),
    events,
    artifactStore,
    fileSystem,
  };
}

function createNoopFileLock(): FileLock {
  return {
    acquire: vi.fn(),
    isLocked: vi.fn(() => false),
    release: vi.fn(),
    forceRelease: vi.fn(),
    releaseAll: vi.fn(),
  };
}

function createRunMetadata(options: {
  runId: string;
  status: ArtifactStoreStatus;
  startedAt?: string;
  implementationSnapshotTargets?: Array<{
    laneKind: "root" | "thread";
    threadSlug?: string;
    migrationNumber: number;
    snapshotPath: string;
  }>;
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
    task: {
      text: "Do work",
      file: "/workspace/roadmap.md",
      line: 1,
      index: 0,
      source: "roadmap.md",
    },
    keepArtifacts: true,
    startedAt: options.startedAt ?? "2026-03-19T18:00:00.000Z",
    completedAt: "2026-03-19T18:00:30.000Z",
    status: options.status,
    extra: options.implementationSnapshotTargets
      ? { implementationSnapshotTargets: options.implementationSnapshotTargets }
      : undefined,
  };
}

function createInMemoryFileSystem(input: {
  cwd: string;
  initialFiles?: Record<string, string>;
}): FileSystem {
  const normalize = (targetPath: string): string => {
    const withSlashes = targetPath.replace(/\\/g, "/");
    const withoutDrive = withSlashes.replace(/^[A-Za-z]:/, "");
    const rooted = withoutDrive.startsWith("/") ? withoutDrive : "/" + withoutDrive;
    return path.posix.normalize(rooted);
  };
  const toAbsolute = (targetPath: string): string => normalize(path.isAbsolute(targetPath) ? targetPath : path.join(input.cwd, targetPath));
  const fileMap = new Map<string, string>();
  const dirSet = new Set<string>();
  const ensureDir = (dirPath: string): void => {
    const absolute = toAbsolute(dirPath);
    const parts = absolute.split("/").filter((part) => part.length > 0);
    let current = "";
    dirSet.add("/");
    for (const part of parts) {
      current = current + "/" + part;
      dirSet.add(current);
    }
  };

  ensureDir("/workspace");
  ensureDir("/workspace/.rundown");
  ensureDir("/workspace/implementation");
  ensureDir("/workspace/implementation/snapshots");
  ensureDir("/workspace/implementation/snapshots/root");
  ensureDir("/workspace/migrations");

  const defaultSnapshot = "/workspace/implementation/snapshots/root/198/current.txt";
  fileMap.set(toAbsolute(defaultSnapshot), "snapshot-default");
  ensureDir(path.posix.dirname(defaultSnapshot));

  for (const [filePath, content] of Object.entries(input.initialFiles ?? {})) {
    const absolutePath = toAbsolute(filePath);
    ensureDir(path.posix.dirname(absolutePath));
    fileMap.set(absolutePath, content);
  }

  const fsPort: FileSystem = {
    exists: vi.fn((targetPath: string) => {
      const absolute = toAbsolute(targetPath);
      return fileMap.has(absolute) || dirSet.has(absolute);
    }),
    readText: vi.fn((filePath: string) => {
      const absolute = toAbsolute(filePath);
      const value = fileMap.get(absolute);
      if (value === undefined) {
        throw new Error("ENOENT: no such file or directory, open '" + absolute + "'");
      }
      return value;
    }),
    writeText: vi.fn((filePath: string, content: string) => {
      const absolute = toAbsolute(filePath);
      ensureDir(path.posix.dirname(absolute));
      fileMap.set(absolute, content);
    }),
    mkdir: vi.fn((dirPath: string) => {
      ensureDir(dirPath);
    }),
    readdir: vi.fn((dirPath: string) => {
      const absoluteDir = toAbsolute(dirPath);
      if (!dirSet.has(absoluteDir)) {
        return [];
      }
      const seen = new Map<string, { name: string; isFile: boolean; isDirectory: boolean }>();
      const prefix = absoluteDir === "/" ? "/" : absoluteDir + "/";

      for (const directoryPath of dirSet) {
        if (!directoryPath.startsWith(prefix) || directoryPath === absoluteDir) {
          continue;
        }
        const relative = directoryPath.slice(prefix.length);
        if (!relative || relative.includes("/")) {
          continue;
        }
        seen.set(relative, { name: relative, isFile: false, isDirectory: true });
      }
      for (const filePath of fileMap.keys()) {
        if (!filePath.startsWith(prefix)) {
          continue;
        }
        const relative = filePath.slice(prefix.length);
        if (!relative || relative.includes("/")) {
          continue;
        }
        if (!seen.has(relative)) {
          seen.set(relative, { name: relative, isFile: true, isDirectory: false });
        }
      }

      return Array.from(seen.values());
    }),
    stat: vi.fn((targetPath: string) => {
      const absolute = toAbsolute(targetPath);
      if (fileMap.has(absolute)) {
        return {
          isFile: true,
          isDirectory: false,
        };
      }
      if (dirSet.has(absolute)) {
        return {
          isFile: false,
          isDirectory: true,
        };
      }
      return null;
    }),
    unlink: vi.fn((filePath: string) => {
      const absolute = toAbsolute(filePath);
      fileMap.delete(absolute);
    }),
    rm: vi.fn((targetPath: string) => {
      const absolute = toAbsolute(targetPath);
      for (const filePath of Array.from(fileMap.keys())) {
        if (filePath === absolute || filePath.startsWith(absolute + "/")) {
          fileMap.delete(filePath);
        }
      }
      for (const directoryPath of Array.from(dirSet.values())) {
        if (directoryPath === absolute || directoryPath.startsWith(absolute + "/")) {
          dirSet.delete(directoryPath);
        }
      }
      dirSet.add("/");
    }),
  };

  return fsPort;
}

function createOptions(overrides: Partial<RevertTaskOptions>): RevertTaskOptions {
  return {
    runId: "latest",
    last: undefined,
    all: false,
    method: "revert",
    dryRun: false,
    keepArtifacts: false,
    force: false,
    ...overrides,
  };
}
