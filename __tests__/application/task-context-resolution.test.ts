import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type { ArtifactRunMetadata, ArtifactStore } from "../../src/domain/ports/index.js";
import {
  computeTaskContextMetrics,
  findTaskByFallback,
  resolveLatestCompletedRun,
  resolveTaskContextFromRuntimeMetadata,
  validateRuntimeTaskMetadata,
} from "../../src/application/task-context-resolution.js";
import { createInMemoryFileSystem } from "./run-task-test-helpers.js";

describe("task-context-resolution", () => {
  it("computes task context metrics", () => {
    const cwd = "/workspace";
    const a = path.join(cwd, "a.md");
    const b = path.join(cwd, "b.md");
    const fileSystem = createInMemoryFileSystem({
      [a]: "- [ ] parent\n  - [ ] child\n- [ ] other\n",
      [b]: "- [x] done\n- [ ] todo\n",
    });
    const selectedTask: Task = {
      text: "parent",
      checked: false,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 8,
      file: a,
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    };

    expect(computeTaskContextMetrics([a, b], selectedTask, fileSystem)).toEqual({
      sourceFilesScanned: 2,
      totalUncheckedTasks: 4,
      taskPositionInFile: 1,
      hasSubtasks: true,
    });
  });

  it("validates runtime task metadata", () => {
    expect(validateRuntimeTaskMetadata({
      text: "",
      file: "/workspace/tasks.md",
      line: 1,
      index: 0,
      source: "tasks.md",
    })).toBe("task text is missing.");
    expect(validateRuntimeTaskMetadata({
      text: "task",
      file: "/workspace/tasks.md",
      line: 1,
      index: 0,
      source: "tasks.md",
    })).toBeNull();
  });

  it("resolves task context from runtime metadata", () => {
    const cwd = "/workspace";
    const taskFile = path.join(cwd, "tasks.md");
    const fileSystem = createInMemoryFileSystem({
      [taskFile]: "intro\n- [ ] build release\n",
    });

    const resolved = resolveTaskContextFromRuntimeMetadata(
      {
        text: "build release",
        file: taskFile,
        line: 2,
        index: 0,
        source: "tasks.md",
      },
      cwd,
      fileSystem,
      path,
    );

    expect(resolved?.task.text).toBe("build release");
    expect(resolved?.contextBefore).toBe("intro");
  });

  it("falls back task matching by index+text and unique text", () => {
    const tasks: Task[] = [
      {
        text: "same",
        checked: false,
        index: 0,
        line: 2,
        column: 1,
        offsetStart: 0,
        offsetEnd: 4,
        file: "a",
        isInlineCli: false,
        depth: 0,
        children: [],
        subItems: [],
      },
      {
        text: "same",
        checked: false,
        index: 1,
        line: 4,
        column: 1,
        offsetStart: 0,
        offsetEnd: 4,
        file: "a",
        isInlineCli: false,
        depth: 0,
        children: [],
        subItems: [],
      },
      {
        text: "unique",
        checked: false,
        index: 2,
        line: 6,
        column: 1,
        offsetStart: 0,
        offsetEnd: 6,
        file: "a",
        isInlineCli: false,
        depth: 0,
        children: [],
        subItems: [],
      },
    ];

    expect(findTaskByFallback(tasks, {
      text: "same",
      file: "a",
      line: 1,
      index: 1,
      source: "a",
    })?.line).toBe(4);
    expect(findTaskByFallback(tasks, {
      text: "unique",
      file: "a",
      line: 10,
      index: 10,
      source: "a",
    })?.line).toBe(6);
  });

  it("selects latest completed run with reverifiable task", () => {
    const runs: ArtifactRunMetadata[] = [
      {
        runId: "run-a",
        rootDir: "/a",
        relativePath: "run-a",
        commandName: "run",
        keepArtifacts: false,
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "failed",
      },
      {
        runId: "run-b",
        rootDir: "/b",
        relativePath: "run-b",
        commandName: "run",
        keepArtifacts: true,
        startedAt: "2026-01-01T00:00:00.000Z",
        status: "completed",
        task: {
          text: "task",
          file: "/workspace/tasks.md",
          line: 1,
          index: 0,
          source: "tasks.md",
        },
      },
    ];

    const artifactStore: ArtifactStore = {
      createContext: vi.fn(),
      beginPhase: vi.fn(),
      completePhase: vi.fn(),
      finalize: vi.fn(),
      displayPath: vi.fn(),
      rootDir: vi.fn(),
      listSaved: vi.fn(() => runs),
      listFailed: vi.fn(() => []),
      latest: vi.fn(() => null),
      find: vi.fn(() => null),
      removeSaved: vi.fn(() => 0),
      removeFailed: vi.fn(() => 0),
      isFailedStatus: vi.fn(() => false),
    };

    const resolved = resolveLatestCompletedRun(artifactStore, "/workspace/.rundown");
    expect(resolved?.runId).toBe("run-b");
  });
});
