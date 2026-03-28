import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countTodoItems,
  extractHeadingLines,
  extractHeadingSections,
  extractTodoItems,
  hasTodoItems,
  parseTasks,
  type SubItem,
} from "../../src/domain/parser.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("mdast-util-from-markdown");
});

describe("parseTasks", () => {
  it("exports SubItem shape for plain list item metadata", () => {
    const subItem: SubItem = {
      text: "Note",
      line: 3,
      depth: 1,
    };

    expect(subItem).toEqual({
      text: "Note",
      line: 3,
      depth: 1,
    });
  });

  it("should find unchecked tasks with - [ ]", () => {
    const md = `# Hello\n\n- [ ] First task\n- [ ] Second task\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.text).toBe("First task");
    expect(tasks[0]!.checked).toBe(false);
    expect(tasks[0]!.index).toBe(0);
    expect(tasks[1]!.text).toBe("Second task");
    expect(tasks[1]!.index).toBe(1);
  });

  it("should find checked tasks with - [x]", () => {
    const md = `- [x] Done task\n- [ ] Open task\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.checked).toBe(true);
    expect(tasks[1]!.checked).toBe(false);
  });

  it("should support * [ ] and + [ ] markers", () => {
    const md = `* [ ] Star task\n+ [ ] Plus task\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.text).toBe("Star task");
    expect(tasks[1]!.text).toBe("Plus task");
  });

  it("should detect nested tasks", () => {
    const md = `- [ ] Parent task\n  - [ ] Nested task\n    - [ ] Deep nested task\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.text).toBe("Parent task");
    expect(tasks[1]!.text).toBe("Nested task");
    expect(tasks[2]!.text).toBe("Deep nested task");
    expect(tasks[0]!.children).toEqual([tasks[1]]);
    expect(tasks[1]!.children).toEqual([tasks[2]]);
    expect(tasks[2]!.children).toEqual([]);
    expect(tasks.every((task) => Array.isArray(task.subItems))).toBe(true);
  });

  it("populates parent children for nested checkbox items", () => {
    const md = [
      "- [ ] Parent task",
      "  - [ ] Child task one",
      "  - [x] Child task two",
      "- [ ] Another parent",
    ].join("\n");

    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(4);
    expect(tasks[0]!.text).toBe("Parent task");
    expect(tasks[0]!.children).toEqual([tasks[1], tasks[2]]);
    expect(tasks[1]!.text).toBe("Child task one");
    expect(tasks[2]!.text).toBe("Child task two");
    expect(tasks[3]!.text).toBe("Another parent");
    expect(tasks[3]!.children).toEqual([]);
  });

  it("populates parent subItems for plain list sub-items", () => {
    const md = [
      "- [ ] Parent task",
      "  - Plain note one",
      "  - Plain note two",
      "- [ ] Sibling task",
    ].join("\n");

    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.text).toBe("Parent task");
    expect(tasks[0]!.subItems).toEqual([
      { text: "Plain note one", line: 2, depth: 1 },
      { text: "Plain note two", line: 3, depth: 1 },
    ]);
    expect(tasks[1]!.text).toBe("Sibling task");
    expect(tasks[1]!.subItems).toEqual([]);
  });

  it("captures nested non-checkbox list items as subItems", () => {
    const md = [
      "- [ ] Parent task",
      "  - Note one",
      "  - [ ] Nested task",
      "    - Child note",
    ].join("\n");

    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.subItems).toEqual([{ text: "Note one", line: 2, depth: 1 }]);
    expect(tasks[1]!.subItems).toEqual([{ text: "Child note", line: 4, depth: 2 }]);
  });

  it("supports mixed checkbox and plain sub-items under one parent", () => {
    const md = [
      "- [ ] Parent task",
      "  - [ ] Child task one",
      "  - Parent note one",
      "  - [x] Child task two",
      "    - Child two note",
      "  - Parent note two",
    ].join("\n");

    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(3);

    expect(tasks[0]!.text).toBe("Parent task");
    expect(tasks[0]!.children).toEqual([tasks[1], tasks[2]]);
    expect(tasks[0]!.subItems).toEqual([
      { text: "Parent note one", line: 3, depth: 1 },
      { text: "Parent note two", line: 6, depth: 1 },
    ]);

    expect(tasks[1]!.text).toBe("Child task one");
    expect(tasks[1]!.subItems).toEqual([]);

    expect(tasks[2]!.text).toBe("Child task two");
    expect(tasks[2]!.checked).toBe(true);
    expect(tasks[2]!.subItems).toEqual([{ text: "Child two note", line: 5, depth: 2 }]);
  });

  it("should ignore tasks inside fenced code blocks", () => {
    const md = [
      "# Real tasks",
      "",
      "- [ ] Real task",
      "",
      "```markdown",
      "- [ ] Fake task inside code block",
      "```",
      "",
      "- [ ] Another real task",
    ].join("\n");

    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.text).toBe("Real task");
    expect(tasks[1]!.text).toBe("Another real task");
  });

  it("should detect inline CLI tasks", () => {
    const md = `- [ ] cli: npm test\n- [ ] Normal task\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.isInlineCli).toBe(true);
    expect(tasks[0]!.cliCommand).toBe("npm test");
    expect(tasks[1]!.isInlineCli).toBe(false);
    expect(tasks[1]!.cliCommand).toBeUndefined();
  });

  it("should detect inline CLI tasks case-insensitively", () => {
    const md = `- [ ] CLI: git status\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.isInlineCli).toBe(true);
    expect(tasks[0]!.cliCommand).toBe("git status");
  });

  it("should trim whitespace around inline CLI commands", () => {
    const md = `- [ ] cli:    npm test -- --runInBand   \n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.isInlineCli).toBe(true);
    expect(tasks[0]!.cliCommand).toBe("npm test -- --runInBand");
  });

  it("should include inline code text in extracted task text", () => {
    const md = "- [ ] Use `npm test` before release\n";
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.text).toBe("Use npm test before release");
  });

  it("should preserve nested formatting text while skipping nested child task text", () => {
    const md = [
      "- [ ] Parent with **bold** text",
      "  - [ ] Nested child",
    ].join("\n");
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.text).toBe("Parent with bold text");
    expect(tasks[1]!.text).toBe("Nested child");
    expect(tasks[1]!.depth).toBe(1);
  });

  it("should fall back to zero-based position defaults when markdown nodes omit location metadata", async () => {
    vi.doMock("mdast-util-from-markdown", () => ({
      fromMarkdown: () => ({
        type: "root",
        children: [
          {
            type: "list",
            ordered: false,
            spread: false,
            children: [
              {
                type: "listItem",
                checked: false,
                spread: false,
                children: [
                  {
                    type: "paragraph",
                    children: [
                      { type: "text", value: "Task without position" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    }));

    // @ts-expect-error Vitest query suffix forces a fresh module instance.
    const { parseTasks: parseTasksWithoutPositions } = await import("../../src/domain/parser.js?missing-positions");
    const tasks = parseTasksWithoutPositions("- [ ] Task without position", "test.md");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.line).toBe(0);
    expect(tasks[0]!.column).toBe(0);
    expect(tasks[0]!.offsetStart).toBe(0);
    expect(tasks[0]!.offsetEnd).toBe(0);
  });

  it("should track line numbers correctly", () => {
    const md = `# Title\n\nSome text.\n\n- [ ] First\n- [x] Second\n- [ ] Third\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.line).toBe(5);
    expect(tasks[1]!.line).toBe(6);
    expect(tasks[2]!.line).toBe(7);
  });

  it("should set file path on all tasks", () => {
    const md = `- [ ] Task\n`;
    const tasks = parseTasks(md, "/path/to/tasks.md");

    expect(tasks[0]!.file).toBe("/path/to/tasks.md");
  });

  it("should return empty array for markdown with no tasks", () => {
    const md = `# Just a heading\n\nSome regular text.\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(0);
  });

  it("should return empty array for empty input", () => {
    const tasks = parseTasks("", "test.md");
    expect(tasks).toHaveLength(0);
  });

  it("should handle mixed checked and unchecked with various markers", () => {
    const md = `- [x] Done\n* [ ] Open\n+ [x] Also done\n- [ ] Another open\n`;
    const tasks = parseTasks(md, "test.md");

    expect(tasks).toHaveLength(4);
    expect(tasks[0]!.checked).toBe(true);
    expect(tasks[1]!.checked).toBe(false);
    expect(tasks[2]!.checked).toBe(true);
    expect(tasks[3]!.checked).toBe(false);
    expect(tasks.every((task) => Array.isArray(task.children))).toBe(true);
  });
});

describe("document-level TODO helpers", () => {
  it("extractTodoItems returns all TODOs across the document", () => {
    const md = [
      "# Plan",
      "",
      "- [ ] Top-level task",
      "",
      "## Details",
      "- [x] Completed task",
      "  - [ ] Nested task",
    ].join("\n");

    const todos = extractTodoItems(md, "plan.md");

    expect(todos).toHaveLength(3);
    expect(todos[0]!.text).toBe("Top-level task");
    expect(todos[1]!.text).toBe("Completed task");
    expect(todos[2]!.text).toBe("Nested task");
    expect(todos.every((todo) => todo.file === "plan.md")).toBe(true);
  });

  it("extractTodoItems handles markdown edge cases like CRLF and mixed markers", () => {
    const md = [
      "# Plan",
      "",
      "* [ ] First",
      "+ [x] Second",
      "  - [ ] Nested third",
    ].join("\r\n");

    const todos = extractTodoItems(md);

    expect(todos).toHaveLength(3);
    expect(todos.map((todo) => todo.text)).toEqual(["First", "Second", "Nested third"]);
    expect(todos.map((todo) => todo.checked)).toEqual([false, true, false]);
  });

  it("hasTodoItems detects whether TODOs exist", () => {
    expect(hasTodoItems("# Doc\n\n- [ ] One task\n")).toBe(true);
    expect(hasTodoItems("# Doc\n\nNo tasks here.\n")).toBe(false);
  });

  it("countTodoItems returns total TODO count", () => {
    const md = "- [ ] First\n- [x] Second\n- [ ] Third\n";
    expect(countTodoItems(md)).toBe(3);
    expect(countTodoItems("# Empty\n\nNo TODOs\n")).toBe(0);
  });

  it("extractHeadingLines returns ATX headings with normalized text", () => {
    const md = [
      "# Plan",
      "",
      "## Next Steps ###",
      "Text",
      "### Implementation",
      "",
      "Not a heading # because no leading marker",
    ].join("\n");

    const headings = extractHeadingLines(md);

    expect(headings).toEqual([
      {
        lineIndex: 0,
        level: 1,
        text: "Plan",
        normalizedText: "plan",
      },
      {
        lineIndex: 2,
        level: 2,
        text: "Next Steps",
        normalizedText: "next steps",
      },
      {
        lineIndex: 4,
        level: 3,
        text: "Implementation",
        normalizedText: "implementation",
      },
    ]);
  });

  it("extractHeadingLines handles heading syntax edge cases deterministically", () => {
    const md = [
      "   ###   Trimmed heading   ###",
      "    #### Not a heading (too much indent)",
      "##",
      "## Valid",
    ].join("\n");

    const headings = extractHeadingLines(md);

    expect(headings).toEqual([
      {
        lineIndex: 0,
        level: 3,
        text: "Trimmed heading",
        normalizedText: "trimmed heading",
      },
      {
        lineIndex: 3,
        level: 2,
        text: "Valid",
        normalizedText: "valid",
      },
    ]);
  });

  it("extractHeadingSections returns deterministic section boundaries", () => {
    const md = [
      "# Plan",
      "Intro",
      "",
      "## Scope",
      "Scope details",
      "### In Scope",
      "Item",
      "## Next Steps",
      "Action",
      "# Appendix",
      "Tail",
    ].join("\n");

    const sections = extractHeadingSections(md);

    expect(sections).toHaveLength(5);

    expect(sections[0]).toMatchObject({
      startLineIndex: 0,
      endLineIndexExclusive: 9,
      heading: { level: 1, text: "Plan", lineIndex: 0 },
    });

    expect(sections[1]).toMatchObject({
      startLineIndex: 3,
      endLineIndexExclusive: 7,
      heading: { level: 2, text: "Scope", lineIndex: 3 },
    });

    expect(sections[2]).toMatchObject({
      startLineIndex: 5,
      endLineIndexExclusive: 7,
      heading: { level: 3, text: "In Scope", lineIndex: 5 },
    });

    expect(sections[3]).toMatchObject({
      startLineIndex: 7,
      endLineIndexExclusive: 9,
      heading: { level: 2, text: "Next Steps", lineIndex: 7 },
    });

    expect(sections[4]).toMatchObject({
      startLineIndex: 9,
      endLineIndexExclusive: 11,
      heading: { level: 1, text: "Appendix", lineIndex: 9 },
    });
  });

  it("extractHeadingSections returns empty list when no headings exist", () => {
    expect(extractHeadingSections("plain text\n- [ ] todo")).toEqual([]);
  });

  it("extractHeadingSections handles CRLF input and single-section documents", () => {
    const md = ["# Only section", "- [ ] Task", "tail"].join("\r\n");
    const sections = extractHeadingSections(md);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      startLineIndex: 0,
      endLineIndexExclusive: 3,
      heading: { level: 1, text: "Only section", lineIndex: 0 },
    });
  });
});
