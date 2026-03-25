import { describe, expect, it } from "vitest";
import {
  parsePlannerOutput,
  insertSubitems,
  computeChildIndent,
} from "../../src/domain/planner.js";
import type { Task } from "../../src/domain/parser.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    text: "Parent task",
    checked: false,
    index: 0,
    line: 3,
    column: 1,
    offsetStart: 0,
    offsetEnd: 0,
    file: "test.md",
    isInlineCli: false,
    depth: 0,
    ...overrides,
  };
}

describe("parsePlannerOutput", () => {
  it("extracts unchecked task lines from worker output", () => {
    const output = [
      "Here are the subtasks:",
      "",
      "- [ ] First step",
      "- [ ] Second step",
      "- [ ] Third step",
      "",
      "That should cover it.",
    ].join("\n");

    const items = parsePlannerOutput(output);
    expect(items).toEqual([
      "- [ ] First step",
      "- [ ] Second step",
      "- [ ] Third step",
    ]);
  });

  it("handles * and + bullet markers", () => {
    const output = "* [ ] Star item\n+ [ ] Plus item\n";
    const items = parsePlannerOutput(output);
    expect(items).toEqual(["* [ ] Star item", "+ [ ] Plus item"]);
  });

  it("strips leading whitespace from indented items", () => {
    const output = "  - [ ] Indented item\n    - [ ] More indented\n";
    const items = parsePlannerOutput(output);
    expect(items).toEqual(["- [ ] Indented item", "- [ ] More indented"]);
  });

  it("ignores checked items", () => {
    const output = "- [x] Done\n- [ ] Open\n";
    const items = parsePlannerOutput(output);
    expect(items).toEqual(["- [ ] Open"]);
  });

  it("ignores non-task lines", () => {
    const output = "# Heading\n\nSome text\n- regular list\n- [ ] Task\n";
    const items = parsePlannerOutput(output);
    expect(items).toEqual(["- [ ] Task"]);
  });

  it("returns empty array for no tasks", () => {
    expect(parsePlannerOutput("No tasks here.")).toEqual([]);
    expect(parsePlannerOutput("")).toEqual([]);
  });
});

describe("computeChildIndent", () => {
  it("adds two spaces for a top-level parent", () => {
    expect(computeChildIndent("- [ ] Parent")).toBe("  ");
  });

  it("adds two more spaces for an already-indented parent", () => {
    expect(computeChildIndent("  - [ ] Nested parent")).toBe("    ");
  });

  it("handles four-space indented parent", () => {
    expect(computeChildIndent("    - [ ] Deep parent")).toBe("      ");
  });
});

describe("insertSubitems", () => {
  it("inserts subitems below the parent task line", () => {
    const source = [
      "# Plan",
      "",
      "- [ ] Parent task",
      "- [ ] Another task",
    ].join("\n");

    const task = makeTask({ line: 3 });
    const subitems = ["- [ ] Step one", "- [ ] Step two"];

    const result = insertSubitems(source, task, subitems);

    expect(result).toBe([
      "# Plan",
      "",
      "- [ ] Parent task",
      "  - [ ] Step one",
      "  - [ ] Step two",
      "- [ ] Another task",
    ].join("\n"));
  });

  it("indents subitems under an already-nested parent", () => {
    const source = ["- [ ] Top", "  - [ ] Nested parent", "- [ ] Other"].join("\n");

    const task = makeTask({ line: 2, depth: 1 });
    const subitems = ["- [ ] Child A", "- [ ] Child B"];

    const result = insertSubitems(source, task, subitems);

    expect(result).toBe([
      "- [ ] Top",
      "  - [ ] Nested parent",
      "    - [ ] Child A",
      "    - [ ] Child B",
      "- [ ] Other",
    ].join("\n"));
  });

  it("returns source unchanged when no subitems given", () => {
    const source = "- [ ] Task\n";
    const task = makeTask({ line: 1 });
    expect(insertSubitems(source, task, [])).toBe(source);
  });

  it("normalizes various bullet markers to dash", () => {
    const source = "- [ ] Parent";
    const task = makeTask({ line: 1 });
    const subitems = ["* [ ] Star", "+ [ ] Plus"];

    const result = insertSubitems(source, task, subitems);

    expect(result).toBe([
      "- [ ] Parent",
      "  - [ ] Star",
      "  - [ ] Plus",
    ].join("\n"));
  });

  it("inserts at end of file when parent is the last line", () => {
    const source = "# Doc\n\n- [ ] Last task";
    const task = makeTask({ line: 3 });
    const subitems = ["- [ ] Sub"];

    const result = insertSubitems(source, task, subitems);

    expect(result).toBe("# Doc\n\n- [ ] Last task\n  - [ ] Sub");
  });

  it("preserves CRLF line endings when inserting subitems", () => {
    const source = [
      "# Plan",
      "",
      "- [ ] Parent task",
      "- [ ] Another task",
    ].join("\r\n");

    const task = makeTask({ line: 3 });
    const subitems = ["- [ ] Step one", "- [ ] Step two"];

    const result = insertSubitems(source, task, subitems);

    expect(result).toBe([
      "# Plan",
      "",
      "- [ ] Parent task",
      "  - [ ] Step one",
      "  - [ ] Step two",
      "- [ ] Another task",
    ].join("\r\n"));
  });

  it("throws when the task line is outside the source range", () => {
    const source = "- [ ] Parent task\n";
    const task = makeTask({ line: 5 });

    expect(() => insertSubitems(source, task, ["- [ ] Child"])).toThrow("Task line 5 is out of range.");
  });
});
