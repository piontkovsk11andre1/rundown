import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type { FileSystem } from "../../src/domain/ports/index.js";

import {
  captureCheckboxState,
  checkTaskUsingFileSystem,
  countCheckedTasks,
  maybeResetFileCheckboxes,
  resetFileCheckboxes,
  skipRemainingSiblingsUsingFileSystem,
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

  it("ignores checkboxes inside fenced code blocks", () => {
    const source = [
      "- [ ] Real task",
      "```markdown",
      "- [ ] Example inside fence",
      "- [x] Checked example inside fence",
      "```",
      "- [x] Another real task",
    ].join("\n");

    const snapshot = captureCheckboxState(source);

    expect(snapshot.orderedStates).toEqual([false, true]);
  });

  it("ignores checkboxes inside tilde fenced code blocks", () => {
    const source = [
      "- [ ] Real",
      "~~~",
      "- [x] Fenced",
      "~~~",
      "- [x] Also real",
    ].join("\n");

    const snapshot = captureCheckboxState(source);

    expect(snapshot.orderedStates).toEqual([false, true]);
  });

  it("marks remaining siblings as checked and inserts skipped annotations", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] end: no output",
        "- [ ] Do this",
        "- [ ] Do that",
      ].join("\n"),
    });
    const task = createTask({
      text: "end: no output",
      line: 1,
      index: 0,
      file: "todo.md",
      checked: true,
    });

    const result = skipRemainingSiblingsUsingFileSystem(task, "no output", fileSystem);

    expect(result).toEqual({
      skippedSiblingCount: 2,
      skippedDescendantCount: 0,
      skippedTaskTexts: ["Do this", "Do that"],
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] end: no output",
      "- [x] Do this",
      "  - skipped: no output",
      "- [x] Do that",
      "  - skipped: no output",
    ].join("\n"));
  });

  it("cascades skip checks and annotations to unchecked descendants", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] end: no output",
        "- [ ] Parent sibling",
        "  - [ ] Child one",
        "    - [ ] Grandchild",
        "  - [x] Already checked child",
      ].join("\n"),
    });
    const task = createTask({
      text: "end: no output",
      line: 1,
      index: 0,
      file: "todo.md",
      checked: true,
    });

    const result = skipRemainingSiblingsUsingFileSystem(task, "no output", fileSystem);

    expect(result).toEqual({
      skippedSiblingCount: 1,
      skippedDescendantCount: 2,
      skippedTaskTexts: ["Parent sibling"],
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] end: no output",
      "- [x] Parent sibling",
      "  - skipped: no output",
      "  - [x] Child one",
      "    - skipped: no output",
      "    - [x] Grandchild",
      "      - skipped: no output",
      "  - [x] Already checked child",
    ].join("\n"));
  });
});
