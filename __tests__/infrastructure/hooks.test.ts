import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runOnCompleteHook } from "../../src/infrastructure/hooks.js";

const tempFiles: string[] = [];

afterEach(() => {
  while (tempFiles.length > 0) {
    const f = tempFiles.pop();
    if (f && fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function writeTempScript(content: string): string {
  const file = path.join(os.tmpdir(), `md-todo-hook-test-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(file, content, "utf-8");
  tempFiles.push(file);
  return file;
}

const baseOptions = {
  taskInfo: {
    task: "Deploy staging",
    file: "/project/tasks.md",
    line: 5,
    index: 2,
  },
  source: "tasks.md",
  cwd: process.cwd(),
};

describe("runOnCompleteHook", () => {
  it("runs a command and returns success on exit code 0", async () => {
    const echoCmd = process.platform === "win32"
      ? "echo hello"
      : "echo hello";

    const result = await runOnCompleteHook({
      ...baseOptions,
      command: echoCmd,
    });

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("passes task metadata as environment variables", async () => {
    const script = writeTempScript(`
const e = process.env;
console.log([e.MD_TODO_TASK, e.MD_TODO_FILE, e.MD_TODO_LINE, e.MD_TODO_INDEX, e.MD_TODO_SOURCE].join("|"));
`);

    const result = await runOnCompleteHook({
      ...baseOptions,
      command: `node ${script.replace(/\\/g, "/")}`,
    });

    expect(result.success).toBe(true);

    const parts = result.stdout.trim().split("|");
    expect(parts[0]).toBe("Deploy staging");
    // File path is resolved to absolute
    expect(parts[1]).toContain("tasks.md");
    expect(parts[2]).toBe("5");
    expect(parts[3]).toBe("2");
    expect(parts[4]).toBe("tasks.md");
  });

  it("returns failure for non-zero exit code", async () => {
    const failCmd = process.platform === "win32"
      ? "exit /b 42"
      : "exit 42";

    const result = await runOnCompleteHook({
      ...baseOptions,
      command: failCmd,
    });

    expect(result.success).toBe(false);
  });

  it("handles commands that write to stderr", async () => {
    const stderrCmd = process.platform === "win32"
      ? "echo warning 1>&2"
      : "echo warning >&2";

    const result = await runOnCompleteHook({
      ...baseOptions,
      command: stderrCmd,
    });

    expect(result.success).toBe(true);
    expect(result.stderr.trim()).toBe("warning");
  });
});
