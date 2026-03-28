import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createUnlockTask, type UnlockTaskDependencies } from "../../src/application/unlock-task.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/index.js";

describe("unlock-task", () => {
  it("returns 3 when lockfile does not exist", async () => {
    const { dependencies, events } = createDependencies({ lockfileExists: false, activeLock: false });
    const unlockTask = createUnlockTask(dependencies);

    const code = await unlockTask({ source: "tasks.md" });

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "info" && event.message.includes("No lockfile found"))).toBe(true);
    expect(vi.mocked(dependencies.fileLock.forceRelease)).not.toHaveBeenCalled();
  });

  it("returns 1 when lock is actively held", async () => {
    const { dependencies, events } = createDependencies({ lockfileExists: true, activeLock: true });
    const unlockTask = createUnlockTask(dependencies);

    const code = await unlockTask({ source: "tasks.md" });

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("currently held"))).toBe(true);
    expect(vi.mocked(dependencies.fileLock.forceRelease)).not.toHaveBeenCalled();
  });

  it("force releases stale lock and returns 0", async () => {
    const { dependencies, events } = createDependencies({ lockfileExists: true, activeLock: false });
    const unlockTask = createUnlockTask(dependencies);

    const code = await unlockTask({ source: "tasks.md" });

    expect(code).toBe(0);
    expect(vi.mocked(dependencies.fileLock.forceRelease)).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.kind === "success" && event.message.includes("Released stale source lock"))).toBe(true);
  });
});

function createDependencies(options: { lockfileExists: boolean; activeLock: boolean }): {
  dependencies: UnlockTaskDependencies;
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];

  const dependencies: UnlockTaskDependencies = {
    fileLock: {
      acquire: vi.fn(),
      isLocked: vi.fn(() => options.activeLock),
      release: vi.fn(),
      forceRelease: vi.fn(),
      releaseAll: vi.fn(),
    },
    fileSystem: {
      exists: vi.fn(() => options.lockfileExists),
      readText: vi.fn(),
      writeText: vi.fn(),
      mkdir: vi.fn(),
      readdir: vi.fn(() => []),
      stat: vi.fn(() => null),
      unlink: vi.fn(),
      rm: vi.fn(),
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

  return { dependencies, events };
}
