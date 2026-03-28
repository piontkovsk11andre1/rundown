import { describe, it, expect } from "vitest";
import { markChecked, markUnchecked } from "../../src/domain/checkbox.js";

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
