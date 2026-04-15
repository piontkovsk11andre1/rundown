import { describe, expect, it } from "vitest";
import {
  insertSubitems,
  computeChildIndent,
  validatePlanEdit,
  relocateInsertedTodosToEnd,
} from "../../src/domain/planner.js";
import type { Task } from "../../src/domain/parser.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  const { children, subItems, ...rest } = overrides;
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
    ...rest,
    children: children ?? [],
    subItems: subItems ?? [],
  };
}

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

  it("supports multi-level nesting from depth 0 to depth 2", () => {
    const source = ["- [ ] Parent", "- [ ] Sibling"].join("\n");

    const depth0Task = makeTask({ line: 1, depth: 0, text: "Parent" });
    const withDepth1 = insertSubitems(source, depth0Task, ["- [ ] Child"]);

    const depth1Task = makeTask({ line: 2, depth: 1, text: "Child" });
    const withDepth2 = insertSubitems(withDepth1, depth1Task, ["- [ ] Grandchild"]);

    expect(withDepth1).toBe([
      "- [ ] Parent",
      "  - [ ] Child",
      "- [ ] Sibling",
    ].join("\n"));

    expect(withDepth2).toBe([
      "- [ ] Parent",
      "  - [ ] Child",
      "    - [ ] Grandchild",
      "- [ ] Sibling",
    ].join("\n"));
  });

  it("returns source unchanged when no subitems given", () => {
    const source = "- [ ] Task\n";
    const task = makeTask({ line: 1 });
    expect(insertSubitems(source, task, [])).toBe(source);
  });

  it("dedupes against existing immediate children when enabled", () => {
    const source = [
      "- [ ] Parent",
      "  - [ ] Existing A",
      "  - [ ] Existing B",
      "- [ ] Other",
    ].join("\n");
    const task = makeTask({ line: 1 });

    const result = insertSubitems(source, task, [
      "- [ ] Existing A",
      "- [ ] New Child",
    ], {
      dedupeWithExisting: true,
    });

    expect(result).toBe([
      "- [ ] Parent",
      "  - [ ] New Child",
      "  - [ ] Existing A",
      "  - [ ] Existing B",
      "- [ ] Other",
    ].join("\n"));
  });

  it("dedupes only one matching duplicate occurrence", () => {
    const source = [
      "- [ ] Parent",
      "  - [ ] Existing",
      "- [ ] Other",
    ].join("\n");
    const task = makeTask({ line: 1 });

    const result = insertSubitems(source, task, [
      "- [ ] Existing",
      "- [ ] Existing",
    ], {
      dedupeWithExisting: true,
    });

    expect(result).toBe([
      "- [ ] Parent",
      "  - [ ] Existing",
      "  - [ ] Existing",
      "- [ ] Other",
    ].join("\n"));
  });

  it("does not dedupe against deeper descendants", () => {
    const source = [
      "- [ ] Parent",
      "  - [ ] Child",
      "    - [ ] Nested",
      "- [ ] Other",
    ].join("\n");
    const task = makeTask({ line: 1 });

    const result = insertSubitems(source, task, [
      "- [ ] Nested",
    ], {
      dedupeWithExisting: true,
    });

    expect(result).toBe([
      "- [ ] Parent",
      "  - [ ] Nested",
      "  - [ ] Child",
      "    - [ ] Nested",
      "- [ ] Other",
    ].join("\n"));
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

describe("validatePlanEdit", () => {
  it("accepts inserting unchecked items in the middle", () => {
    const beforeSource = [
      "# Plan",
      "",
      "- [ ] First",
      "- [ ] Third",
      "",
    ].join("\n");
    const afterSource = [
      "# Plan",
      "",
      "- [ ] First",
      "- [ ] Second",
      "- [ ] Third",
      "",
    ].join("\n");

    const result = validatePlanEdit(beforeSource, afterSource);

    expect(result).toEqual({
      valid: true,
      stats: {
        added: 1,
        removed: 0,
        reordered: 0,
      },
    });
  });

  it("accepts reordering unchecked items and reports reorder stats", () => {
    const beforeSource = [
      "- [ ] First",
      "- [ ] Second",
      "- [ ] Third",
      "",
    ].join("\n");
    const afterSource = [
      "- [ ] Third",
      "- [ ] First",
      "- [ ] Second",
      "",
    ].join("\n");

    const result = validatePlanEdit(beforeSource, afterSource);

    expect(result.valid).toBe(true);
    expect(result.stats.added).toBe(0);
    expect(result.stats.removed).toBe(0);
    expect(result.stats.reordered).toBeGreaterThan(0);
  });

  it("accepts removing unchecked items and reports removal stats", () => {
    const beforeSource = [
      "- [ ] Keep",
      "- [ ] Remove me",
      "- [ ] Keep too",
      "",
    ].join("\n");
    const afterSource = [
      "- [ ] Keep",
      "- [ ] Keep too",
      "",
    ].join("\n");

    const result = validatePlanEdit(beforeSource, afterSource);

    expect(result).toEqual({
      valid: true,
      stats: {
        added: 0,
        removed: 1,
        reordered: 0,
      },
    });
  });

  it("rejects transitions from unchecked to checked", () => {
    const beforeSource = [
      "- [ ] Keep open",
      "- [ ] Do not check off",
      "",
    ].join("\n");
    const afterSource = [
      "- [ ] Keep open",
      "- [x] Do not check off",
      "",
    ].join("\n");

    const result = validatePlanEdit(beforeSource, afterSource);

    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toContain("check off TODO items");
  });

  it("rejects removing checked items", () => {
    const beforeSource = [
      "- [x] Already done",
      "- [ ] Still open",
      "",
    ].join("\n");
    const afterSource = [
      "- [ ] Still open",
      "",
    ].join("\n");

    const result = validatePlanEdit(beforeSource, afterSource);

    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toContain("remove checked TODO items");
  });

  it("rejects introducing checked items that did not exist before", () => {
    const beforeSource = ["- [ ] Open", ""].join("\n");
    const afterSource = ["- [ ] Open", "- [x] Historical note", ""].join("\n");

    const result = validatePlanEdit(beforeSource, afterSource);

    expect(result.valid).toBe(false);
    expect(result.rejectionReason).toContain("check off TODO items");
  });
});

describe("relocateInsertedTodosToEnd", () => {
  it("appends new TODOs to an existing trailing TODO block", () => {
    const beforeSource = [
      "# Spec",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "",
    ].join("\n");
    const afterSource = [
      "# Spec",
      "- [ ] New task",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "",
    ].join("\n");

    const result = relocateInsertedTodosToEnd(beforeSource, afterSource);

    expect(result).toBe([
      "# Spec",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "- [ ] New task",
      "",
    ].join("\n"));
  });

  it("moves newly inserted TODOs to a trailing TODO block when prose follows insertion", () => {
    const beforeSource = [
      "# Spec",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "",
    ].join("\n");
    const afterSource = [
      "# Spec",
      "- [ ] New task",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "More explanation after TODOs.",
      "",
    ].join("\n");

    const result = relocateInsertedTodosToEnd(beforeSource, afterSource);

    expect(result).toBe([
      "# Spec",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "More explanation after TODOs.",
      "",
      "- [ ] New task",
      "",
    ].join("\n"));
  });

  it("appends new TODOs to document end when no trailing TODO block exists", () => {
    const beforeSource = [
      "# Spec",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "",
      "More explanation.",
      "",
    ].join("\n");
    const afterSource = [
      "# Spec",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "",
      "More explanation.",
      "",
      "- [ ] New task",
      "",
    ].join("\n");

    const result = relocateInsertedTodosToEnd(beforeSource, afterSource);

    expect(result).toBe([
      "# Spec",
      "",
      "Intro paragraph.",
      "- [ ] Existing task",
      "",
      "More explanation.",
      "",
      "- [ ] New task",
      "",
    ].join("\n"));
  });

  it("does not treat checkbox-looking lines inside fenced blocks as TODOs", () => {
    const beforeSource = [
      "# Loop Example",
      "",
      "```markdown",
      "- [ ] for: All controllers",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "```",
      "",
      "Implementation notes.",
      "- [ ] Real task",
      "",
    ].join("\n");
    const afterSource = [
      "# Loop Example",
      "",
      "```markdown",
      "- [ ] for: All controllers",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "```",
      "",
      "Implementation notes.",
      "- [ ] Real task",
      "",
      "More notes.",
      "- [ ] Added task",
      "",
    ].join("\n");

    const result = relocateInsertedTodosToEnd(beforeSource, afterSource);

    expect(result).toBe([
      "# Loop Example",
      "",
      "```markdown",
      "- [ ] for: All controllers",
      "  - [ ] Do this",
      "  - [ ] Do that",
      "```",
      "",
      "Implementation notes.",
      "- [ ] Real task",
      "",
      "More notes.",
      "",
      "- [ ] Added task",
      "",
    ].join("\n"));
  });

  it("handles duplicate TODO identities by count and moves only newly added occurrences", () => {
    const beforeSource = [
      "# Work",
      "",
      "- [ ] Duplicate",
      "- [ ] Duplicate",
      "",
      "Tail prose.",
      "",
    ].join("\n");
    const afterSource = [
      "# Work",
      "",
      "- [ ] Duplicate",
      "- [ ] Duplicate",
      "- [ ] Duplicate",
      "",
      "Tail prose.",
      "",
    ].join("\n");

    const result = relocateInsertedTodosToEnd(beforeSource, afterSource);

    expect(result).toBe([
      "# Work",
      "",
      "- [ ] Duplicate",
      "- [ ] Duplicate",
      "",
      "Tail prose.",
      "",
      "- [ ] Duplicate",
      "",
    ].join("\n"));
  });

  it("preserves existing checked item placement and moves only newly added TODO lines", () => {
    const beforeSource = [
      "# Work",
      "",
      "- [x] Completed setup",
      "- [ ] Existing follow-up",
      "",
      "Tail prose.",
      "",
    ].join("\n");
    const afterSource = [
      "# Work",
      "- [ ] New prep",
      "",
      "- [x] Completed setup",
      "- [ ] Existing follow-up",
      "",
      "Tail prose.",
      "",
    ].join("\n");

    const result = relocateInsertedTodosToEnd(beforeSource, afterSource);

    expect(result).toBe([
      "# Work",
      "",
      "- [x] Completed setup",
      "- [ ] Existing follow-up",
      "",
      "Tail prose.",
      "",
      "- [ ] New prep",
      "",
    ].join("\n"));
  });

  it("preserves CRLF and trailing newline behavior", () => {
    const beforeSource = [
      "# Spec",
      "",
      "- [ ] Existing",
      "",
      "Narrative.",
      "",
    ].join("\r\n");
    const afterSource = [
      "# Spec",
      "",
      "- [ ] Existing",
      "",
      "Narrative.",
      "- [ ] Added",
      "",
    ].join("\r\n");

    const result = relocateInsertedTodosToEnd(beforeSource, afterSource);

    expect(result).toBe([
      "# Spec",
      "",
      "- [ ] Existing",
      "",
      "Narrative.",
      "",
      "- [ ] Added",
      "",
    ].join("\r\n"));
  });

  it("returns edited content unchanged when no new TODOs were added", () => {
    const beforeSource = [
      "# Examples",
      "",
      "- [ ] Existing",
      "",
    ].join("\n");
    const afterSource = [
      "# Examples",
      "",
      "- [ ] Existing",
      "",
      "Updated narrative.",
      "",
    ].join("\n");

    expect(relocateInsertedTodosToEnd(beforeSource, afterSource)).toBe(afterSource);
  });
});
