import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildBootstrapPrompt } from "../../src/infrastructure/runner.js";

describe("buildBootstrapPrompt", () => {
  it("uses a path relative to cwd", () => {
    const cwd = path.join("workspace", "repo");
    const promptFilePath = path.join(cwd, ".rundown", "runs", "run-123", "01-worker", "prompt.md");

    const result = buildBootstrapPrompt(promptFilePath, cwd);

    expect(result).toBe(
      "Read the task prompt file at .rundown/runs/run-123/01-worker/prompt.md and follow the instructions.",
    );
  });

  it("normalizes path separators to forward slashes", () => {
    const cwd = path.join("workspace", "repo");
    const promptFilePath = path.join(cwd, "nested", "dir", "prompt.md");

    const result = buildBootstrapPrompt(promptFilePath, cwd);

    expect(result).toContain("nested/dir/prompt.md");
    expect(result).not.toContain("\\");
  });
});
