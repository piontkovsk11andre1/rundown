import { describe, it, expect } from "vitest";
import { parseTasks } from "../../src/domain/parser.js";

describe("parseTasks", () => {
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
  });
});
