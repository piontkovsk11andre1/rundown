import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  vi.restoreAllMocks();
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-todo-cli-int-"));
  tempDirs.push(dir);
  return dir;
}

async function runCli(args: string[], cwd: string): Promise<{ code: number; logs: string[]; errors: string[] }> {
  const previousCwd = process.cwd();
  const previousEnv = process.env.MD_TODO_DISABLE_AUTO_PARSE;
  const previousTestModeEnv = process.env.MD_TODO_TEST_MODE;

  process.chdir(cwd);
  process.env.MD_TODO_DISABLE_AUTO_PARSE = "1";
  process.env.MD_TODO_TEST_MODE = "1";

  vi.resetModules();

  const logs: string[] = [];
  const errors: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    logs.push(values.map((value) => String(value)).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map((value) => String(value)).join(" "));
  });

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(args);
    return { code: 0, logs, errors };
  } catch (error) {
    const message = String(error);
    const match = message.match(/CLI exited with code (\d+)/);
    if (match) {
      return { code: Number(match[1]), logs, errors };
    }

    errors.push(message);
    return { code: 1, logs, errors };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.chdir(previousCwd);

    if (previousEnv === undefined) {
      delete process.env.MD_TODO_DISABLE_AUTO_PARSE;
    } else {
      process.env.MD_TODO_DISABLE_AUTO_PARSE = previousEnv;
    }

    if (previousTestModeEnv === undefined) {
      delete process.env.MD_TODO_TEST_MODE;
    } else {
      process.env.MD_TODO_TEST_MODE = previousTestModeEnv;
    }
  }
}

describe.sequential("CLI integration", () => {
  it("next exits with 0 when an unchecked task exists", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "tasks.md"), "- [ ] Ship release notes\n", "utf-8");

    const result = await runCli(["next", "tasks.md"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Ship release notes"))).toBe(true);
  });

  it("next exits with 3 when no unchecked tasks exist", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "tasks.md"), "- [x] Done already\n", "utf-8");

    const result = await runCli(["next", "tasks.md"], workspace);

    expect(result.code).toBe(3);
    expect(result.logs.some((line) => line.includes("No unchecked tasks found"))).toBe(true);
  });

  it("run dry-run preserves --worker token with spaces", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const workerWithSpaces = "C:\\Program Files\\Tool\\runner.cmd";
    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
      "--",
      workerWithSpaces,
      "--flag",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes(workerWithSpaces))).toBe(true);
    expect(result.logs.some((line) => line.includes("--flag"))).toBe(true);
  });

  it("run supports --only-verify and --no-repair flags", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Verify feature state\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--only-verify",
      "--no-repair",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would run verification"))).toBe(true);
  });

  it("run accepts --keep-artifacts during dry-run", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--keep-artifacts",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would run: opencode run"))).toBe(true);
  });

  it("run enables verification by default", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("No worker command specified"))).toBe(true);
  });

  it("run allows disabling default verification with --no-verify", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--dry-run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would execute inline CLI"))).toBe(true);
  });

  it("run supports legacy --no-validate alias for --no-verify", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-validate",
      "--dry-run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would execute inline CLI"))).toBe(true);
  });

  it("run keeps legacy --only-validate and --no-correct aliases working", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Verify legacy flags\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--only-validate",
      "--no-correct",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would run verification"))).toBe(true);
  });

  it("plan rejects non-wait mode", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Break down migration\n", "utf-8");

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--mode",
      "tui",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Invalid --mode value: tui. Allowed: wait."))).toBe(true);
  });

  it("run skips immediate verification in detached mode and keeps runtime artifacts", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const spawnMock = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      return child;
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--mode",
      "detached",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.logs.some((line) => line.includes("skipping immediate verification"))).toBe(true);

    const runsDir = path.join(workspace, ".md-todo", "runs");
    expect(fs.existsSync(runsDir)).toBe(true);
    expect(fs.readdirSync(runsDir).length).toBe(1);
  });

  it("artifacts lists saved runtime runs", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-test",
      status: "completed",
    });

    const result = await runCli(["artifacts"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("run-20260317T000000000Z-test"))).toBe(true);
    expect(result.logs.some((line) => line.includes("task: Write docs — roadmap.md:1"))).toBe(true);
    expect(result.logs.some((line) => line.includes("worker: opencode run"))).toBe(true);
  });

  it("artifacts --clean removes saved runtime runs", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-a",
      status: "completed",
    });
    writeSavedRun(workspace, {
      runId: "run-b",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
    });

    const result = await runCli(["artifacts", "--clean"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Removed 2 runtime artifact runs."))).toBe(true);
    expect(fs.readdirSync(path.join(workspace, ".md-todo", "runs")).length).toBe(0);
  });

  it("artifacts --json prints saved runtime runs as JSON", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-json",
      status: "completed",
    });

    const result = await runCli(["artifacts", "--json"], workspace);

    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.logs.join("\n")) as Array<{ runId: string; status: string }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.runId).toBe("run-20260317T000000000Z-json");
    expect(parsed[0]?.status).toBe("completed");
  });

  it("artifacts --failed filters to failed runtime runs", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-failed",
      status: "verification-failed",
      startedAt: "2026-03-17T00:01:00.000Z",
    });

    const result = await runCli(["artifacts", "--failed"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("run-20260317T000100000Z-failed"))).toBe(true);
    expect(result.logs.some((line) => line.includes("run-20260317T000000000Z-completed"))).toBe(false);
  });

  it("artifacts --open opens a saved runtime run folder", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-open",
      status: "completed",
    });

    const spawnMock = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      return child;
    });

    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const result = await runCli(["artifacts", "--open", "run-20260317T000000000Z-open"], workspace);

    vi.doUnmock("node:child_process");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    const expectedCommand = process.platform === "win32"
      ? "explorer"
      : process.platform === "darwin"
        ? "open"
        : "xdg-open";
    expect(cmd).toBe(expectedCommand);
    expect(args[0]).toBe(path.join(workspace, ".md-todo", "runs", "run-20260317T000000000Z-open"));
    expect(result.logs.some((line) => line.includes("Opened runtime artifacts"))).toBe(true);
  });

  it("artifacts --open latest opens the newest saved runtime run folder", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-old",
      status: "completed",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-new",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
    });

    const spawnMock = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      return child;
    });

    vi.doMock("node:child_process", () => ({
      spawn: spawnMock,
    }));

    const result = await runCli(["artifacts", "--open", "latest"], workspace);

    vi.doUnmock("node:child_process");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe(path.join(workspace, ".md-todo", "runs", "run-20260317T000100000Z-new"));
  });

  it("artifacts --clean --failed removes only failed runtime runs", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-keep",
      status: "completed",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-drop",
      status: "execution-failed",
      startedAt: "2026-03-17T00:01:00.000Z",
    });

    const result = await runCli(["artifacts", "--clean", "--failed"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Removed 1 failed runtime artifact run."))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".md-todo", "runs", "run-20260317T000000000Z-keep"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".md-todo", "runs", "run-20260317T000100000Z-drop"))).toBe(false);
  });

  it("list exits with 0 when source has no tasks", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\nNo tasks here.\n", "utf-8");

    const result = await runCli(["list", "notes.md"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("No tasks found"))).toBe(true);
  });
});

function writeSavedRun(
  workspace: string,
  options: {
    runId: string;
    status: string;
    startedAt?: string;
  },
): void {
  const runDir = path.join(workspace, ".md-todo", "runs", options.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
    runId: options.runId,
    commandName: "run",
    workerCommand: ["opencode", "run"],
    mode: "wait",
    transport: "file",
    source: "roadmap.md",
    task: {
      text: "Write docs",
      file: "roadmap.md",
      line: 1,
      index: 1,
      source: "roadmap.md",
    },
    keepArtifacts: true,
    startedAt: options.startedAt ?? "2026-03-17T00:00:00.000Z",
    completedAt: "2026-03-17T00:01:00.000Z",
    status: options.status,
  }, null, 2), "utf-8");
}
