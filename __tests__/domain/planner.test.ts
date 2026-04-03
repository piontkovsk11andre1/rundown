import { describe, expect, it } from "vitest";
import {
  insertPlannerTodos,
  normalizePlannerTodoAdditions,
  parsePlannerOutput,
  insertSubitems,
  computeChildIndent,
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

describe("normalizePlannerTodoAdditions", () => {
  it("returns only normalized unchecked TODO additions", () => {
    const output = [
      "text",
      "* [ ] First",
      "+ [ ] Second",
      "- [x] Done",
    ].join("\n");

    const additions = normalizePlannerTodoAdditions(output);
    expect(additions).toEqual(["- [ ] First", "- [ ] Second"]);
  });

  it("deduplicates output and filters existing TODO lines", () => {
    const output = [
      "- [ ] Existing",
      "* [ ] Existing",
      "- [ ] New",
      "- [ ] New",
    ].join("\n");

    const additions = normalizePlannerTodoAdditions(output, {
      existingTodoLines: ["- [ ] Existing"],
    });

    expect(additions).toEqual(["- [ ] New"]);
  });

  it("treats whitespace-only text differences as duplicates", () => {
    const output = [
      "- [ ] Align   release   checklist",
      "- [ ] Align release checklist",
    ].join("\n");

    const additions = normalizePlannerTodoAdditions(output);
    expect(additions).toEqual(["- [ ] Align   release   checklist"]);
  });
});

describe("insertPlannerTodos", () => {
  it("appends TODOs to end of document when none exist", () => {
    const source = [
      "# Delivery Plan",
      "",
      "## Scope",
      "Define the release boundaries.",
      "",
      "## Next Steps",
      "Coordinate rollout.",
      "",
      "## Notes",
      "Additional context.",
    ].join("\n");

    const result = insertPlannerTodos(source, "- [ ] Draft rollout plan\n- [ ] Confirm ownership\n", {
      hasExistingTodos: false,
    });

    expect(result.insertedCount).toBe(2);
    expect(result.updatedSource).toBe([
      "# Delivery Plan",
      "",
      "## Scope",
      "Define the release boundaries.",
      "",
      "## Next Steps",
      "Coordinate rollout.",
      "",
      "## Notes",
      "Additional context.",
      "",
      "- [ ] Draft rollout plan",
      "- [ ] Confirm ownership",
      "",
    ].join("\n"));
  });

  it("appends TODOs at EOF when no headings are present", () => {
    const source = "Release intent without sections.";

    const result = insertPlannerTodos(source, "- [ ] Add milestone list\n", {
      hasExistingTodos: false,
    });

    expect(result.insertedCount).toBe(1);
    expect(result.updatedSource).toBe("Release intent without sections.\n\n- [ ] Add milestone list\n");
  });

  it("appends TODOs at EOF when headings exist", () => {
    const source = [
      "# Plan",
      "",
      "## Scope",
      "Define boundaries.",
      "",
      "## Notes",
      "General context.",
    ].join("\n");

    const result = insertPlannerTodos(source, "- [ ] Rotate database credentials\n", {
      hasExistingTodos: false,
    });

    expect(result.insertedCount).toBe(1);
    expect(result.updatedSource).toBe([
      "# Plan",
      "",
      "## Scope",
      "Define boundaries.",
      "",
      "## Notes",
      "General context.",
      "",
      "- [ ] Rotate database credentials",
      "",
    ].join("\n"));
  });

  it("appends TODOs into the existing TODO list when one already exists", () => {
    const source = [
      "# Plan",
      "",
      "## TODO",
      "- [ ] Existing",
      "",
      "## Notes",
      "Keep this untouched.",
    ].join("\n");

    const result = insertPlannerTodos(source, "- [ ] Existing\n- [ ] New\n", {
      hasExistingTodos: true,
    });

    expect(result.insertedCount).toBe(1);
    expect(result.updatedSource).toBe([
      "# Plan",
      "",
      "## TODO",
      "- [ ] Existing",
      "- [ ] New",
      "",
      "## Notes",
      "Keep this untouched.",
      "",
    ].join("\n"));
    expect(result.updatedSource).not.toContain("Keep this untouched.\n\n- [ ] New");
  });

  it("deduplicates planner output and existing TODO entries", () => {
    const source = "# Plan\n\n- [ ] Existing\n";
    const output = "* [ ] Existing\n- [ ] New\n- [ ] New\n";

    const result = insertPlannerTodos(source, output, {
      hasExistingTodos: true,
    });

    expect(result.insertedCount).toBe(1);
    expect(result.updatedSource).toContain("- [ ] New\n");
    expect(result.updatedSource.match(/- \[ \] New/g)).toHaveLength(1);
    expect(result.rejected).toBe(false);
  });

  it("is idempotent when the same planner output is applied repeatedly", () => {
    const source = [
      "# Plan",
      "",
      "## TODO",
      "- [ ] Existing",
      "",
    ].join("\n");
    const output = "- [ ] Existing\n- [ ] Add migration tests\n";

    const firstPass = insertPlannerTodos(source, output, {
      hasExistingTodos: true,
    });

    expect(firstPass.rejected).toBe(false);
    expect(firstPass.insertedCount).toBe(1);
    expect(firstPass.updatedSource.match(/- \[ \] Add migration tests/g)).toHaveLength(1);

    const secondPass = insertPlannerTodos(firstPass.updatedSource, output, {
      hasExistingTodos: true,
    });

    expect(secondPass.rejected).toBe(false);
    expect(secondPass.insertedCount).toBe(0);
    expect(secondPass.updatedSource).toBe(firstPass.updatedSource);
  });

  it("does not duplicate existing TODO when only spacing differs", () => {
    const source = "# Plan\n\n- [ ] Align release checklist\n";
    const output = "- [ ] Align   release   checklist\n- [ ] New\n";

    const result = insertPlannerTodos(source, output, {
      hasExistingTodos: true,
    });

    expect(result.insertedCount).toBe(1);
    expect(result.updatedSource.match(/Align release checklist/g)).toHaveLength(1);
    expect(result.updatedSource).toContain("- [ ] New\n");
    expect(result.rejected).toBe(false);
  });

  it("rejects output that attempts to modify completion state of existing TODO lines", () => {
    const source = "# Plan\n\n- [ ] Existing\n";
    const output = "- [x] Existing\n- [ ] New\n";

    const result = insertPlannerTodos(source, output, {
      hasExistingTodos: true,
    });

    expect(result.rejected).toBe(true);
    expect(result.insertedCount).toBe(0);
    expect(result.updatedSource).toBe(source);
    expect(result.rejectionReason).toContain("completion state");
  });

  it("rejects output that attempts to reorder existing TODO lines", () => {
    const source = [
      "# Plan",
      "",
      "- [ ] First",
      "- [ ] Second",
      "",
    ].join("\n");
    const output = [
      "- [ ] Second",
      "- [ ] First",
      "- [ ] Third",
      "",
    ].join("\n");

    const result = insertPlannerTodos(source, output, {
      hasExistingTodos: true,
    });

    expect(result.rejected).toBe(true);
    expect(result.insertedCount).toBe(0);
    expect(result.updatedSource).toBe(source);
    expect(result.rejectionReason).toContain("reorder");
  });

  it("rejects output that attempts to remove existing TODO lines", () => {
    const source = [
      "# Plan",
      "",
      "- [ ] First",
      "- [ ] Second",
      "",
    ].join("\n");
    const output = [
      "- [ ] First",
      "- [ ] Third",
      "",
    ].join("\n");

    const result = insertPlannerTodos(source, output, {
      hasExistingTodos: true,
    });

    expect(result.rejected).toBe(true);
    expect(result.insertedCount).toBe(0);
    expect(result.updatedSource).toBe(source);
    expect(result.rejectionReason).toContain("remove");
  });

  it("allows additive output that echoes existing TODO lines in document order", () => {
    const source = [
      "# Plan",
      "",
      "- [ ] First",
      "- [ ] Second",
      "",
    ].join("\n");
    const output = [
      "- [ ] First",
      "- [ ] Second",
      "- [ ] Third",
      "",
    ].join("\n");

    const result = insertPlannerTodos(source, output, {
      hasExistingTodos: true,
    });

    expect(result.rejected).toBe(false);
    expect(result.insertedCount).toBe(1);
    expect(result.updatedSource).toContain("- [ ] Third\n");
  });

  it("rejects output that violates strict stdout TODO-list contract", () => {
    const source = "# Plan\n\n- [ ] Existing\n";
    const output = [
      "Here are missing tasks:",
      "- [ ] New",
      "Thanks",
      "",
    ].join("\n");

    const result = insertPlannerTodos(source, output, {
      hasExistingTodos: true,
    });

    expect(result.rejected).toBe(true);
    expect(result.insertedCount).toBe(0);
    expect(result.updatedSource).toBe(source);
    expect(result.rejectionReason).toContain("stdout contract");
  });
});
