import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { applyPlannerOutput } from "../../src/infrastructure/planner-io.js";

vi.mock("node:fs", () => ({
  default: {
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

describe("applyPlannerOutput", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 0 and does not touch filesystem when output has no subtasks", () => {
    const task = { file: "todo.md", line: 1 } as any;

    const count = applyPlannerOutput(task, "No tasks here.");

    expect(count).toBe(0);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("reads, inserts subitems, writes back, and returns inserted count", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("- [ ] Parent\n- [ ] Sibling\n");
    const task = { file: "todo.md", line: 1 } as any;
    const output = ["- [ ] Step one", "- [ ] Step two"].join("\n");

    const count = applyPlannerOutput(task, output);

    expect(count).toBe(2);
    expect(fs.readFileSync).toHaveBeenCalledWith("todo.md", "utf-8");
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "todo.md",
      ["- [ ] Parent", "  - [ ] Step one", "  - [ ] Step two", "- [ ] Sibling", ""].join(
        "\n",
      ),
      "utf-8",
    );
  });

  it("normalizes bullet markers and preserves CRLF when writing", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("- [ ] Parent\r\n");
    const task = { file: "todo.md", line: 1 } as any;
    const output = ["* [ ] Star", "+ [ ] Plus"].join("\n");

    const count = applyPlannerOutput(task, output);

    expect(count).toBe(2);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      "todo.md",
      ["- [ ] Parent", "  - [ ] Star", "  - [ ] Plus", ""].join("\r\n"),
      "utf-8",
    );
  });
});
