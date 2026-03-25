import { describe, expect, it } from "vitest";
import { filterRunnable, hasUncheckedDescendants } from "../../src/domain/task-selection.js";
import type { Task } from "../../src/domain/parser.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    text: "Task",
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: 0,
    file: "tasks.md",
    isInlineCli: false,
    depth: 0,
    ...overrides,
  };
}

describe("hasUncheckedDescendants", () => {
  it("returns false when the task is not part of the provided list", () => {
    const otherTask = makeTask({ text: "Other" });
    const tasks = [makeTask({ text: "Existing" })];

    expect(hasUncheckedDescendants(otherTask, tasks)).toBe(false);
  });

  it("returns false when descendants are checked before the next sibling", () => {
    const parent = makeTask({ text: "Parent", depth: 0, index: 0 });
    const child = makeTask({ text: "Child", depth: 1, index: 1, checked: true });
    const sibling = makeTask({ text: "Sibling", depth: 0, index: 2 });

    expect(hasUncheckedDescendants(parent, [parent, child, sibling])).toBe(false);
  });

  it("returns true when an unchecked deeper descendant exists", () => {
    const parent = makeTask({ text: "Parent", depth: 0, index: 0 });
    const child = makeTask({ text: "Child", depth: 1, index: 1, checked: false });

    expect(hasUncheckedDescendants(parent, [parent, child])).toBe(true);
  });
});

describe("filterRunnable", () => {
  it("keeps only unchecked tasks with no unchecked descendants", () => {
    const parent = makeTask({ text: "Parent", depth: 0, index: 0 });
    const child = makeTask({ text: "Child", depth: 1, index: 1, checked: false });
    const done = makeTask({ text: "Done", depth: 0, index: 2, checked: true });
    const standalone = makeTask({ text: "Standalone", depth: 0, index: 3, checked: false });

    expect(filterRunnable([parent, child, done, standalone])).toEqual([child, standalone]);
  });
});