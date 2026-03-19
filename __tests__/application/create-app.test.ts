import { describe, expect, it, vi } from "vitest";
import {
  createApp,
  type AppPorts,
} from "../../src/create-app.js";
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
