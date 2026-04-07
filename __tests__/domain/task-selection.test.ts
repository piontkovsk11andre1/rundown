import { describe, expect, it } from "vitest";
import {
  filterRunnable,
  findRemainingSiblings,
  findUncheckedDescendants,
  hasUncheckedDescendants,
} from "../../src/domain/task-selection.js";
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
    children: [],
    subItems: [],
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

  it("can traverse nested task.children when enabled", () => {
    const grandchild = makeTask({ text: "Grandchild", depth: 2, index: 2, checked: false });
    const child = makeTask({ text: "Child", depth: 1, index: 1, checked: true, children: [grandchild] });
    const parent = makeTask({ text: "Parent", depth: 0, index: 0, children: [child] });

    expect(hasUncheckedDescendants(parent, [parent, child, grandchild], { useChildren: true })).toBe(true);
  });

  it("uses task.children traversal even when the flat list is incomplete", () => {
    const child = makeTask({ text: "Child", depth: 1, index: 1, checked: false, children: [] });
    const parent = makeTask({ text: "Parent", depth: 0, index: 0, children: [child] });

    expect(hasUncheckedDescendants(parent, [parent], { useChildren: true })).toBe(true);
  });

  it("prefers task.children over linear scan when children are present", () => {
    const child = makeTask({ text: "Child", depth: 1, index: 1, checked: true, children: [] });
    const parent = makeTask({ text: "Parent", depth: 0, index: 0, children: [child] });
    const staleUnchecked = makeTask({ text: "Stale unchecked", depth: 1, index: 99, checked: false });

    expect(hasUncheckedDescendants(parent, [parent, staleUnchecked], { useChildren: true })).toBe(false);
  });

  it("falls back to linear scan when useChildren is enabled but children are absent", () => {
    const parent = makeTask({ text: "Parent", depth: 0, index: 0, children: [] });
    const child = makeTask({ text: "Child", depth: 1, index: 1, checked: false, children: [] });

    expect(hasUncheckedDescendants(parent, [parent, child], { useChildren: true })).toBe(true);
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

  it("ignores non-checkable subItems when selecting runnable tasks", () => {
    const parent = makeTask({
      text: "Parent",
      depth: 0,
      index: 0,
      subItems: [
        { text: "Note", line: 2, depth: 1 },
      ],
    });

    expect(filterRunnable([parent])).toEqual([parent]);
  });

  it("handles populated children and subItems fields without changing runnable order", () => {
    const child = makeTask({
      text: "Child",
      depth: 1,
      index: 1,
      checked: false,
      subItems: [{ text: "Detail", line: 3, depth: 2 }],
    });
    const parent = makeTask({
      text: "Parent",
      depth: 0,
      index: 0,
      checked: false,
      children: [child],
      subItems: [{ text: "Parent detail", line: 2, depth: 1 }],
    });

    expect(filterRunnable([parent, child])).toEqual([child]);
  });
});

describe("findRemainingSiblings", () => {
  it("returns unchecked tasks from the same sibling group", () => {
    const parent = makeTask({ text: "Parent", depth: 0, index: 0, line: 1, checked: false });
    const first = makeTask({ text: "First", depth: 1, index: 1, line: 2, checked: false });
    const nestedChild = makeTask({ text: "Nested", depth: 2, index: 2, line: 3, checked: false });
    const second = makeTask({ text: "Second", depth: 1, index: 3, line: 4, checked: false });
    const thirdChecked = makeTask({ text: "Third", depth: 1, index: 4, line: 5, checked: true });
    const fourth = makeTask({ text: "Fourth", depth: 1, index: 5, line: 6, checked: false });

    expect(findRemainingSiblings(first, [parent, first, nestedChild, second, thirdChecked, fourth])).toEqual([
      second,
      fourth,
    ]);
  });

  it("returns no remaining siblings when there are none after the task", () => {
    const first = makeTask({ text: "First", depth: 0, index: 0, line: 1, checked: false });
    const second = makeTask({ text: "Second", depth: 0, index: 1, line: 2, checked: false });

    expect(findRemainingSiblings(second, [first, second])).toEqual([]);
  });

  it("returns no siblings when the end task is last in its sibling group", () => {
    const root = makeTask({ text: "Root", depth: 0, index: 0, line: 1, checked: false });
    const first = makeTask({ text: "First", depth: 1, index: 1, line: 2, checked: false });
    const endTask = makeTask({ text: "end: done", depth: 1, index: 2, line: 3, checked: false });
    const nextRoot = makeTask({ text: "Next root", depth: 0, index: 3, line: 4, checked: false });

    expect(findRemainingSiblings(endTask, [root, first, endTask, nextRoot])).toEqual([]);
  });

  it("returns no siblings when all later siblings are already checked", () => {
    const first = makeTask({ text: "First", depth: 0, index: 0, line: 1, checked: false });
    const secondChecked = makeTask({ text: "Second", depth: 0, index: 1, line: 2, checked: true });
    const thirdChecked = makeTask({ text: "Third", depth: 0, index: 2, line: 3, checked: true });

    expect(findRemainingSiblings(first, [first, secondChecked, thirdChecked])).toEqual([]);
  });
});

describe("findUncheckedDescendants", () => {
  it("returns unchecked descendants inside the parent subtree", () => {
    const parent = makeTask({ text: "Parent", depth: 0, index: 0, line: 1, checked: false });
    const child = makeTask({ text: "Child", depth: 1, index: 1, line: 2, checked: false });
    const checkedChild = makeTask({ text: "Checked", depth: 1, index: 2, line: 3, checked: true });
    const grandchild = makeTask({ text: "Grandchild", depth: 2, index: 3, line: 4, checked: false });
    const sibling = makeTask({ text: "Sibling", depth: 0, index: 4, line: 5, checked: false });

    expect(findUncheckedDescendants(parent, [parent, child, checkedChild, grandchild, sibling])).toEqual([
      child,
      grandchild,
    ]);
  });
});
