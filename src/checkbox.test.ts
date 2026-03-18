import { describe, it, expect } from "vitest";
import { markChecked } from "./checkbox.js";

describe("markChecked", () => {
  it("should replace [ ] with [x] on the correct line", () => {
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
