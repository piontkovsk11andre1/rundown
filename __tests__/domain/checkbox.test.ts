import { describe, it, expect } from "vitest";
import {
  markChecked,
  markTasksChecked,
  markUnchecked,
  resetAllCheckboxes,
} from "../../src/domain/checkbox.js";

describe("markChecked", () => {
  it("should replace [ ] with [x] on the target line", () => {
    const source = "# Title\n\n- [ ] First task\n- [ ] Second task\n";
    const task = { line: 3, file: "test.md" } as any;

    const result = markChecked(source, task);

    expect(result).toBe("# Title\n\n- [x] First task\n- [ ] Second task\n");
  });

  it("should handle * [ ] markers", () => {
    const source = "* [ ] Star task\n";
    const task = { line: 1, file: "test.md" } as any;

    const result = markChecked(source, task);

    expect(result).toBe("* [x] Star task\n");
  });

  it("should handle + [ ] markers", () => {
    const source = "Text\n+ [ ] Plus task\n";
    const task = { line: 2, file: "test.md" } as any;

    const result = markChecked(source, task);

    expect(result).toBe("Text\n+ [x] Plus task\n");
  });

  it("should throw if line is out of range", () => {
    const source = "- [ ] Only task\n";
    const task = { line: 99, file: "test.md" } as any;

    expect(() => markChecked(source, task)).toThrow("out of range");
  });

  it("should throw if no unchecked checkbox on line", () => {
    const source = "- [x] Already done\n";
    const task = { line: 1, file: "test.md" } as any;

    expect(() => markChecked(source, task)).toThrow("Could not find unchecked checkbox");
  });

  it("should only replace the first [ ] on a line", () => {
    const source = "- [ ] Task with [ ] extra brackets\n";
    const task = { line: 1, file: "test.md" } as any;

    const result = markChecked(source, task);

    expect(result).toBe("- [x] Task with [ ] extra brackets\n");
  });

  it("should preserve indentation for nested tasks", () => {
    const source = "- [ ] Parent\n  - [ ] Child\n";
    const task = { line: 2, file: "test.md" } as any;

    const result = markChecked(source, task);

    expect(result).toBe("- [ ] Parent\n  - [x] Child\n");
  });

  it("should preserve CRLF line endings", () => {
    const source = "# Title\r\n\r\n- [ ] First task\r\n- [ ] Second task\r\n";
    const task = { line: 3, file: "test.md" } as any;

    const result = markChecked(source, task);

    expect(result).toBe("# Title\r\n\r\n- [x] First task\r\n- [ ] Second task\r\n");
  });
});

describe("markUnchecked", () => {
  it("should replace [x] with [ ] on the target line", () => {
    const source = "# Title\n\n- [x] First task\n- [x] Second task\n";
    const task = { line: 3, file: "test.md" } as any;

    const result = markUnchecked(source, task);

    expect(result).toBe("# Title\n\n- [ ] First task\n- [x] Second task\n");
  });

  it("should throw if line is out of range", () => {
    const source = "- [x] Only task\n";
    const task = { line: 99, file: "test.md" } as any;

    expect(() => markUnchecked(source, task)).toThrow("out of range");
  });

  it("should throw if no checked checkbox on line", () => {
    const source = "- [ ] Not done\n";
    const task = { line: 1, file: "test.md" } as any;

    expect(() => markUnchecked(source, task)).toThrow("Could not find checked checkbox");
  });

  it("should only replace the first [x] on a line", () => {
    const source = "- [x] Task with [x] extra brackets\n";
    const task = { line: 1, file: "test.md" } as any;

    const result = markUnchecked(source, task);

    expect(result).toBe("- [ ] Task with [x] extra brackets\n");
  });

  it("should preserve indentation for nested tasks", () => {
    const source = "- [x] Parent\n  - [x] Child\n";
    const task = { line: 2, file: "test.md" } as any;

    const result = markUnchecked(source, task);

    expect(result).toBe("- [x] Parent\n  - [ ] Child\n");
  });

  it("should preserve CRLF line endings", () => {
    const source = "# Title\r\n\r\n- [x] First task\r\n- [x] Second task\r\n";
    const task = { line: 3, file: "test.md" } as any;

    const result = markUnchecked(source, task);

    expect(result).toBe("# Title\r\n\r\n- [ ] First task\r\n- [x] Second task\r\n");
  });
});

describe("markTasksChecked", () => {
  it("marks multiple tasks in one pass", () => {
    const source = "- [ ] One\n- [ ] Two\n- [ ] Three\n";
    const tasks = [
      { line: 1, file: "test.md" },
      { line: 3, file: "test.md" },
    ] as any;

    const result = markTasksChecked(source, tasks);

    expect(result).toBe("- [x] One\n- [ ] Two\n- [x] Three\n");
  });

  it("deduplicates duplicate line entries", () => {
    const source = "- [ ] One\n- [ ] Two\n";
    const tasks = [
      { line: 2, file: "test.md" },
      { line: 2, file: "test.md" },
    ] as any;

    const result = markTasksChecked(source, tasks);

    expect(result).toBe("- [ ] One\n- [x] Two\n");
  });

  it("preserves CRLF line endings", () => {
    const source = "- [ ] One\r\n- [ ] Two\r\n";
    const tasks = [{ line: 2, file: "test.md" }] as any;

    const result = markTasksChecked(source, tasks);

    expect(result).toBe("- [ ] One\r\n- [x] Two\r\n");
  });

  it("throws when a target line is out of range", () => {
    const source = "- [ ] Only\n";
    const tasks = [{ line: 99, file: "test.md" }] as any;

    expect(() => markTasksChecked(source, tasks)).toThrow("out of range");
  });

  it("throws when a target line has no unchecked checkbox", () => {
    const source = "- [x] Done\n";
    const tasks = [{ line: 1, file: "test.md" }] as any;

    expect(() => markTasksChecked(source, tasks)).toThrow("Could not find unchecked checkbox");
  });
});

describe("resetAllCheckboxes", () => {
  it("should return unchanged source for an empty file", () => {
    const source = "";

    const result = resetAllCheckboxes(source, "test.md");

    expect(result).toBe("");
  });

  it("should return unchanged source when all tasks are already unchecked", () => {
    const source = "- [ ] One\n- [ ] Two\n";

    const result = resetAllCheckboxes(source, "test.md");

    expect(result).toBe(source);
  });

  it("should uncheck all checked tasks", () => {
    const source = "- [x] Done one\n- [ ] Todo two\n- [x] Done three\n";

    const result = resetAllCheckboxes(source, "test.md");

    expect(result).toBe("- [ ] Done one\n- [ ] Todo two\n- [ ] Done three\n");
  });

  it("should uncheck all tasks when every task is checked", () => {
    const source = "- [x] One\n- [x] Two\n- [x] Three\n";

    const result = resetAllCheckboxes(source, "test.md");

    expect(result).toBe("- [ ] One\n- [ ] Two\n- [ ] Three\n");
  });

  it("should preserve nested structure while unchecking", () => {
    const source = "- [x] Parent\n  - [x] Child\n  - [ ] Child two\n";

    const result = resetAllCheckboxes(source, "test.md");

    expect(result).toBe("- [ ] Parent\n  - [ ] Child\n  - [ ] Child two\n");
  });

  it("should preserve non-task [x] markers inside fenced code blocks", () => {
    const source =
      "- [x] Real task\n\n```md\n- [x] Not a real task\nconst flag = '[x]';\n```\n\n- [ ] Another real task\n";

    const result = resetAllCheckboxes(source, "test.md");

    expect(result).toBe(
      "- [ ] Real task\n\n```md\n- [x] Not a real task\nconst flag = '[x]';\n```\n\n- [ ] Another real task\n",
    );
  });

  it("should preserve CRLF line endings", () => {
    const source = "# Title\r\n\r\n- [x] First\r\n- [ ] Second\r\n- [x] Third\r\n";

    const result = resetAllCheckboxes(source, "test.md");

    expect(result).toBe("# Title\r\n\r\n- [ ] First\r\n- [ ] Second\r\n- [ ] Third\r\n");
  });
});
