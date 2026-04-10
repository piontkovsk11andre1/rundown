import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type { FileSystem } from "../../src/domain/ports/index.js";

import {
  captureCheckboxState,
  checkTaskUsingFileSystem,
  countCheckedTasks,
  insertTraceStatisticsUsingFileSystem,
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

  it("serializes re-entrant checkbox updates on the same file without losing writes", () => {
    const filePath = "todo.md";
    const taskOne = createTask({ text: "First task", line: 1, index: 0, file: filePath });
    const taskTwo = createTask({ text: "Second task", line: 2, index: 1, file: filePath });

    let source = "- [ ] First task\n- [ ] Second task\n";
    let nestedUpdateTriggered = false;

    const fileSystem: FileSystem = {
      exists: (path) => path === filePath,
      readText: (path) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        return source;
      },
      writeText: (path, content) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        // Simulate a second task completing while the first update is in-flight.
        if (!nestedUpdateTriggered) {
          nestedUpdateTriggered = true;
          checkTaskUsingFileSystem(taskTwo, fileSystem);
        }

        source = content;
      },
      mkdir: () => undefined,
      readdir: () => [],
      stat: () => null,
      unlink: () => undefined,
      rm: () => undefined,
    };

    checkTaskUsingFileSystem(taskOne, fileSystem);

    expect(source).toBe("- [x] First task\n- [x] Second task\n");
  });

  it("does not block re-entrant updates across different files", () => {
    const fileOne = "one.md";
    const fileTwo = "two.md";
    const taskOne = createTask({ text: "First task", line: 1, index: 0, file: fileOne });
    const taskTwo = createTask({ text: "Second task", line: 1, index: 0, file: fileTwo });

    let sourceOne = "- [ ] First task\n";
    let sourceTwo = "- [ ] Second task\n";
    let nestedUpdateTriggered = false;
    const writeEvents: string[] = [];

    const fileSystem: FileSystem = {
      exists: (path) => path === fileOne || path === fileTwo,
      readText: (path) => {
        if (path === fileOne) {
          return sourceOne;
        }

        if (path === fileTwo) {
          return sourceTwo;
        }

        throw new Error(`File not found: ${path}`);
      },
      writeText: (path, content) => {
        if (path === fileOne) {
          writeEvents.push("one:start");
          if (!nestedUpdateTriggered) {
            nestedUpdateTriggered = true;
            checkTaskUsingFileSystem(taskTwo, fileSystem);
          }
          sourceOne = content;
          writeEvents.push("one:end");
          return;
        }

        if (path === fileTwo) {
          sourceTwo = content;
          writeEvents.push("two");
          return;
        }

        throw new Error(`File not found: ${path}`);
      },
      mkdir: () => undefined,
      readdir: () => [],
      stat: () => null,
      unlink: () => undefined,
      rm: () => undefined,
    };

    checkTaskUsingFileSystem(taskOne, fileSystem);

    expect(sourceOne).toBe("- [x] First task\n");
    expect(sourceTwo).toBe("- [x] Second task\n");
    expect(writeEvents).toEqual(["one:start", "two", "one:end"]);
  });

  it("drains queued same-file updates and clears idle queue state after an in-flight failure", () => {
    const filePath = "todo.md";
    const taskOne = createTask({ text: "First task", line: 1, index: 0, file: filePath });
    const taskTwo = createTask({ text: "Second task", line: 2, index: 1, file: filePath });
    const taskThree = createTask({ text: "Third task", line: 3, index: 2, file: filePath });

    let source = "- [ ] First task\n- [ ] Second task\n- [ ] Third task\n";
    let nestedUpdatesTriggered = false;
    let shouldFailSecondTaskWrite = true;

    const fileSystem: FileSystem = {
      exists: (path) => path === filePath,
      readText: (path) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        return source;
      },
      writeText: (path, content) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        if (!nestedUpdatesTriggered) {
          nestedUpdatesTriggered = true;
          checkTaskUsingFileSystem(taskTwo, fileSystem);
          checkTaskUsingFileSystem(taskThree, fileSystem);
        }

        if (shouldFailSecondTaskWrite && content.includes("- [x] Second task") && !content.includes("- [x] Third task")) {
          shouldFailSecondTaskWrite = false;
          throw new Error("simulated write failure for second task");
        }

        source = content;
      },
      mkdir: () => undefined,
      readdir: () => [],
      stat: () => null,
      unlink: () => undefined,
      rm: () => undefined,
    };

    expect(() => checkTaskUsingFileSystem(taskOne, fileSystem)).toThrow("simulated write failure for second task");

    // Third update should still run even though the second queued update failed.
    expect(source).toBe("- [x] First task\n- [ ] Second task\n- [x] Third task\n");

    // A follow-up mutation should execute normally (no stale queued work left behind).
    checkTaskUsingFileSystem(taskTwo, fileSystem);
    expect(source).toBe("- [x] First task\n- [x] Second task\n- [x] Third task\n");
  });

  it("releases same-file mutex when read throws", () => {
    const filePath = "todo.md";
    const task = createTask({ text: "Only task", line: 1, index: 0, file: filePath });

    let source = "- [ ] Only task\n";
    let failReadOnce = true;

    const fileSystem: FileSystem = {
      exists: (path) => path === filePath,
      readText: (path) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        if (failReadOnce) {
          failReadOnce = false;
          throw new Error("simulated read failure");
        }

        return source;
      },
      writeText: (path, content) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        source = content;
      },
      mkdir: () => undefined,
      readdir: () => [],
      stat: () => null,
      unlink: () => undefined,
      rm: () => undefined,
    };

    expect(() => checkTaskUsingFileSystem(task, fileSystem)).toThrow("simulated read failure");

    // Follow-up update proves the lock was released after the read failure.
    checkTaskUsingFileSystem(task, fileSystem);
    expect(source).toBe("- [x] Only task\n");
  });

  it("releases same-file mutex when parse throws", () => {
    const filePath = "todo.md";
    const task = createTask({ text: "end: done", line: 1, index: 0, file: filePath, checked: true });

    let source: string | null = "- [x] end: done\n- [ ] Next task\n";
    let failParseOnce = true;

    const fileSystem: FileSystem = {
      exists: (path) => path === filePath,
      readText: (path) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        if (failParseOnce) {
          failParseOnce = false;
          return source as unknown as string;
        }

        return "- [x] end: done\n- [ ] Next task\n";
      },
      writeText: (path, content) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        source = content;
      },
      mkdir: () => undefined,
      readdir: () => [],
      stat: () => null,
      unlink: () => undefined,
      rm: () => undefined,
    };

    source = null;
    expect(() => skipRemainingSiblingsUsingFileSystem(task, "done", fileSystem)).toThrow();

    // Follow-up mutation proves the lock was released after parser failure.
    const result = skipRemainingSiblingsUsingFileSystem(task, "done", fileSystem);
    expect(result).toEqual({
      skippedSiblingCount: 1,
      skippedDescendantCount: 0,
      skippedTaskTexts: ["Next task"],
    });
    expect(source).toBe("- [x] end: done\n- [x] Next task\n  - skipped: done\n");
  });

  it("releases same-file mutex when write throws", () => {
    const filePath = "todo.md";
    const task = createTask({ text: "Only task", line: 1, index: 0, file: filePath });

    let source = "- [ ] Only task\n";
    let failWriteOnce = true;

    const fileSystem: FileSystem = {
      exists: (path) => path === filePath,
      readText: (path) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        return source;
      },
      writeText: (path, content) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        if (failWriteOnce) {
          failWriteOnce = false;
          throw new Error("simulated write failure");
        }

        source = content;
      },
      mkdir: () => undefined,
      readdir: () => [],
      stat: () => null,
      unlink: () => undefined,
      rm: () => undefined,
    };

    expect(() => checkTaskUsingFileSystem(task, fileSystem)).toThrow("simulated write failure");

    // Follow-up update proves the lock was released after the write failure.
    checkTaskUsingFileSystem(task, fileSystem);
    expect(source).toBe("- [x] Only task\n");
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

  it("inserts trace statistics after existing descendant block", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - note: existing",
        "  - [x] Child",
        "    - child note",
        "- [ ] Next task",
      ].join("\n"),
    });
    const task = createTask({
      text: "Parent",
      line: 1,
      index: 0,
      file: "todo.md",
      checked: true,
    });

    insertTraceStatisticsUsingFileSystem(task, [
      "    - total time: 5s",
      "        - execution: 2s",
      "    - tokens estimated: 42",
    ], fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] Parent",
      "  - note: existing",
      "  - [x] Child",
      "    - child note",
      "  - total time: 5s",
      "    - execution: 2s",
      "  - tokens estimated: 42",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("skips reinsertion when task already has trace statistics", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - note: existing",
        "  - total time: 2s",
        "    - execution: 1s",
        "  - tokens estimated: 10",
        "- [ ] Next task",
      ].join("\n"),
    });
    const task = createTask({
      text: "Parent",
      line: 1,
      index: 0,
      file: "todo.md",
      checked: true,
    });

    insertTraceStatisticsUsingFileSystem(task, [
      "    - total time: 5s",
      "        - execution: 2s",
      "    - tokens estimated: 42",
    ], fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] Parent",
      "  - note: existing",
      "  - total time: 2s",
      "    - execution: 1s",
      "  - tokens estimated: 10",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("removes prior trace statistics during checkbox reset", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - note: existing",
        "  - total time: 5s",
        "    - execution: 2s",
        "  - tokens estimated: 42",
        "- [x] Next task",
        "  - verify attempts: 1",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Parent",
      "  - note: existing",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("marks a single remaining sibling as checked and inserts skipped annotation", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] end: no output",
        "- [x] Already done",
        "- [ ] Last task",
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
      skippedDescendantCount: 0,
      skippedTaskTexts: ["Last task"],
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] end: no output",
      "- [x] Already done",
      "- [x] Last task",
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

  it("keeps line references stable while inserting annotations for multiple sibling trees", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] end: no output",
        "- [ ] Sibling one",
        "  - [ ] Child one",
        "- [ ] Sibling two",
        "  - [ ] Child two",
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
      skippedDescendantCount: 2,
      skippedTaskTexts: ["Sibling one", "Sibling two"],
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] end: no output",
      "- [x] Sibling one",
      "  - skipped: no output",
      "  - [x] Child one",
      "    - skipped: no output",
      "- [x] Sibling two",
      "  - skipped: no output",
      "  - [x] Child two",
      "    - skipped: no output",
    ].join("\n"));
  });
});
