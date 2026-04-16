import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type { FileSystem } from "../../src/domain/ports/index.js";
import * as checkboxDomainModule from "../../src/domain/checkbox.js";
import * as plannerDomainModule from "../../src/domain/planner.js";

import {
  advanceForLoopUsingFileSystem,
  captureCheckboxState,
  checkTaskUsingFileSystem,
  countCheckedTasks,
  insertTraceStatisticsUsingFileSystem,
  maybeResetFileCheckboxes,
  resetFileCheckboxes,
  skipRemainingSiblingsUsingFileSystem,
  writeFixAnnotationToFile,
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

  it("normalizes for-current metadata to the first item when current value is stale", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [ ] for: This, That",
        "  - for-item: This",
        "  - for-item: That",
        "  - for-current: Stale",
        "  - [ ] Do this",
      ].join("\n"),
    });
    const task = createTask({
      text: "for: This, That",
      line: 1,
      index: 0,
      file: "todo.md",
      children: [
        createTask({ text: "Do this", line: 5, index: 1, depth: 1, file: "todo.md" }),
      ],
      subItems: [
        { text: "for-item: This", line: 2, depth: 1 },
        { text: "for-item: That", line: 3, depth: 1 },
        { text: "for-current: Stale", line: 4, depth: 1 },
      ],
    });

    const result = advanceForLoopUsingFileSystem(task, fileSystem);

    expect(result).toEqual({
      advanced: true,
      completed: false,
      current: "This",
      remainingItems: 1,
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] for: This, That",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: This",
      "  - [ ] Do this",
    ].join("\n"));
  });

  it("resets checked loop children before advancing to the next item", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [ ] for: This, That",
        "  - for-item: This",
        "  - for-item: That",
        "  - for-current: This",
        "  - [x] Do this",
        "    - [x] Nested step",
      ].join("\n"),
    });
    const task = createTask({
      text: "for: This, That",
      line: 1,
      index: 0,
      file: "todo.md",
      children: [
        createTask({
          text: "Do this",
          line: 5,
          index: 1,
          depth: 1,
          file: "todo.md",
          checked: true,
          children: [
            createTask({ text: "Nested step", line: 6, index: 2, depth: 2, file: "todo.md", checked: true }),
          ],
        }),
      ],
      subItems: [
        { text: "for-item: This", line: 2, depth: 1 },
        { text: "for-item: That", line: 3, depth: 1 },
        { text: "for-current: This", line: 4, depth: 1 },
      ],
    });

    const result = advanceForLoopUsingFileSystem(task, fileSystem);

    expect(result).toEqual({
      advanced: true,
      completed: false,
      current: "That",
      remainingItems: 0,
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] for: This, That",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: That",
      "  - [ ] Do this",
      "    - [ ] Nested step",
    ].join("\n"));
  });

  it("does not reset checked tasks outside the active loop subtree", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [ ] for: This, That",
        "  - for-item: This",
        "  - for-item: That",
        "  - for-current: This",
        "  - [x] Loop child",
        "- [ ] Unrelated parent",
        "  - [x] Unrelated checked child",
      ].join("\n"),
    });
    const task = createTask({
      text: "for: This, That",
      line: 1,
      index: 0,
      file: "todo.md",
      children: [
        createTask({ text: "Loop child", line: 5, index: 1, depth: 1, file: "todo.md", checked: true }),
      ],
      subItems: [
        { text: "for-item: This", line: 2, depth: 1 },
        { text: "for-item: That", line: 3, depth: 1 },
        { text: "for-current: This", line: 4, depth: 1 },
      ],
    });

    const result = advanceForLoopUsingFileSystem(task, fileSystem);

    expect(result).toEqual({
      advanced: true,
      completed: false,
      current: "That",
      remainingItems: 0,
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] for: This, That",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: That",
      "  - [ ] Loop child",
      "- [ ] Unrelated parent",
      "  - [x] Unrelated checked child",
    ].join("\n"));
  });

  it("does not mutate fenced checkboxes while advancing loop cursor", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [ ] for: This, That",
        "  - for-item: This",
        "  - for-item: That",
        "  - for-current: This",
        "  - [x] Loop child",
        "  ```md",
        "  - [x] Example fenced checkbox",
        "  ```",
      ].join("\n"),
    });
    const task = createTask({
      text: "for: This, That",
      line: 1,
      index: 0,
      file: "todo.md",
      children: [
        createTask({ text: "Loop child", line: 5, index: 1, depth: 1, file: "todo.md", checked: true }),
      ],
      subItems: [
        { text: "for-item: This", line: 2, depth: 1 },
        { text: "for-item: That", line: 3, depth: 1 },
        { text: "for-current: This", line: 4, depth: 1 },
      ],
    });

    const result = advanceForLoopUsingFileSystem(task, fileSystem);

    expect(result).toEqual({
      advanced: true,
      completed: false,
      current: "That",
      remainingItems: 0,
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] for: This, That",
      "  - for-item: This",
      "  - for-item: That",
      "  - for-current: That",
      "  - [ ] Loop child",
      "  ```md",
      "  - [x] Example fenced checkbox",
      "  ```",
    ].join("\n"));
  });

  it("writes fix annotation after marking task checked", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] First task\n- [ ] Second task\n",
    });
    const task = createTask({ text: "First task", line: 1 });

    writeFixAnnotationToFile(task, "Cannot be verified because this is missing", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] First task",
      "  - fix: Cannot be verified because this is missing",
      "- [ ] Second task",
      "",
    ].join("\n"));
  });

  it("applies markChecked before insertSubitems so task line references stay stable", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] First task\n- [ ] Second task\n- [ ] Third task\n",
    });
    const task = createTask({ text: "Second task", line: 2 });
    const markCheckedSpy = vi.spyOn(checkboxDomainModule, "markChecked");
    const insertSubitemsSpy = vi.spyOn(plannerDomainModule, "insertSubitems");

    try {
      writeFixAnnotationToFile(task, "failed", fileSystem);

      expect(markCheckedSpy).toHaveBeenCalledTimes(1);
      expect(insertSubitemsSpy).toHaveBeenCalledTimes(1);
      expect(markCheckedSpy.mock.invocationCallOrder[0]).toBeLessThan(insertSubitemsSpy.mock.invocationCallOrder[0] ?? 0);
      expect(insertSubitemsSpy).toHaveBeenCalledWith(
        "- [ ] First task\n- [x] Second task\n- [ ] Third task\n",
        expect.objectContaining({ line: 2, text: "Second task" }),
        ["fix: failed"],
      );
      expect(fileSystem.readText("todo.md")).toBe([
        "- [ ] First task",
        "- [x] Second task",
        "  - fix: failed",
        "- [ ] Third task",
        "",
      ].join("\n"));
    } finally {
      markCheckedSpy.mockRestore();
      insertSubitemsSpy.mockRestore();
    }
  });

  it("writes fallback fix annotation when failure reason is null", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] First task\n",
    });
    const task = createTask({ text: "First task", line: 1 });

    writeFixAnnotationToFile(task, null, fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] First task",
      "  - fix: Verification failed (no details).",
      "",
    ].join("\n"));
  });

  it("preserves CRLF when writing fix annotation", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] First task\r\n- [ ] Second task\r\n",
    });
    const task = createTask({ text: "First task", line: 1 });

    writeFixAnnotationToFile(task, "failed", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] First task",
      "  - fix: failed",
      "- [ ] Second task",
      "",
    ].join("\r\n"));
  });

  it("preserves multi-line reasons as multiple indented fix sub-items", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] First task\n- [ ] Second task\n",
    });
    const task = createTask({ text: "First task", line: 1 });

    writeFixAnnotationToFile(task, "failed line one\nfailed line two", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] First task",
      "  - fix: failed line one",
      "  - fix: failed line two",
      "- [ ] Second task",
      "",
    ].join("\n"));
  });

  it("indents fix annotation for top-level tasks", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] Top task\n- [ ] Next task\n",
    });
    const task = createTask({ text: "Top task", line: 1, depth: 0 });

    writeFixAnnotationToFile(task, "failed", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] Top task",
      "  - fix: failed",
      "- [ ] Next task",
      "",
    ].join("\n"));
  });

  it("indents fix annotation for 2-space nested tasks", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] Parent\n  - [ ] Child task\n",
    });
    const task = createTask({ text: "Child task", line: 2, depth: 1 });

    writeFixAnnotationToFile(task, "failed", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Parent",
      "  - [x] Child task",
      "    - fix: failed",
      "",
    ].join("\n"));
  });

  it("indents fix annotation for 4-space nested tasks", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [ ] Parent\n  - [ ] Child\n    - [ ] Grandchild task\n",
    });
    const task = createTask({ text: "Grandchild task", line: 3, depth: 2 });

    writeFixAnnotationToFile(task, "failed", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Parent",
      "  - [ ] Child",
      "    - [x] Grandchild task",
      "      - fix: failed",
      "",
    ].join("\n"));
  });

  it("still inserts fix annotation when task is already checked", () => {
    const fileSystem = createFileSystem({
      "todo.md": "- [x] First task\n- [ ] Second task\n",
    });
    const task = createTask({ text: "First task", line: 1, checked: true });

    expect(() => writeFixAnnotationToFile(task, "failed", fileSystem)).not.toThrow();
    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] First task",
      "  - fix: failed",
      "- [ ] Second task",
      "",
    ].join("\n"));
  });

  it("stacks fix annotations by inserting newest entry directly under the task", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] First task",
        "  - fix: previous verification failure",
        "- [ ] Second task",
        "",
      ].join("\n"),
    });
    const task = createTask({ text: "First task", line: 1, checked: true });

    writeFixAnnotationToFile(task, "latest verification failure", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] First task",
      "  - fix: latest verification failure",
      "  - fix: previous verification failure",
      "- [ ] Second task",
      "",
    ].join("\n"));
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

  it("avoids unnecessary file rewrite for already-clean input during reset", () => {
    const filePath = "todo.md";
    const original = [
      "- [ ] Plan next step",
      "  - note: keep this user-authored context",
      "- [ ] Implement follow-up",
      "",
    ].join("\n");
    let source = original;
    const writeText = vi.fn((path: string, content: string) => {
      if (path !== filePath) {
        throw new Error(`File not found: ${path}`);
      }

      source = content;
    });
    const fileSystem: FileSystem = {
      exists: (path) => path === filePath,
      readText: (path) => {
        if (path !== filePath) {
          throw new Error(`File not found: ${path}`);
        }

        return source;
      },
      writeText,
      mkdir: () => undefined,
      readdir: () => [],
      stat: () => null,
      unlink: () => undefined,
      rm: () => undefined,
    };

    resetFileCheckboxes(filePath, fileSystem);

    expect(source).toBe(original);
    expect(writeText).not.toHaveBeenCalled();
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
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("reports dry-run stale runtime cleanup intent when reset would remove annotations", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] A",
        "  - fix: generated annotation",
        "  - skipped: generated annotation",
      ].join("\n"),
    });
    const emit = vi.fn();

    const count = maybeResetFileCheckboxes("todo.md", fileSystem, true, emit, "post-run");

    expect(count).toBe(1);
    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] A",
      "  - fix: generated annotation",
      "  - skipped: generated annotation",
    ].join("\n"));
    expect(emit).toHaveBeenNthCalledWith(1, {
      kind: "info",
      message: "Dry run — would reset checkboxes (post-run) in: todo.md",
    });
    expect(emit).toHaveBeenNthCalledWith(2, {
      kind: "info",
      message: "Dry run — would also remove stale runtime annotations in: todo.md",
    });
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it("keeps dry-run reporting checkbox-centric when no checked tasks exist", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [ ] A",
        "  - fix: generated annotation",
        "  - skipped: generated annotation",
      ].join("\n"),
    });
    const emit = vi.fn();

    const count = maybeResetFileCheckboxes("todo.md", fileSystem, true, emit, "post-run");

    expect(count).toBe(0);
    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] A",
      "  - fix: generated annotation",
      "  - skipped: generated annotation",
    ].join("\n"));
    expect(emit).toHaveBeenNthCalledWith(1, {
      kind: "info",
      message: "Dry run — would reset checkboxes (post-run) in: todo.md",
    });
    expect(emit).toHaveBeenCalledTimes(1);
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

  it("removes fix and skipped runtime annotations during checkbox reset", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - note: keep this",
        "  - fix: retry with smaller batch",
        "  - skipped: already satisfied",
        "- [x] Next task",
        "  - skipped: no output",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Parent",
      "  - note: keep this",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("removes get-result metadata annotations during checkbox reset", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] get: Find current module names",
        "  - get-result: CliResourceModule",
        "  - get-result: CliArgsModule",
        "- [x] Next task",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] get: Find current module names",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("removes question answer metadata annotations during checkbox reset", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] question: Which module should we target first?",
        "  - option: CliResourceModule",
        "  - option: CliArgsModule",
        "  - answer: CliResourceModule",
        "- [x] Next task",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] question: Which module should we target first?",
      "  - option: CliResourceModule",
      "  - option: CliArgsModule",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("removes for-item and for-current metadata annotations during checkbox reset", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] for: Alpha, Beta",
        "  - for-item: Alpha",
        "  - for-item: Beta",
        "  - for-current: Alpha",
        "  - [x] Do once",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] for: Alpha, Beta",
      "  - [ ] Do once",
    ].join("\n"));
  });

  it("removes duplicate get-result and for-item metadata entries during reset", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] get: Resolve current names",
        "  - get-result: Alpha",
        "  - get-result: Alpha",
        "  - get-result: Beta",
        "- [x] for: Alpha, Beta",
        "  - for-item: One",
        "  - for-item: One",
        "  - for-item: Two",
        "  - for-current: One",
        "  - [x] Do once",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] get: Resolve current names",
      "- [ ] for: Alpha, Beta",
      "  - [ ] Do once",
    ].join("\n"));
  });

  it("removes empty get-result and for-item metadata values during checkbox reset", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] get: Resolve current names",
        "  - get-result:",
        "- [x] for: Alpha, Beta",
        "  - for-item:",
        "  - for-current:",
        "  - [x] Do once",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] get: Resolve current names",
      "- [ ] for: Alpha, Beta",
      "  - [ ] Do once",
    ].join("\n"));
  });

  it("keeps get-result/for-item metadata as non-executable sub-items during sibling skipping", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] end: no output",
        "- [ ] Parent with metadata",
        "  - get-result: Alpha",
        "  - for-item: Beta",
        "  - [ ] Child action",
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
      skippedDescendantCount: 1,
      skippedTaskTexts: ["Parent with metadata"],
    });
    expect(fileSystem.readText("todo.md")).toBe([
      "- [x] end: no output",
      "- [x] Parent with metadata",
      "  - skipped: no output",
      "  - get-result: Alpha",
      "  - for-item: Beta",
      "  - [x] Child action",
      "    - skipped: no output",
    ].join("\n"));
  });

  it("removes mixed trace statistics, fix, and skipped annotations under one parent", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - note: keep this user note",
        "  - total time: 5s",
        "    - execution: 2s",
        "  - fix: retry with smaller batch",
        "    - verify: 1.5s",
        "  - skipped: no output",
        "  - [ ] Keep this actionable child",
        "    - note: keep nested child note",
        "- [x] Next task",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Parent",
      "  - note: keep this user note",
      "  - [ ] Keep this actionable child",
      "    - note: keep nested child note",
      "- [ ] Next task",
    ].join("\n"));
  });

  it("retains user-authored child notes and TODOs while removing mixed runtime annotations", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - note: keep parent note",
        "  - total time: 5s",
        "    - execution: 2s",
        "  - [ ] Keep this user child TODO",
        "    - note: keep nested user note",
        "    - detail: skipped: phrase in note should remain",
        "  - fix: generated repair hint",
        "    - repair: 1s",
        "  - skipped: no output",
        "  - observation: verify attempts: phrase in note should remain",
        "- [x] Sibling",
        "  - note: keep sibling note",
        "  - verify attempts: 1",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Parent",
      "  - note: keep parent note",
      "  - [ ] Keep this user child TODO",
      "    - note: keep nested user note",
      "    - detail: skipped: phrase in note should remain",
      "  - observation: verify attempts: phrase in note should remain",
      "- [ ] Sibling",
      "  - note: keep sibling note",
    ].join("\n"));
  });

  it("treats checkbox-prefixed stale labels as stale during reset", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - [x] fix: generated annotation",
        "  + [ ] skipped: generated annotation",
        "  * [x] verify attempts: 2",
        "    - execution: 1s",
        "- [ ] Keep",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Parent",
      "- [ ] Keep",
    ].join("\n"));
  });

  it("removes nested stale descendants under stale parents while preserving unrelated siblings", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - note: keep this note",
        "  - fix: generated annotation",
        "    - [ ] Generated stale child task",
        "      - skipped: generated child annotation",
        "    - note: nested stale note",
        "  - [ ] Keep this actionable child",
        "    - note: keep nested user note",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Parent",
      "  - note: keep this note",
      "  - [ ] Keep this actionable child",
      "    - note: keep nested user note",
    ].join("\n"));
  });

  it("cleans nested task trees across multiple branches while preserving actionable structure", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Root A",
        "  - [x] Branch A1",
        "    - fix: generated for branch",
        "      - verify: 1s",
        "    - [ ] Keep branch child task",
        "      - note: keep branch child note",
        "  - total time: 4s",
        "    - execution: 3s",
        "- [x] Root B",
        "  - note: keep root note",
        "  - [x] Branch B1",
        "    - skipped: generated annotation",
        "    - [ ] Keep nested actionable child",
        "      - detail: keep child detail",
        "  - skipped: generated root annotation",
        "- [ ] Already open root",
        "  - [x] Checked child remains but should reset",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "- [ ] Root A",
      "  - [ ] Branch A1",
      "    - [ ] Keep branch child task",
      "      - note: keep branch child note",
      "- [ ] Root B",
      "  - note: keep root note",
      "  - [ ] Branch B1",
      "    - [ ] Keep nested actionable child",
      "      - detail: keep child detail",
      "- [ ] Already open root",
      "  - [ ] Checked child remains but should reset",
    ].join("\n"));
  });

  it("is idempotent across repeated reset passes", () => {
    const fileSystem = createFileSystem({
      "todo.md": [
        "- [x] Parent",
        "  - fix: generated annotation",
        "    - repair: 1s",
        "  - [ ] Keep child",
        "    - note: keep this",
        "- [x] Sibling",
        "  - skipped: generated annotation",
      ].join("\n"),
    });

    resetFileCheckboxes("todo.md", fileSystem);
    const afterFirstReset = fileSystem.readText("todo.md");

    resetFileCheckboxes("todo.md", fileSystem);
    const afterSecondReset = fileSystem.readText("todo.md");

    expect(afterFirstReset).toBe([
      "- [ ] Parent",
      "  - [ ] Keep child",
      "    - note: keep this",
      "- [ ] Sibling",
    ].join("\n"));
    expect(afterSecondReset).toBe(afterFirstReset);
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

  it("relocates checkbox when file content shifted after agent modification", () => {
    // Simulate agent inserting content above the checkbox during execution.
    const fileSystem = createFileSystem({
      "todo.md": [
        "## Research",
        "",
        "Agent-generated content line 1",
        "Agent-generated content line 2",
        "",
        "- [ ] Do thing",
        "- [ ] Another task",
      ].join("\n"),
    });
    // Task was parsed when checkbox was on line 1, but file was modified since.
    const task = createTask({ text: "Do thing", line: 1, index: 0, file: "todo.md" });

    checkTaskUsingFileSystem(task, fileSystem);

    expect(fileSystem.readText("todo.md")).toBe([
      "## Research",
      "",
      "Agent-generated content line 1",
      "Agent-generated content line 2",
      "",
      "- [x] Do thing",
      "- [ ] Another task",
    ].join("\n"));
  });
});
