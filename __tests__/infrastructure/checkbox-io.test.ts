import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { checkTask } from "../../src/infrastructure/checkbox-io.js";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

describe("checkTask", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should read source, mark task as checked, and write back", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("- [ ] Task\n");
    const task = { file: "todo.md", line: 1 } as any;

    checkTask(task);

    expect(fs.readFileSync).toHaveBeenCalledWith("todo.md", "utf-8");
    expect(fs.writeFileSync).toHaveBeenCalledWith("todo.md", "- [x] Task\n", "utf-8");
  });

  it("should throw when no unchecked checkbox is found", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("- [x] Done\n");
    const task = { file: "todo.md", line: 1 } as any;

    expect(() => checkTask(task)).toThrow("Could not find unchecked checkbox");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});
