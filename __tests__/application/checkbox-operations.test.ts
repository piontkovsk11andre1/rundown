import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type { FileSystem } from "../../src/domain/ports/index.js";

import {
  checkTaskUsingFileSystem,
  countCheckedTasks,
  maybeResetFileCheckboxes,
  resetFileCheckboxes,
} from "../../src/application/checkbox-operations.js";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    text: "Do thing",
    checked: false,
    index: 1,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: 10,
    file: "todo.md",
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
    ...overrides,
  };
}

function createFileSystem(initialFiles: Record<string, string>): FileSystem {
  const files = new Map<string, string>(Object.entries(initialFiles));

  return {
    exists: (path) => files.has(path),
    readText: (filePath) => {
      const value = files.get(filePath);
      if (value === undefined) {
        throw new Error(`File not found: ${filePath}`);
      }
      return value;
    },
    writeText: (filePath, content) => {
      files.set(filePath, content);
    },
    mkdir: () => undefined,
    readdir: () => [],
    stat: () => null,
    unlink: () => undefined,
    rm: () => undefined,
  };
}

describe("checkbox-operations", () => {
  it("checks a task in source file", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] First task\n- [ ] Second task\n",
    });
    const task = createTask({ text: "First task", line: 1 });

    checkTaskUsingFileSystem(task, fileSystem);

    expect(fileSystem.readText("todo.md")).toBe("- [x] First task\n- [ ] Second task\n");
  });

  it("counts checked tasks", () => {
    const source = "- [x] A\n- [ ] B\n- [x] C\n";

    expect(countCheckedTasks(source, "todo.md")).toBe(2);
  });

  it("resets checked tasks when present", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [x] A\n- [ ] B\n- [x] C\n",
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe("- [ ] A\n- [ ] B\n- [ ] C\n");
  });

  it("keeps file unchanged when no checked tasks exist", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] A\n- [ ] B\n",
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe("- [ ] A\n- [ ] B\n");
  });

  it("reports dry-run reset count without mutating file", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [x] A\n- [x] B\n",
    });
    const emit = vi.fn();

    const count = maybeResetFileCheckboxes("todo.md", fileSystem, true, emit, "pre-run");

    expect(count).toBe(2);
    expect(fileSystem.readText("todo.md")).toBe("- [x] A\n- [x] B\n");
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Dry run — would reset checkboxes (pre-run) in: todo.md",
    });
  });

  it("resets checkboxes and emits count in normal mode", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [x] A\n- [ ] B\n",
    });
    const emit = vi.fn();

    const count = maybeResetFileCheckboxes("todo.md", fileSystem, false, emit, "post-run");

    expect(count).toBe(1);
    expect(fileSystem.readText("todo.md")).toBe("- [ ] A\n- [ ] B\n");
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Reset 1 checkbox in todo.md.",
    });
  });
});
