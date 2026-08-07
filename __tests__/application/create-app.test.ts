import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
} from "../../src/domain/exit-codes.js";
import {
  createApp,
  type AppPorts,
} from "../../src/create-app.js";
import { parseTasks } from "../../src/domain/parser.js";
import type { FileLock } from "../../src/domain/ports/file-lock.js";
import type { FileSystem } from "../../src/domain/ports/file-system.js";
import type { ProcessRunner } from "../../src/domain/ports/process-runner.js";

describe("createApp", () => {
  it("wires test-double ports into use case factories", async () => {
    const fileSystem = createInMemoryFileSystem();
    const processRunner: ProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "",
      })),
    };

    const app = createApp({
      ports: {
        fileSystem,
        processRunner,
      },
      useCaseFactories: {
        runTask: (ports) => async () => {
          ports.fileSystem.writeText("/tmp/result.txt", "done");
          await ports.processRunner.run({
            command: "mock-worker",
            args: ["--verify"],
            cwd: "/tmp",
            mode: "wait",
          });
          return 0;
        },
      },
    });

    const code = await app.runTask({} as never);

    expect(code).toBe(0);
    expect(fileSystem.readText("/tmp/result.txt")).toBe("done");
    expect(processRunner.run).toHaveBeenCalledTimes(1);
    expect(processRunner.run).toHaveBeenCalledWith({
      command: "mock-worker",
      args: ["--verify"],
      cwd: "/tmp",
      mode: "wait",
    });
  });

  it("passes port overrides through to factories", async () => {
    const fileSystem = createInMemoryFileSystem();
    const processRunner: ProcessRunner = {
      run: vi.fn(async () => ({
        exitCode: 0,
        stdout: "",
        stderr: "",
      })),
    };

    let capturedPorts: AppPorts | undefined;
    const app = createApp({
      ports: { fileSystem, processRunner },
      useCaseFactories: {
        listTasks: (ports) => async () => {
          capturedPorts = ports;
          return 0;
        },
      },
    });

    await app.listTasks({ source: "tasks.md", sortMode: "none", includeAll: false });

    expect(capturedPorts).toBeDefined();
    expect(capturedPorts?.fileSystem).toBe(fileSystem);
    expect(capturedPorts?.processRunner).toBe(processRunner);
  });

  it("passes output port overrides through to factories", async () => {
    const emit = vi.fn();

    const app = createApp({
      ports: {
        output: { emit },
      },
      useCaseFactories: {
        nextTask: (ports) => async () => {
          ports.output.emit({ kind: "info", message: "next-task output" });
          return 0;
        },
      },
    });

    const code = await app.nextTask({} as never);

    expect(code).toBe(0);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({ kind: "info", message: "next-task output" });
  });

  it("exposes compactTask and wires app ports into compact factory", async () => {
    const fileSystem = createInMemoryFileSystem();
    let capturedPorts: AppPorts | undefined;

    const app = createApp({
      ports: {
        fileSystem,
      },
      useCaseFactories: {
        compactTask: (ports) => async () => {
          capturedPorts = ports;
          return 0;
        },
      },
    });

    const code = await app.compactTask({} as never);

    expect(code).toBe(0);
    expect(capturedPorts).toBeDefined();
    expect(capturedPorts?.fileSystem).toBe(fileSystem);
  });

  it("provides a default no-op fileLock port", async () => {
    let capturedPorts: AppPorts | undefined;
    const app = createApp({
      useCaseFactories: {
        listTasks: (ports) => async () => {
          capturedPorts = ports;
          return 0;
        },
      },
    });

    await app.listTasks({ source: "tasks.md", sortMode: "none", includeAll: false });

    expect(capturedPorts).toBeDefined();
    expect(capturedPorts?.fileLock.isLocked("tasks.md")).toBe(false);
    expect(() => capturedPorts?.fileLock.acquire("tasks.md", { command: "run" })).not.toThrow();
    expect(() => capturedPorts?.fileLock.release("tasks.md")).not.toThrow();
    expect(() => capturedPorts?.fileLock.forceRelease("tasks.md")).not.toThrow();
    expect(() => capturedPorts?.fileLock.releaseAll()).not.toThrow();
  });

  it("exposes releaseAllLocks helper that delegates to the file lock port", () => {
    const fileLock: FileLock = {
      acquire: vi.fn(),
      isLocked: vi.fn(() => false),
      release: vi.fn(),
      forceRelease: vi.fn(),
      releaseAll: vi.fn(),
    };

    const app = createApp({
      ports: {
        fileLock,
      },
    });

    app.releaseAllLocks?.();
    expect(fileLock.releaseAll).toHaveBeenCalledTimes(1);
  });

  it("awaitShutdown waits for runs added while shutdown is already in progress", async () => {
    let resolveFirstRun: (() => void) | undefined;
    let resolveSecondRun: (() => void) | undefined;

    const app = createApp({
      useCaseFactories: {
        runTask: () => {
          let invocation = 0;
          return async () => {
            invocation += 1;
            return new Promise<number>((resolve) => {
              if (invocation === 1) {
                resolveFirstRun = () => resolve(0);
                return;
              }

              resolveSecondRun = () => resolve(0);
            });
          };
        },
      },
    });

    const firstRun = app.runTask({} as never);
    const shutdownPromise = app.awaitShutdown?.() ?? Promise.resolve();

    const secondRun = app.runTask({} as never);
    resolveFirstRun?.();

    let shutdownSettled = false;
    void shutdownPromise.then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);

    resolveSecondRun?.();

    await expect(firstRun).resolves.toBe(0);
    await expect(secondRun).resolves.toBe(0);
    await expect(shutdownPromise).resolves.toBeUndefined();
  });

  it("exposes discussTask and wires fileLock into discuss factory", async () => {
    const fileLock: FileLock = {
      acquire: vi.fn(),
      isLocked: vi.fn(() => false),
      release: vi.fn(),
      forceRelease: vi.fn(),
      releaseAll: vi.fn(),
    };

    let capturedPorts: AppPorts | undefined;
    const app = createApp({
      ports: {
        fileLock,
      },
      useCaseFactories: {
        discussTask: (ports) => async () => {
          capturedPorts = ports;
          return 0;
        },
      },
    });

    expect(typeof app.discussTask).toBe("function");
    const code = await app.discussTask({} as never);

    expect(code).toBe(0);
    expect(capturedPorts).toBeDefined();
    expect(capturedPorts?.fileLock).toBe(fileLock);
  });

  it("does not acquire file locks for next (read-only)", async () => {
    const task = parseTasks("- [ ] Read-only task\n", "tasks.md")[0];
    if (!task) {
      throw new Error("Expected task fixture to parse");
    }

    const fileLock: FileLock = {
      acquire: vi.fn(),
      isLocked: vi.fn(() => false),
      release: vi.fn(),
      forceRelease: vi.fn(),
      releaseAll: vi.fn(),
    };

    const app = createApp({
      ports: {
        fileLock,
        sourceResolver: {
          resolveSources: vi.fn(async () => ["tasks.md"]),
        },
        taskSelector: {
          selectNextTask: vi.fn(() => [{
            source: "tasks.md",
            contextBefore: "",
            task,
          }]),
          selectTaskByLocation: vi.fn(() => null),
        },
      },
    });

    const code = await app.nextTask({ source: "tasks.md", sortMode: "name-sort" });

    expect(code).toBe(0);
    expect(fileLock.acquire).not.toHaveBeenCalled();
    expect(fileLock.release).not.toHaveBeenCalled();
    expect(fileLock.forceRelease).not.toHaveBeenCalled();
  });

  it("does not acquire file locks for list (read-only)", async () => {
    const fileLock: FileLock = {
      acquire: vi.fn(),
      isLocked: vi.fn(() => false),
      release: vi.fn(),
      forceRelease: vi.fn(),
      releaseAll: vi.fn(),
    };

    const fileSystem = createInMemoryFileSystem({
      "tasks.md": "- [ ] Read-only task\n",
    });

    const app = createApp({
      ports: {
        fileLock,
        fileSystem,
        sourceResolver: {
          resolveSources: vi.fn(async () => ["tasks.md"]),
        },
      },
    });

    const code = await app.listTasks({ source: "tasks.md", sortMode: "name-sort", includeAll: false });

    expect(code).toBe(0);
    expect(fileLock.acquire).not.toHaveBeenCalled();
    expect(fileLock.release).not.toHaveBeenCalled();
    expect(fileLock.forceRelease).not.toHaveBeenCalled();
  });

  it("runs post-success auto-compaction for runTask when enabled", async () => {
    const runTaskUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);
    const compactTaskUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);

    const app = createApp({
      useCaseFactories: {
        runTask: () => runTaskUseCase,
        compactTask: () => compactTaskUseCase,
      },
    });

    const code = await app.runTask({
      source: "tasks.md",
      mode: "wait",
      workerPattern: { command: ["opencode", "run"], usesBootstrap: false, usesFile: false, appendFile: true },
      sortMode: "name-sort",
      verify: true,
      onlyVerify: false,
      forceExecute: false,
      forceAttempts: 2,
      noRepair: false,
      repairAttempts: 1,
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      varsFileOption: undefined,
      cliTemplateVarArgs: [],
      commitAfterComplete: false,
      commitMode: "per-task",
      runAll: false,
      redo: false,
      resetAfter: false,
      clean: false,
      rounds: 1,
      showAgentOutput: false,
      trace: false,
      traceOnly: false,
      forceUnlock: false,
      ignoreCliBlock: false,
      verbose: false,
      autoCompact: { beforeExit: true },
    });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(runTaskUseCase).toHaveBeenCalledTimes(1);
    expect(compactTaskUseCase).toHaveBeenCalledTimes(1);
    expect(compactTaskUseCase).toHaveBeenCalledWith(expect.objectContaining({
      target: "all",
      dryRun: false,
    }));
  });

  it("returns failure when runTask succeeds but requested auto-compaction fails", async () => {
    const runTaskUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);
    const compactTaskUseCase = vi.fn(async () => EXIT_CODE_FAILURE);

    const app = createApp({
      useCaseFactories: {
        runTask: () => runTaskUseCase,
        compactTask: () => compactTaskUseCase,
      },
    });

    const code = await app.runTask({
      source: "tasks.md",
      mode: "wait",
      workerPattern: { command: ["opencode", "run"], usesBootstrap: false, usesFile: false, appendFile: true },
      sortMode: "name-sort",
      verify: true,
      onlyVerify: false,
      forceExecute: false,
      forceAttempts: 2,
      noRepair: false,
      repairAttempts: 1,
      dryRun: false,
      printPrompt: false,
      keepArtifacts: false,
      varsFileOption: undefined,
      cliTemplateVarArgs: [],
      commitAfterComplete: false,
      commitMode: "per-task",
      runAll: false,
      redo: false,
      resetAfter: false,
      clean: false,
      rounds: 1,
      showAgentOutput: false,
      trace: false,
      traceOnly: false,
      forceUnlock: false,
      ignoreCliBlock: false,
      verbose: false,
      autoCompact: { beforeExit: true },
    });

    expect(code).toBe(EXIT_CODE_FAILURE);
    expect(runTaskUseCase).toHaveBeenCalledTimes(1);
    expect(compactTaskUseCase).toHaveBeenCalledTimes(1);
  });

  it("forwards migrate source mode and runs post-success auto-compaction", async () => {
    const migrateTaskUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);
    const compactTaskUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);

    const app = createApp({
      useCaseFactories: {
        migrateTask: () => migrateTaskUseCase,
        compactTask: () => compactTaskUseCase,
      },
    });

    const code = await app.migrateTask({
      sourceMode: "prediction",
      workerPattern: { command: ["opencode", "run"], usesBootstrap: false, usesFile: false, appendFile: true },
      confirm: false,
      keepArtifacts: false,
      showAgentOutput: false,
      autoCompact: { beforeExit: true },
    });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(migrateTaskUseCase).toHaveBeenCalledTimes(1);
    expect(migrateTaskUseCase).toHaveBeenCalledWith(expect.objectContaining({
      sourceMode: "prediction",
    }));
    expect(compactTaskUseCase).toHaveBeenCalledTimes(1);
  });

  it("hands off startProject success into migrate flow when worker is provided", async () => {
    const startProjectUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);
    const migrateTaskUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);

    const app = createApp({
      useCaseFactories: {
        startProject: () => startProjectUseCase,
        migrateTask: () => migrateTaskUseCase,
      },
    });

    const code = await app.startProject({
      dir: "./workspace-control",
      migrateSourceMode: "prediction",
      migrateWorkerPattern: { command: ["node", "worker"], usesBootstrap: false, usesFile: false, appendFile: true },
      migrateKeepArtifacts: true,
      migrateShowAgentOutput: true,
      migrateConfirm: true,
    });

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(startProjectUseCase).toHaveBeenCalledTimes(1);
    expect(migrateTaskUseCase).toHaveBeenCalledTimes(1);
    expect(migrateTaskUseCase).toHaveBeenCalledWith(expect.objectContaining({
      sourceMode: "prediction",
      workerPattern: { command: ["node", "worker"], usesBootstrap: false, usesFile: false, appendFile: true },
      keepArtifacts: true,
      showAgentOutput: true,
      confirm: true,
    }));
  });

  it("skips migrate handoff after startProject when no worker can be resolved", async () => {
    const startProjectUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);
    const migrateTaskUseCase = vi.fn(async () => EXIT_CODE_SUCCESS);

    const app = createApp({
      ports: {
        fileSystem: createInMemoryFileSystem(),
      },
      useCaseFactories: {
        startProject: () => startProjectUseCase,
        migrateTask: () => migrateTaskUseCase,
      },
    });

    const code = await app.startProject({});

    expect(code).toBe(EXIT_CODE_SUCCESS);
    expect(startProjectUseCase).toHaveBeenCalledTimes(1);
    expect(migrateTaskUseCase).not.toHaveBeenCalled();
  });
});

function createInMemoryFileSystem(initialFiles: Record<string, string> = {}): FileSystem {
  const files = new Map(Object.entries(initialFiles));
  const directories = new Set<string>([".", "/", "/tmp"]);

  return {
    exists(path) {
      return files.has(path) || directories.has(path);
    },
    readText(filePath) {
      const content = files.get(filePath);
      if (content === undefined) {
        throw new Error("ENOENT: " + filePath);
      }

      return content;
    },
    writeText(filePath, content) {
      files.set(filePath, content);
    },
    mkdir(dirPath) {
      directories.add(dirPath);
    },
    readdir() {
      return [];
    },
    stat(path) {
      if (files.has(path)) {
        return {
          isFile: true,
          isDirectory: false,
          birthtimeMs: 0,
          mtimeMs: 0,
        };
      }

      if (directories.has(path)) {
        return {
          isFile: false,
          isDirectory: true,
          birthtimeMs: 0,
          mtimeMs: 0,
        };
      }

      return null;
    },
    unlink(filePath) {
      files.delete(filePath);
    },
    rm(path, options) {
      files.delete(path);
      if (options?.recursive || options?.force) {
        directories.delete(path);
      }
    },
  };
}
