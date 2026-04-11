import { describe, expect, it, vi } from "vitest";
import type { Task } from "../../src/domain/parser.js";
import type { GitClient, PathOperationsPort } from "../../src/domain/ports/index.js";
import {
  buildCommitMessage,
  commitCheckedTaskWithGitClient,
  isGitRepoWithGitClient,
  isPathInsideRepo,
  isWorkingDirectoryClean,
  resolveGitArtifactAndLockExcludes,
} from "../../src/application/git-operations.js";

const pathOperations: PathOperationsPort = {
  join: (...parts) => parts.join("/").replace(/\/+/g, "/"),
  resolve: (...parts) => parts.join("/").replace(/\/+/g, "/"),
  dirname: (filePath) => filePath.split("/").slice(0, -1).join("/") || "/",
  relative: (from, to) => to.replace(from, "").replace(/^\//, ""),
  isAbsolute: (filePath) => filePath.startsWith("/") || /^[A-Za-z]:\\/.test(filePath),
};

describe("git-operations", () => {
  it("detects git worktrees", async () => {
    const gitClient: GitClient = { run: vi.fn(async () => "true") };
    await expect(isGitRepoWithGitClient(gitClient, "/repo")).resolves.toBe(true);

    vi.mocked(gitClient.run).mockRejectedValueOnce(new Error("not a repo"));
    await expect(isGitRepoWithGitClient(gitClient, "/repo")).resolves.toBe(false);
  });

  it("checks worktree cleanliness while excluding artifact paths", async () => {
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return "/repo";
        }
        if (args[0] === "check-ignore") {
          throw new Error("not ignored");
        }
        return "";
      }),
    };

    await expect(isWorkingDirectoryClean(
      gitClient,
      "/repo",
      { configDir: "/repo/.rundown", isExplicit: false },
      pathOperations,
    )).resolves.toBe(true);

    expect(gitClient.run).toHaveBeenCalledWith(
      [
        "status",
        "--porcelain",
        "--",
        ":/",
        ":(top,exclude).rundown/runs/**",
        ":(top,exclude).rundown/logs/**",
        ":(top,exclude).rundown/*.lock",
        ":(glob,exclude)**/.rundown/*.lock",
      ],
      "/repo",
    );
  });

  it("builds add+commit command sequence for checked task", async () => {
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return "/repo";
        }
        if (args[0] === "check-ignore") {
          throw new Error("not ignored");
        }
        if (args[0] === "status") {
          return " M tasks.md";
        }
        return "";
      }),
    };
    const task: Task = {
      text: "cli: echo hello",
      checked: true,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 17,
      file: "/repo/tasks.md",
      isInlineCli: true,
      cliCommand: "echo hello",
      depth: 0,
      children: [],
      subItems: [],
    };

    await expect(commitCheckedTaskWithGitClient(
      gitClient,
      task,
      "/repo",
      "done",
      { configDir: "/repo/.rundown", isExplicit: false },
      pathOperations,
    )).resolves.toEqual({ kind: "committed" });

    expect(gitClient.run).toHaveBeenNthCalledWith(
      3,
      [
        "status",
        "--porcelain",
        "--untracked-files=no",
        "--",
        ":/",
        ":(top,exclude).rundown/runs/**",
        ":(top,exclude).rundown/logs/**",
        ":(top,exclude).rundown/*.lock",
        ":(glob,exclude)**/.rundown/*.lock",
      ],
      "/repo",
    );
    expect(gitClient.run).toHaveBeenNthCalledWith(
      4,
      [
        "add",
        "-A",
        "--",
        ":/",
        ":(top,exclude).rundown/runs/**",
        ":(top,exclude).rundown/logs/**",
        ":(top,exclude).rundown/*.lock",
        ":(glob,exclude)**/.rundown/*.lock",
      ],
      "/repo",
    );
    expect(gitClient.run).toHaveBeenNthCalledWith(5, ["commit", "-m", "done"], "/repo");
  });

  it("skips commit when no committable changes are present", async () => {
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return "/repo";
        }
        if (args[0] === "check-ignore") {
          throw new Error("not ignored");
        }
        if (args[0] === "status") {
          return "";
        }
        return "";
      }),
    };
    const task: Task = {
      text: "noop",
      checked: true,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 4,
      file: "/repo/tasks.md",
      isInlineCli: true,
      cliCommand: "echo noop",
      depth: 0,
      children: [],
      subItems: [],
    };

    await expect(commitCheckedTaskWithGitClient(
      gitClient,
      task,
      "/repo",
      "done",
      { configDir: "/repo/.rundown", isExplicit: false },
      pathOperations,
    )).resolves.toEqual({ kind: "skipped-no-changes" });

    const executedCommands = vi.mocked(gitClient.run).mock.calls.map(([args]) => args[0]);
    expect(executedCommands).not.toContain("add");
    expect(executedCommands).not.toContain("commit");
  });

  it("normalizes git no-op commit response when preflight misses", async () => {
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return "/repo";
        }
        if (args[0] === "check-ignore") {
          throw new Error("not ignored");
        }
        if (args[0] === "status") {
          return " M tasks.md";
        }
        if (args[0] === "commit") {
          throw new Error("nothing to commit, working tree clean");
        }
        return "";
      }),
    };
    const task: Task = {
      text: "noop fallback",
      checked: true,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 13,
      file: "/repo/tasks.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    };

    await expect(commitCheckedTaskWithGitClient(
      gitClient,
      task,
      "/repo",
      "done",
      { configDir: "/repo/.rundown", isExplicit: false },
      pathOperations,
    )).resolves.toEqual({ kind: "skipped-no-changes" });
  });

  it("does not normalize non-no-op commit errors", async () => {
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return "/repo";
        }
        if (args[0] === "check-ignore") {
          throw new Error("not ignored");
        }
        if (args[0] === "status") {
          return " M tasks.md";
        }
        if (args[0] === "commit") {
          throw new Error("pre-commit hook failed");
        }
        return "";
      }),
    };
    const task: Task = {
      text: "commit failure",
      checked: true,
      index: 0,
      line: 1,
      column: 1,
      offsetStart: 0,
      offsetEnd: 14,
      file: "/repo/tasks.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    };

    await expect(commitCheckedTaskWithGitClient(
      gitClient,
      task,
      "/repo",
      "done",
      { configDir: "/repo/.rundown", isExplicit: false },
      pathOperations,
    )).rejects.toThrow("pre-commit hook failed");
  });

  it("formats commit message template variables", () => {
    const task: Task = {
      text: "ship release",
      checked: true,
      index: 1,
      line: 9,
      column: 1,
      offsetStart: 0,
      offsetEnd: 12,
      file: "/repo/docs/tasks.md",
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    };

    const message = buildCommitMessage(
      task,
      "/repo",
      "done: {{task}} @ {{file}}",
      pathOperations,
    );
    expect(message).toBe("done: ship release @ docs/tasks.md");
  });

  it("handles repo-relative exclude resolution and path guards", async () => {
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "check-ignore") {
          throw new Error("not ignored");
        }
        return "/repo";
      }),
    };
    await expect(resolveGitArtifactAndLockExcludes(
      gitClient,
      "/repo/packages/app",
      { configDir: "/repo/.rundown", isExplicit: false },
      pathOperations,
    )).resolves.toEqual([
      ":(top,exclude).rundown/runs/**",
      ":(top,exclude).rundown/logs/**",
      ":(top,exclude).rundown/*.lock",
      ":(glob,exclude)**/.rundown/*.lock",
    ]);

    expect(isPathInsideRepo(".")).toBe(false);
    expect(isPathInsideRepo("../x")).toBe(false);
    expect(isPathInsideRepo("/abs/path")).toBe(false);
    expect(isPathInsideRepo("docs/tasks.md")).toBe(true);
  });

  it("returns empty excludes when config directory is gitignored", async () => {
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return "/repo";
        }
        // check-ignore exits 0 (resolves) when the path IS ignored.
        if (args[0] === "check-ignore") {
          return "";
        }
        return "";
      }),
    };
    await expect(resolveGitArtifactAndLockExcludes(
      gitClient,
      "/repo",
      { configDir: "/repo/.rundown", isExplicit: false },
      pathOperations,
    )).resolves.toEqual([]);
  });

  it("includes excludes when config directory is not gitignored", async () => {
    const gitClient: GitClient = {
      run: vi.fn(async (args: string[]) => {
        if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
          return "/repo";
        }
        // check-ignore exits non-zero (rejects) when path is NOT ignored.
        if (args[0] === "check-ignore") {
          throw new Error("not ignored");
        }
        return "";
      }),
    };
    await expect(resolveGitArtifactAndLockExcludes(
      gitClient,
      "/repo",
      { configDir: "/repo/.rundown", isExplicit: false },
      pathOperations,
    )).resolves.toEqual([
      ":(top,exclude).rundown/runs/**",
      ":(top,exclude).rundown/logs/**",
      ":(top,exclude).rundown/*.lock",
      ":(glob,exclude)**/.rundown/*.lock",
    ]);
  });
});
