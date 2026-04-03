import { describe, expect, it } from "vitest";
import { hasUncheckedDescendants, filterRunnable } from "../../src/domain/task-selection.js";
import type { Task } from "../../src/domain/parser.js";

function makeTask(overrides: Partial<Task> & { depth: number; checked?: boolean; index?: number }): Task {
  return {
    text: "Task",
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: 0,
    file: "test.md",
    isInlineCli: false,
    children: [],
    subItems: [],
    ...overrides,
  };
}

describe("hasUncheckedDescendants", () => {
  it("returns false for a task with no children", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "Solo" }),
    ];
    expect(hasUncheckedDescendants(tasks[0]!, tasks)).toBe(false);
  });

  it("returns true when direct child is unchecked", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "Parent" }),
      makeTask({ index: 1, depth: 1, text: "Child", checked: false }),
    ];
    expect(hasUncheckedDescendants(tasks[0]!, tasks)).toBe(true);
  });

  it("returns false when all children are checked", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "Parent" }),
      makeTask({ index: 1, depth: 1, text: "Child A", checked: true }),
      makeTask({ index: 2, depth: 1, text: "Child B", checked: true }),
    ];
    expect(hasUncheckedDescendants(tasks[0]!, tasks)).toBe(false);
  });

  it("returns true for deeply nested unchecked descendant", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "Parent" }),
      makeTask({ index: 1, depth: 1, text: "Child", checked: true }),
      makeTask({ index: 2, depth: 2, text: "Grandchild", checked: false }),
    ];
    expect(hasUncheckedDescendants(tasks[0]!, tasks)).toBe(true);
  });

  it("stops at next sibling at same depth", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "First" }),
      makeTask({ index: 1, depth: 1, text: "Child of first", checked: true }),
      makeTask({ index: 2, depth: 0, text: "Second" }),
      makeTask({ index: 3, depth: 1, text: "Child of second", checked: false }),
    ];
    // First's descendants are only the checked child; second's unchecked child is not first's descendant
    expect(hasUncheckedDescendants(tasks[0]!, tasks)).toBe(false);
    expect(hasUncheckedDescendants(tasks[2]!, tasks)).toBe(true);
  });
});

describe("filterRunnable", () => {
  it("filters out checked tasks", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, checked: true, text: "Done" }),
      makeTask({ index: 1, depth: 0, checked: false, text: "Open" }),
    ];
    const runnable = filterRunnable(tasks);
    expect(runnable).toHaveLength(1);
    expect(runnable[0]!.text).toBe("Open");
  });

  it("filters out parents with unchecked children", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "Parent" }),
      makeTask({ index: 1, depth: 1, text: "Child A" }),
      makeTask({ index: 2, depth: 1, text: "Child B" }),
    ];
    const runnable = filterRunnable(tasks);
    expect(runnable.map((t) => t.text)).toEqual(["Child A", "Child B"]);
  });

  it("includes parent when all children are checked", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "Parent" }),
      makeTask({ index: 1, depth: 1, text: "Child A", checked: true }),
      makeTask({ index: 2, depth: 1, text: "Child B", checked: true }),
    ];
    const runnable = filterRunnable(tasks);
    expect(runnable.map((t) => t.text)).toEqual(["Parent"]);
  });

  it("handles deeply nested hierarchy correctly", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "Root" }),
      makeTask({ index: 1, depth: 1, text: "Mid", checked: true }),
      makeTask({ index: 2, depth: 2, text: "Leaf" }),
    ];
    // Root is blocked by unchecked Leaf (deep descendant)
    // Mid is checked, excluded
    // Leaf is the only runnable task
    const runnable = filterRunnable(tasks);
    expect(runnable.map((t) => t.text)).toEqual(["Leaf"]);
  });

  it("handles multiple independent task trees", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, text: "Tree A parent" }),
      makeTask({ index: 1, depth: 1, text: "Tree A child" }),
      makeTask({ index: 2, depth: 0, text: "Tree B solo" }),
    ];
    // Tree A parent is blocked by child, Tree B solo is runnable
    const runnable = filterRunnable(tasks);
    expect(runnable.map((t) => t.text)).toEqual(["Tree A child", "Tree B solo"]);
  });

  it("returns empty for all-checked tasks", () => {
    const tasks = [
      makeTask({ index: 0, depth: 0, checked: true }),
      makeTask({ index: 1, depth: 0, checked: true }),
    ];
    expect(filterRunnable(tasks)).toHaveLength(0);
  });
});
