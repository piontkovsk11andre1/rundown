import { describe, expect, it, vi } from "vitest";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

import { runOnCompleteHook } from "../../src/infrastructure/hooks.js";

describe("runOnCompleteHook mocked failures", () => {
  it("uses the error message when execFile fails without a numeric exit code", async () => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error, stdout?: string, stderr?: string) => void,
      ) => {
        callback(new Error("spawn failed"), "", undefined);
      },
    );

    const result = await runOnCompleteHook({
      command: "missing-command",
      taskInfo: {
        task: "Deploy staging",
        file: "tasks.md",
        line: 5,
        index: 2,
      },
      source: "tasks.md",
      cwd: process.cwd(),
    });

    expect(result).toEqual({
      success: false,
      exitCode: null,
      stdout: "",
      stderr: "spawn failed",
    });
  });
});