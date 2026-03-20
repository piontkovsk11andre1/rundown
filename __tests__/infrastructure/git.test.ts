import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { commitCheckedTask, isGitRepo } from "../../src/infrastructure/git.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-git-test-"));
  tempDirs.push(dir);
  return dir;
}

function gitInit(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "rundown test"], { cwd: dir, stdio: "ignore" });
}

function gitLog(dir: string): string {
  return execFileSync("git", ["log", "--oneline", "--format=%s"], { cwd: dir, encoding: "utf-8" }).trim();
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf-8" }).trim();
}

describe("isGitRepo", () => {
  it("returns true inside a git repository", async () => {
    const dir = makeTempDir();
    gitInit(dir);

    expect(await isGitRepo(dir)).toBe(true);
  });

  it("returns false outside a git repository", async () => {
    const dir = makeTempDir();

    expect(await isGitRepo(dir)).toBe(false);
  });
});

describe("commitCheckedTask", () => {
  it("creates a commit with the default message format", async () => {
    const dir = makeTempDir();
    gitInit(dir);

    // Create and commit an initial file so HEAD exists
    const filePath = path.join(dir, "tasks.md");
    fs.writeFileSync(filePath, "- [ ] Initial task\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

    // Simulate marking the task as checked
    fs.writeFileSync(filePath, "- [x] Initial task\n", "utf-8");

    const message = await commitCheckedTask({
      task: "Initial task",
      file: filePath,
      line: 1,
      index: 0,
      cwd: dir,
    });

    expect(message).toBe('rundown: complete "Initial task" in tasks.md');
    expect(gitLog(dir)).toContain('rundown: complete "Initial task" in tasks.md');
    expect(gitStatus(dir)).toBe("");
  });

  it("uses a custom commit message template", async () => {
    const dir = makeTempDir();
    gitInit(dir);

    const filePath = path.join(dir, "work.md");
    fs.writeFileSync(filePath, "- [ ] Build feature\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

    fs.writeFileSync(filePath, "- [x] Build feature\n", "utf-8");

    const message = await commitCheckedTask({
      task: "Build feature",
      file: filePath,
      line: 1,
      index: 0,
      cwd: dir,
      messageTemplate: "done: {{task}} ({{file}})",
    });

    expect(message).toBe("done: Build feature (work.md)");
    expect(gitLog(dir)).toContain("done: Build feature (work.md)");
  });

  it("stages and commits all worktree changes", async () => {
    const dir = makeTempDir();
    gitInit(dir);

    const taskFile = path.join(dir, "tasks.md");
    const otherFile = path.join(dir, "unrelated.txt");
    fs.writeFileSync(taskFile, "- [ ] Task\n", "utf-8");
    fs.writeFileSync(otherFile, "original\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

    // Modify both files
    fs.writeFileSync(taskFile, "- [x] Task\n", "utf-8");
    fs.writeFileSync(otherFile, "modified\n", "utf-8");

    await commitCheckedTask({
      task: "Task",
      file: taskFile,
      line: 1,
      index: 0,
      cwd: dir,
    });

    // Both modified files are included in the completion commit.
    expect(gitStatus(dir)).toBe("");
    const changedFiles = execFileSync("git", ["show", "--name-only", "--pretty=", "HEAD"], {
      cwd: dir,
      encoding: "utf-8",
    }).trim();
    expect(changedFiles).toContain("tasks.md");
    expect(changedFiles).toContain("unrelated.txt");
  });

  it("handles files in subdirectories", async () => {
    const dir = makeTempDir();
    gitInit(dir);

    const subDir = path.join(dir, "docs", "tasks");
    fs.mkdirSync(subDir, { recursive: true });
    const filePath = path.join(subDir, "sprint.md");
    fs.writeFileSync(filePath, "- [ ] Deploy\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

    fs.writeFileSync(filePath, "- [x] Deploy\n", "utf-8");

    const message = await commitCheckedTask({
      task: "Deploy",
      file: filePath,
      line: 1,
      index: 0,
      cwd: dir,
    });

    expect(message).toBe('rundown: complete "Deploy" in docs/tasks/sprint.md');
  });

  it("throws when there are no changes to commit", async () => {
    const dir = makeTempDir();
    gitInit(dir);

    const filePath = path.join(dir, "tasks.md");
    fs.writeFileSync(filePath, "- [x] Already done\n", "utf-8");
    execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

    // No changes — commit should fail
    await expect(
      commitCheckedTask({
        task: "Already done",
        file: filePath,
        line: 1,
        index: 0,
        cwd: dir,
      }),
    ).rejects.toThrow();
  });
});
