import { describe, expect, it, vi } from "vitest";
import { createCachedCommandExecutor } from "../../src/infrastructure/cached-command-executor.js";

describe("createCachedCommandExecutor", () => {
  it("delegates on cache miss and reuses result on cache hit", async () => {
    const delegate = {
      execute: vi.fn(async () => ({
        exitCode: 0,
        stdout: "ok",
        stderr: "warn",
      })),
    };
    const executor = createCachedCommandExecutor(delegate);

    const first = await executor.execute("npm test", "/repo", { timeoutMs: 1000 });
    const second = await executor.execute("npm test", "/repo", { timeoutMs: 1 });

    expect(first).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "warn",
    });
    expect(second).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "warn",
    });
    expect(delegate.execute).toHaveBeenCalledTimes(1);
    expect(delegate.execute).toHaveBeenCalledWith("npm test", "/repo", { timeoutMs: 1000 });
  });

  it("keys cache by working directory", async () => {
    const delegate = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "repo-a", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "repo-b", stderr: "" }),
    };
    const executor = createCachedCommandExecutor(delegate);

    const first = await executor.execute("git status", "/repo/a");
    const second = await executor.execute("git status", "/repo/b");

    expect(first.stdout).toBe("repo-a");
    expect(second.stdout).toBe("repo-b");
    expect(delegate.execute).toHaveBeenCalledTimes(2);
  });

  it("keys cache by command string", async () => {
    const delegate = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({ exitCode: 0, stdout: "status", stderr: "" })
        .mockResolvedValueOnce({ exitCode: 0, stdout: "log", stderr: "" }),
    };
    const executor = createCachedCommandExecutor(delegate);

    const first = await executor.execute("git status", "/repo");
    const second = await executor.execute("git log", "/repo");

    expect(first.stdout).toBe("status");
    expect(second.stdout).toBe("log");
    expect(delegate.execute).toHaveBeenCalledTimes(2);
  });

  it("preserves CommandResult fields when returning cached values", async () => {
    const expected = {
      exitCode: null,
      stdout: "line one\nline two",
      stderr: "warning",
    };
    const delegate = {
      execute: vi.fn(async () => expected),
    };
    const executor = createCachedCommandExecutor(delegate);

    const first = await executor.execute("custom", "/repo");
    first.stdout = "mutated";
    first.stderr = "mutated";

    const second = await executor.execute("custom", "/repo");

    expect(second).toEqual(expected);
    expect(delegate.execute).toHaveBeenCalledTimes(1);
  });
});
