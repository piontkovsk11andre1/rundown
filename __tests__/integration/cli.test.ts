import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStoreStatus } from "../../src/domain/ports/index.js";
import { createLockfileFileLock } from "../../src/infrastructure/file-lock.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-cli-int-"));
  tempDirs.push(dir);
  return dir;
}

async function runCli(args: string[], cwd: string): Promise<{
  code: number;
  logs: string[];
  errors: string[];
  stdoutWrites: string[];
  stderrWrites: string[];
}> {
  const previousCwd = process.cwd();
  const previousEnv = process.env.RUNDOWN_DISABLE_AUTO_PARSE;
  const previousTestModeEnv = process.env.RUNDOWN_TEST_MODE;

  process.chdir(cwd);
  process.env.RUNDOWN_DISABLE_AUTO_PARSE = "1";
  process.env.RUNDOWN_TEST_MODE = "1";

  vi.resetModules();

  const logs: string[] = [];
  const errors: string[] = [];
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];

  const logSpy = vi.spyOn(console, "log").mockImplementation((...values: unknown[]) => {
    logs.push(values.map((value) => String(value)).join(" "));
  });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((...values: unknown[]) => {
    errors.push(values.map((value) => String(value)).join(" "));
  });
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
    throw {
      __cliExit: true,
      exitCode: typeof code === "number" ? code : Number(code ?? 0),
    };
  }) as typeof process.exit);
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);

  try {
    const { parseCliArgs } = await import("../../src/presentation/cli.js");
    await parseCliArgs(args);
    return { code: 0, logs, errors, stdoutWrites, stderrWrites };
  } catch (error) {
    if (
      typeof error === "object"
      && error !== null
      && "__cliExit" in error
      && (error as { __cliExit?: unknown }).__cliExit === true
    ) {
      return {
        code: (error as { exitCode: number }).exitCode,
        logs,
        errors,
        stdoutWrites,
        stderrWrites,
      };
    }

    if (
      typeof error === "object"
      && error !== null
      && "exitCode" in error
      && typeof (error as { exitCode?: unknown }).exitCode === "number"
    ) {
      return {
        code: (error as { exitCode: number }).exitCode,
        logs,
        errors,
        stdoutWrites,
        stderrWrites,
      };
    }

    const message = String(error);
    const match = message.match(/CLI exited with code (\d+)/);
    if (match) {
      return { code: Number(match[1]), logs, errors, stdoutWrites, stderrWrites };
    }

    errors.push(message);
    return { code: 1, logs, errors, stdoutWrites, stderrWrites };
  } finally {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.chdir(previousCwd);

    if (previousEnv === undefined) {
      delete process.env.RUNDOWN_DISABLE_AUTO_PARSE;
    } else {
      process.env.RUNDOWN_DISABLE_AUTO_PARSE = previousEnv;
    }

    if (previousTestModeEnv === undefined) {
      delete process.env.RUNDOWN_TEST_MODE;
    } else {
      process.env.RUNDOWN_TEST_MODE = previousTestModeEnv;
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

  it("next exits with 3 when source resolves to no markdown files", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["next", "missing/**/*.md"], workspace);

    expect(result.code).toBe(3);
    expect(result.logs.some((line) => line.includes("No Markdown files found matching: missing/**/*.md"))).toBe(true);
  });

  it("next remains read-only and ignores existing source lockfiles", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "tasks.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    fs.writeFileSync(sourcePath, "- [ ] Ship release notes\n", "utf-8");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: sourcePath,
    }), "utf-8");

    const result = await runCli(["next", sourceName], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Ship release notes"))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("reverify remains read-only and is not blocked by an active run lock", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    fs.writeFileSync(sourcePath, "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: sourcePath,
    }), "utf-8");

    const result = await runCli([
      "reverify",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Re-verify task:"))).toBe(true);
    expect(result.errors.some((line) => line.includes("Source file is locked by another rundown process"))).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true);
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

  it("run rejects unknown hide-agent-output variants", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--hide-agent-outputs",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("--hide-agent-outputs")).toBe(true);
    expect(combinedOutput.includes("unknown option")).toBe(true);
  });

  it("run auto-skips execution for verify-only tasks", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] verify: release docs are consistent\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task classified as verify-only"))).toBe(true);
    expect(result.logs.some((line) => line.includes("would run verification"))).toBe(true);
  });

  it("run --force-execute overrides verify-only auto-skip", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] verify: release docs are consistent\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--force-execute",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("--force-execute is enabled; running execution"))).toBe(true);
    expect(result.logs.some((line) => line.includes("would run: opencode run"))).toBe(true);
  });

  it("reverify dry-run exits with 3 when no completed artifacts exist", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "reverify",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("No saved runtime artifact run found for: latest completed"))).toBe(true);
  });

  it("reverify returns 3 for invalid run id", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-existing",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--run",
      "run-missing",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("No saved runtime artifact run found for: run-missing"))).toBe(true);
  });

  it("reverify returns 3 when selected run is missing run metadata", async () => {
    const workspace = makeTempWorkspace();
    const missingMetadataRunId = "run-20260317T000000000Z-missing-metadata";
    fs.mkdirSync(path.join(workspace, ".rundown", "runs", missingMetadataRunId), { recursive: true });

    const result = await runCli([
      "reverify",
      "--run",
      missingMetadataRunId,
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("Selected run is missing run metadata (run.json)"))).toBe(true);
    expect(result.errors.some((line) => line.includes("--keep-artifacts"))).toBe(true);
  });

  it("reverify --print-prompt prints verify prompt for resolved historical task", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("## Phase"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Write docs"))).toBe(true);
  });

  it("reverify --dry-run resolves task and reports planned verification", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Re-verify task:"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Dry run - would run verification with: opencode run"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Prompt length:"))).toBe(true);
  });

  it("reverify --all --dry-run lists all selected completed runs", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n- [x] Ship release\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-newest",
      status: "completed",
      taskText: "Write docs",
      startedAt: "2026-03-17T00:01:00.000Z",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-older",
      status: "reverify-completed",
      taskText: "Ship release",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000200000Z-failed",
      status: "verification-failed",
      taskText: "Ignore failed",
      startedAt: "2026-03-17T00:02:00.000Z",
    });

    const result = await runCli([
      "reverify",
      "--all",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would re-verify 2 completed runs"))).toBe(true);
    expect(result.logs.some((line) => line.includes("run-20260317T000100000Z-newest"))).toBe(true);
    expect(result.logs.some((line) => line.includes("run-20260317T000000000Z-older"))).toBe(true);
    expect(result.logs.some((line) => line.includes("run-20260317T000200000Z-failed"))).toBe(false);
  });

  it("reverify --last 2 --dry-run lists the two most recent completed runs", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n- [x] Ship release\n- [x] Publish changelog\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000300000Z-newest-completed",
      status: "completed",
      taskText: "Write docs",
      startedAt: "2026-03-17T00:03:00.000Z",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000200000Z-second-completed",
      status: "reverify-completed",
      taskText: "Ship release",
      startedAt: "2026-03-17T00:02:00.000Z",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-third-completed",
      status: "completed",
      taskText: "Publish changelog",
      startedAt: "2026-03-17T00:01:00.000Z",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000400000Z-failed",
      status: "verification-failed",
      taskText: "Ignore failed",
      startedAt: "2026-03-17T00:04:00.000Z",
    });

    const result = await runCli([
      "reverify",
      "--last",
      "2",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would re-verify 2 completed runs"))).toBe(true);
    expect(result.logs.some((line) => line.includes("run-20260317T000300000Z-newest-completed"))).toBe(true);
    expect(result.logs.some((line) => line.includes("run-20260317T000200000Z-second-completed"))).toBe(true);
    expect(result.logs.some((line) => line.includes("run-20260317T000100000Z-third-completed"))).toBe(false);
    expect(result.logs.some((line) => line.includes("run-20260317T000400000Z-failed"))).toBe(false);
  });

  it("reverify --help lists run targeting and repair options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["reverify", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--run <id|latest> Choose artifact run id or 'latest'");
    expect(compactHelpOutput).toContain("--repair-attempts <n> Max repair attempts on verification failure");
    expect(compactHelpOutput).toContain("--no-repair Disable repair even when repair attempts are set");
  });

  it("revert --help lists run targeting options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["revert", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--run <id|latest> Target artifact run id or 'latest'");
    expect(compactHelpOutput).toContain("--last <n> Revert the last N completed+committed runs");
    expect(compactHelpOutput).toContain("--method <revert|reset> Git undo strategy");
    expect(compactHelpOutput).toContain("--force Bypass clean-worktree and reset contiguous-HEAD checks");
    expect(compactHelpOutput).toContain("--keep-artifacts Preserve runtime prompts, logs, and metadata under .rundown/runs");
  });

  it("revert returns 3 when no completed artifacts exist", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "revert",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("No saved runtime artifact run found for: latest completed"))).toBe(true);
  });

  it("revert succeeds for a single committed run created via CLI", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const runResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--keep-artifacts",
    ], workspace);

    expect(runResult.code).toBe(0);
    expect(runResult.logs.some((line) => line.includes("Task checked: cli: echo hello"))).toBe(true);
    expect(runResult.logs.some((line) => line.includes("Committed:"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo hello");

    const revertResult = await runCli(["revert"], workspace);

    expect(revertResult.code).toBe(0);
    expect(revertResult.logs.some((line) => line.includes("Reverted 1 run successfully."))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: echo hello");
  });

  it("revert succeeds when the markdown file was moved after the original run", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const docsPath = path.join(workspace, "docs", "roadmap.md");

    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const runResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--keep-artifacts",
    ], workspace);

    expect(runResult.code).toBe(0);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo hello");

    execFileSync("git", ["mv", "roadmap.md", "docs/roadmap.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "move roadmap"], { cwd: workspace, stdio: "ignore" });
    expect(fs.existsSync(roadmapPath)).toBe(false);
    expect(fs.readFileSync(docsPath, "utf-8")).toContain("- [x] cli: echo hello");

    const revertResult = await runCli(["revert"], workspace);

    expect(revertResult.code).toBe(0);
    expect(revertResult.logs.some((line) => line.includes("which no longer exists"))).toBe(true);
    expect(revertResult.logs.some((line) => line.includes("commit-based revert"))).toBe(true);
    expect(revertResult.logs.some((line) => line.includes("Reverted 1 run successfully."))).toBe(true);
    expect(fs.existsSync(roadmapPath)).toBe(false);
    expect(fs.readFileSync(docsPath, "utf-8")).toContain("- [ ] cli: echo hello");
  });

  it("revert --last 3 succeeds with multiple committed runs", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: echo first\n- [ ] cli: echo second\n- [ ] cli: echo third\n",
      "utf-8",
    );
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    for (let i = 0; i < 3; i += 1) {
      const runResult = await runCli([
        "run",
        "roadmap.md",
        "--no-verify",
        "--commit",
        "--keep-artifacts",
      ], workspace);
      expect(runResult.code).toBe(0);
      expect(runResult.logs.some((line) => line.includes("Committed:"))).toBe(true);
    }

    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo first");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo second");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo third");

    const revertResult = await runCli(["revert", "--last", "3"], workspace);

    expect(revertResult.code).toBe(0);
    expect(revertResult.logs.some((line) => line.includes("Reverted 3 runs successfully."))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: echo first");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: echo second");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: echo third");
  });

  it("revert --method reset succeeds when target commit is at HEAD", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const runResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--keep-artifacts",
    ], workspace);

    expect(runResult.code).toBe(0);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo hello");
    expect(
      Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: workspace, encoding: "utf-8" }).trim()),
    ).toBe(2);

    const revertResult = await runCli(["revert", "--method", "reset"], workspace);

    expect(revertResult.code).toBe(0);
    expect(revertResult.logs.some((line) => line.includes("Reverted 1 run successfully."))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: echo hello");
    expect(
      Number(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: workspace, encoding: "utf-8" }).trim()),
    ).toBe(1);
  });

  it("revert --method reset returns 1 when target commit is not at HEAD", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    fs.writeFileSync(roadmapPath, "- [x] cli: echo hello\n", "utf-8");
    execFileSync("git", ["add", "roadmap.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rundown: complete \"cli: echo hello\" in roadmap.md"], {
      cwd: workspace,
      stdio: "ignore",
    });
    const committedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    fs.writeFileSync(path.join(workspace, "notes.txt"), "follow-up change\n", "utf-8");
    execFileSync("git", ["add", "notes.txt"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "follow-up"], { cwd: workspace, stdio: "ignore" });

    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-not-head",
      status: "completed",
      extra: {
        commitSha: committedSha,
        commitMessage: "rundown: complete \"cli: echo hello\" in roadmap.md",
      },
    });

    const result = await runCli([
      "revert",
      "--method",
      "reset",
      "--run",
      "run-20260317T000000000Z-not-head",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("contiguous block at HEAD"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo hello");
  });

  it("revert --method reset --force bypasses dirty-worktree and contiguous-HEAD checks", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    fs.writeFileSync(roadmapPath, "- [x] cli: echo hello\n", "utf-8");
    execFileSync("git", ["add", "roadmap.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rundown: complete \"cli: echo hello\" in roadmap.md"], {
      cwd: workspace,
      stdio: "ignore",
    });
    const committedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    fs.writeFileSync(path.join(workspace, "notes.txt"), "follow-up change\n", "utf-8");
    execFileSync("git", ["add", "notes.txt"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "follow-up"], { cwd: workspace, stdio: "ignore" });

    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-force-reset",
      status: "completed",
      extra: {
        commitSha: committedSha,
        commitMessage: "rundown: complete \"cli: echo hello\" in roadmap.md",
      },
    });

    fs.writeFileSync(path.join(workspace, "dirty.txt"), "uncommitted\n", "utf-8");

    const result = await runCli([
      "revert",
      "--method",
      "reset",
      "--force",
      "--run",
      "run-20260317T000000000Z-force-reset",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("--force enabled: skipping clean-worktree precondition check."))).toBe(true);
    expect(result.logs.some((line) => line.includes("--force enabled: skipping contiguous-HEAD validation for reset."))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: echo hello");
    expect(fs.existsSync(path.join(workspace, "notes.txt"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "dirty.txt"))).toBe(true);
  });

  it("revert --dry-run prints planned runs and git commands", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n", "utf-8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    fs.writeFileSync(roadmapPath, "- [x] Write docs\n", "utf-8");
    execFileSync("git", ["add", "roadmap.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rundown: complete docs"], { cwd: workspace, stdio: "ignore" });
    const oldestSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    fs.writeFileSync(roadmapPath, "- [x] Write docs v2\n", "utf-8");
    execFileSync("git", ["add", "roadmap.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rundown: complete docs again"], { cwd: workspace, stdio: "ignore" });
    const newestSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-older",
      status: "completed",
      startedAt: "2026-03-17T00:00:00.000Z",
      taskText: "Write docs",
      extra: {
        commitSha: oldestSha,
        commitMessage: "rundown: complete docs",
      },
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-newer",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
      taskText: "Write docs v2",
      extra: {
        commitSha: newestSha,
        commitMessage: "rundown: complete docs again",
      },
    });

    const result = await runCli(["revert", "--all", "--dry-run", "--method", "revert"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Dry run - would revert 2 runs using method=revert."))).toBe(true);
    expect(result.logs.some((line) => line.includes(`run=run-20260317T000100000Z-newer method=revert commit=${newestSha}`))).toBe(true);
    expect(result.logs.some((line) => line.includes(`run=run-20260317T000000000Z-older method=revert commit=${oldestSha}`))).toBe(true);
    expect(result.logs.some((line) => line.includes(`task=roadmap.md:1 [#0] Write docs v2`))).toBe(true);
    expect(result.logs.some((line) => line.includes(`task=roadmap.md:1 [#0] Write docs`))).toBe(true);
    expect(result.logs.some((line) => line.includes(`- git revert ${newestSha} --no-edit`))).toBe(true);
    expect(result.logs.some((line) => line.includes(`- git revert ${oldestSha} --no-edit`))).toBe(true);

    const plannedRunLines = result.logs.filter((line) => line.includes("run=run-20260317"));
    expect(plannedRunLines[0]).toContain("run=run-20260317T000100000Z-newer");
    expect(plannedRunLines[1]).toContain("run=run-20260317T000000000Z-older");
  });

  it("revert --keep-artifacts creates a reverted artifact run", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n", "utf-8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    fs.writeFileSync(roadmapPath, "- [x] Write docs\n", "utf-8");
    execFileSync("git", ["add", "roadmap.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rundown: complete \"Write docs\" in roadmap.md"], { cwd: workspace, stdio: "ignore" });
    const committedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-committed",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
      extra: {
        commitSha: committedSha,
        commitMessage: "rundown: complete \"Write docs\" in roadmap.md",
      },
    });

    const result = await runCli([
      "revert",
      "--run",
      "run-20260317T000000000Z-committed",
      "--keep-artifacts",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Reverted 1 run successfully."))).toBe(true);

    const savedRuns = readSavedRunMetadata(workspace);
    expect(savedRuns.some((run) => run.commandName === "revert" && run.status === "reverted")).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] Write docs");
  });

  it("revert can restore a prior reset-based revert using saved preResetRef", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n", "utf-8");
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const initialSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    fs.writeFileSync(roadmapPath, "- [x] Write docs\n", "utf-8");
    execFileSync("git", ["add", "roadmap.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rundown: complete \"Write docs\" in roadmap.md"], {
      cwd: workspace,
      stdio: "ignore",
    });
    const committedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-committed",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
      extra: {
        commitSha: committedSha,
        commitMessage: "rundown: complete \"Write docs\" in roadmap.md",
      },
    });

    const resetRevertResult = await runCli([
      "revert",
      "--run",
      "run-20260317T000000000Z-committed",
      "--method",
      "reset",
      "--keep-artifacts",
    ], workspace);

    expect(resetRevertResult.code).toBe(0);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] Write docs");

    const resetRun = findSavedRunByCommand(workspace, "revert");
    expect(resetRun?.status).toBe("reverted");
    expect(resetRun?.extra?.method).toBe("reset");
    expect(typeof resetRun?.extra?.preResetRef).toBe("string");
    expect(resetRun).not.toBeNull();
    if (!resetRun) {
      throw new Error("expected reset artifact run to exist");
    }

    fs.writeFileSync(path.join(workspace, "followup.txt"), "post reset\n", "utf-8");
    execFileSync("git", ["add", "followup.txt"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "follow-up after reset"], { cwd: workspace, stdio: "ignore" });

    const restoreResult = await runCli([
      "revert",
      "--run",
      resetRun.runId,
      "--method",
      "reset",
    ], workspace);

    expect(restoreResult.code).toBe(0);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] Write docs");
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf-8" }).trim()).toBe(committedSha);
  });

  it("reverify returns 3 when selected run is not completed", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-incomplete",
      status: "execution-failed",
    });

    const result = await runCli([
      "reverify",
      "--run",
      "run-20260317T000000000Z-incomplete",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("Selected run is not completed"))).toBe(true);
  });

  it("reverify returns 1 when no worker command is available", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-noworker",
      status: "completed",
      workerCommand: [],
    });

    const result = await runCli([
      "reverify",
      "--run",
      "run-20260317T000000000Z-noworker",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("No worker command specified"))).toBe(true);
  });

  it("reverify returns 1 for invalid repair-attempts value", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "reverify",
      "--repair-attempts",
      "abc",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Invalid --repair-attempts value: abc"))).toBe(true);
  });

  it("reverify rejects legacy --retries flag", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "reverify",
      "--retries",
      "1",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("--retries")).toBe(true);
    expect(combinedOutput.includes("unknown option")).toBe(true);
  });

  it("reverify rejects run-only --hide-agent-output flag", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "reverify",
      "--hide-agent-output",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("--hide-agent-output")).toBe(true);
    expect(combinedOutput.includes("unknown option")).toBe(true);
  });

  it("reverify returns 0 when verification passes and does not change markdown checkboxes", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Re-verification passed."))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] Write docs\n");
  });

  it("reverify keeps checked and unchecked checkbox states unchanged on success", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markdown = "- [x] Write docs\n- [ ] Prepare release notes\n";
    fs.writeFileSync(roadmapPath, markdown, "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(markdown);
  });

  it("reverify --keep-artifacts persists run metadata with reverify-completed status", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--keep-artifacts",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], workspace);

    expect(result.code).toBe(0);

    const savedRuns = readSavedRunMetadata(workspace);
    const reverifyRun = savedRuns.find((run) => run.commandName === "reverify");
    expect(reverifyRun).toBeDefined();
    expect(reverifyRun?.status).toBe("reverify-completed");
  });

  it("reverify returns 2 when verification fails", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--no-repair",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Verification failed after all repair attempts."))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] Write docs\n");
  });

  it("reverify runs repair attempts when --repair-attempts is set", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){fs.writeFileSync('.repair-done','1');process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){if(fs.existsSync('.repair-done')){console.log('OK');}process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Repair succeeded after 1 attempt(s)."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Re-verification passed."))).toBe(true);
  });

  it("reverify keeps checked and unchecked checkbox states unchanged on failure", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markdown = "- [x] Write docs\n- [ ] Prepare release notes\n";
    fs.writeFileSync(roadmapPath, markdown, "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--no-repair",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    expect(result.code).toBe(2);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(markdown);
  });

  it("reverify --keep-artifacts persists run metadata with reverify-failed status", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--keep-artifacts",
      "--no-repair",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    expect(result.code).toBe(2);

    const savedRuns = readSavedRunMetadata(workspace);
    const reverifyRun = savedRuns.find((run) => run.commandName === "reverify");
    expect(reverifyRun).toBeDefined();
    expect(reverifyRun?.status).toBe("reverify-failed");
  });

  it("reverify returns 3 when saved task reference is stale", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Different text\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
      taskText: "Write docs",
    });

    const result = await runCli([
      "reverify",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("Could not resolve task from saved metadata"))).toBe(true);
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

  it("run --only-verify runs repair attempts when --repair-attempts is set", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Verify feature state\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--only-verify",
      "--repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){fs.writeFileSync('.repair-done','1');process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){if(fs.existsSync('.repair-done')){console.log('OK');}process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Repair succeeded after 1 attempt(s)."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: Verify feature state"))).toBe(true);
  });

  it("run forwards worker stdout and stderr in wait mode", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const spawnMock = createWaitModeSpawnMock({
      stdout: "worker stdout\n",
      stderr: "worker stderr\n",
      exitCode: 0,
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("worker stdout"))).toBe(true);
    expect(result.stderrWrites.some((line) => line.includes("worker stderr"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: Write docs"))).toBe(true);
  });

  it("run hides worker stdout and stderr with --hide-agent-output", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const spawnMock = createWaitModeSpawnMock({
      stdout: "worker stdout\n",
      stderr: "worker stderr\n",
      exitCode: 0,
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--hide-agent-output",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("worker stdout"))).toBe(false);
    expect(result.stderrWrites.some((line) => line.includes("worker stderr"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Task checked: Write docs"))).toBe(true);
  });

  it("run keeps exit code stable on inline CLI success with --hide-agent-output", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(
      path.join(workspace, "roadmap.md"),
      "- [ ] cli: node -e \"console.log('inline stdout'); console.error('inline stderr')\"\n",
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--hide-agent-output",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs).not.toContain("inline stdout\n");
    expect(result.stderrWrites).not.toContain("inline stderr\n");
    expect(result.logs.some((line) => line.includes("Task checked: cli: node -e"))).toBe(true);
  });

  it("run keeps failure exit code and rundown error output visible with --hide-agent-output", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const spawnMock = createWaitModeSpawnMock({
      stdout: "worker stdout\n",
      stderr: "worker stderr\n",
      exitCode: 7,
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--hide-agent-output",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(1);
    expect(result.logs.some((line) => line.includes("worker stdout"))).toBe(false);
    expect(result.stderrWrites.some((line) => line.includes("worker stderr"))).toBe(false);
    expect(result.errors.some((line) => line.includes("Worker exited with code 7"))).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "roadmap.md"), "utf-8")).toContain("- [ ] Write docs");
  });

  it("run keeps verification/repair summaries visible with --hide-agent-output", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--hide-agent-output",
      "--repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){fs.writeFileSync('.repair-done','1');console.log('repair stdout');console.error('repair stderr');process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){if(fs.existsSync('.repair-done')){console.log('OK');}else{console.log('NOT_OK: failing checks');}console.error('verify stderr');process.exit(0);}console.log('worker stdout');console.error('worker stderr');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Running verification..."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Verification failed. Running repair (1 attempt(s))..."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Repair succeeded after 1 attempt(s)."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: Write docs"))).toBe(true);
    expect(result.logs).not.toContain("worker stdout\n");
    expect(result.stderrWrites).not.toContain("worker stderr\n");
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

  it("run --trace writes trace.jsonl with run lifecycle events", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
      "--trace",
    ], workspace);

    expect(result.code).toBe(0);

    const traceFilePaths = listTraceFiles(workspace);
    expect(traceFilePaths.length).toBeGreaterThan(0);

    const raw = fs.readFileSync(traceFilePaths[0]!, "utf-8").trim();
    expect(raw.length).toBeGreaterThan(0);

    const events = raw.split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event_type?: string });
    const eventTypes = events.map((event) => event.event_type);
    expect(eventTypes).toContain("run.started");
    expect(eventTypes).toContain("run.completed");
  });

  it("run --trace writes analysis.summary as the last event before run.completed", async () => {
    const workspace = makeTempWorkspace();
    const workerScriptPath = path.join(workspace, "trace-worker.mjs");
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "console.log('```analysis.summary');",
        "console.log(JSON.stringify({",
        "  task_complexity: 'medium',",
        "  execution_quality: 'clean',",
        "  direction_changes: 0,",
        "  modules_touched: [],",
        "  wasted_effort_pct: 0,",
        "  key_decisions: [],",
        "  risk_flags: [],",
        "  improvement_suggestions: [],",
        "  skill_gaps: [],",
        "  thinking_quality: 'clear',",
        "  uncertainty_moments: 0,",
        "}));",
        "console.log('```');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
      "--trace",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);

    const traceFilePaths = listTraceFiles(workspace);
    expect(traceFilePaths.length).toBeGreaterThan(0);

    const events = fs.readFileSync(traceFilePaths[0]!, "utf-8")
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event_type?: string });
    const eventTypes = events.map((event) => event.event_type);

    const runCompletedIndex = eventTypes.lastIndexOf("run.completed");
    expect(runCompletedIndex).toBeGreaterThan(0);
    expect(eventTypes[runCompletedIndex - 1]).toBe("analysis.summary");
  });

  it("run --trace includes prompt.metrics, timing.waterfall, and verification.efficiency with numeric payloads", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Verify feature state\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--only-verify",
      "--repair-attempts",
      "1",
      "--trace",
      "--keep-artifacts",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){fs.writeFileSync('.repair-done','1');process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){if(fs.existsSync('.repair-done')){console.log('OK');}process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);

    const traceFilePaths = listTraceFiles(workspace);
    expect(traceFilePaths.length).toBeGreaterThan(0);

    const events = fs.readFileSync(traceFilePaths[0]!, "utf-8")
      .trim()
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { event_type?: string; payload?: Record<string, unknown> });

    const promptMetricsEvent = events.find((event) => event.event_type === "prompt.metrics");
    expect(promptMetricsEvent).toBeDefined();
    expect(typeof promptMetricsEvent?.payload?.char_count).toBe("number");
    expect(Number.isFinite(promptMetricsEvent?.payload?.char_count as number)).toBe(true);
    expect(typeof promptMetricsEvent?.payload?.estimated_tokens).toBe("number");
    expect(Number.isFinite(promptMetricsEvent?.payload?.estimated_tokens as number)).toBe(true);
    expect(typeof promptMetricsEvent?.payload?.context_ratio).toBe("number");
    expect(Number.isFinite(promptMetricsEvent?.payload?.context_ratio as number)).toBe(true);

    const timingWaterfallEvent = events.find((event) => event.event_type === "timing.waterfall");
    expect(timingWaterfallEvent).toBeDefined();
    expect(typeof timingWaterfallEvent?.payload?.idle_time_ms).toBe("number");
    expect(Number.isFinite(timingWaterfallEvent?.payload?.idle_time_ms as number)).toBe(true);
    expect(typeof timingWaterfallEvent?.payload?.total_wall_time_ms).toBe("number");
    expect(Number.isFinite(timingWaterfallEvent?.payload?.total_wall_time_ms as number)).toBe(true);
    expect(typeof timingWaterfallEvent?.payload?.total_worker_time_ms).toBe("number");
    expect(Number.isFinite(timingWaterfallEvent?.payload?.total_worker_time_ms as number)).toBe(true);

    const phases = timingWaterfallEvent?.payload?.phases;
    expect(Array.isArray(phases)).toBe(true);
    expect((phases as unknown[]).length).toBeGreaterThan(0);
    const firstPhase = (phases as Array<Record<string, unknown>>)[0];
    expect(typeof firstPhase?.duration_ms).toBe("number");
    expect(Number.isFinite(firstPhase?.duration_ms as number)).toBe(true);

    const verificationEfficiencyEvent = events.find((event) => event.event_type === "verification.efficiency");
    expect(verificationEfficiencyEvent).toBeDefined();
    expect(typeof verificationEfficiencyEvent?.payload?.total_verify_attempts).toBe("number");
    expect(Number.isFinite(verificationEfficiencyEvent?.payload?.total_verify_attempts as number)).toBe(true);
    expect(typeof verificationEfficiencyEvent?.payload?.total_repair_attempts).toBe("number");
    expect(Number.isFinite(verificationEfficiencyEvent?.payload?.total_repair_attempts as number)).toBe(true);

    const taskContextEvent = events.find((event) => event.event_type === "task.context");
    expect(taskContextEvent).toBeDefined();
    expect(typeof taskContextEvent?.payload?.source_files_scanned).toBe("number");
    expect(typeof taskContextEvent?.payload?.total_unchecked_tasks).toBe("number");
    expect(typeof taskContextEvent?.payload?.task_position_in_file).toBe("number");
    expect(typeof taskContextEvent?.payload?.document_context_lines).toBe("number");
    expect(typeof taskContextEvent?.payload?.has_subtasks).toBe("boolean");
    expect(typeof taskContextEvent?.payload?.is_inline_cli).toBe("boolean");
    expect(typeof taskContextEvent?.payload?.is_verify_only).toBe("boolean");
  });

  it("run without --trace does not create trace.jsonl", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
    ], workspace);

    expect(result.code).toBe(0);
    expect(listTraceFiles(workspace)).toHaveLength(0);
  });

  it("run creates .rundown/logs/output.jsonl", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
    ], workspace);

    expect(result.code).toBe(0);

    const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
    expect(fs.existsSync(outputLogPath)).toBe(true);
  });

  it("run writes global output log even when runtime artifacts are not preserved", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);

    const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
    expect(fs.existsSync(outputLogPath)).toBe(true);

    const entries = readGlobalOutputLogEntries(workspace);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.command === "run")).toBe(true);

    expect(readSavedRunMetadata(workspace)).toHaveLength(0);
  });

  it("keeps global output logging append-only across run commands with mixed artifact retention", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    const firstResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);
    expect(firstResult.code).toBe(0);
    expect(readSavedRunMetadata(workspace)).toHaveLength(0);

    const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
    expect(fs.existsSync(outputLogPath)).toBe(true);

    const firstLines = fs.readFileSync(outputLogPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    expect(firstLines.length).toBeGreaterThan(0);

    const secondResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
    ], workspace);
    expect(secondResult.code).toBe(0);

    const secondLines = fs.readFileSync(outputLogPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    expect(secondLines.length).toBeGreaterThan(firstLines.length);
    expect(secondLines.slice(0, firstLines.length)).toEqual(firstLines);

    const firstEntries = firstLines.map((line) => JSON.parse(line) as { command?: string });
    const appendedEntries = secondLines.slice(firstLines.length)
      .map((line) => JSON.parse(line) as { command?: string });
    expect(firstEntries.some((entry) => entry.command === "run")).toBe(true);
    expect(appendedEntries.some((entry) => entry.command === "run")).toBe(true);

    expect(readSavedRunMetadata(workspace).length).toBeGreaterThan(0);
  });

  it("appends to .rundown/logs/output.jsonl across consecutive CLI commands", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "tasks.md"), "- [ ] Ship release notes\n", "utf-8");

    const firstResult = await runCli(["next", "tasks.md"], workspace);
    expect(firstResult.code).toBe(0);

    const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
    expect(fs.existsSync(outputLogPath)).toBe(true);

    const firstLines = fs.readFileSync(outputLogPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    expect(firstLines.length).toBeGreaterThan(0);

    const secondResult = await runCli(["list", "tasks.md"], workspace);
    expect(secondResult.code).toBe(0);

    const secondLines = fs.readFileSync(outputLogPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    expect(secondLines.length).toBeGreaterThan(firstLines.length);
    expect(secondLines.slice(0, firstLines.length)).toEqual(firstLines);

    const parsedLines = secondLines.map((line) => JSON.parse(line) as { command?: string });
    expect(parsedLines.slice(0, firstLines.length).some((entry) => entry.command === "next")).toBe(true);
    expect(parsedLines.slice(firstLines.length).some((entry) => entry.command === "list")).toBe(true);
  });

  it("writes stable single-line JSONL entries suitable for Promtail ingestion", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "tasks.md"), "- [ ] Ship release notes\n", "utf-8");

    const result = await runCli(["next", "tasks.md"], workspace);
    expect(result.code).toBe(0);

    const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
    const expectedKeys = [
      "argv",
      "command",
      "cwd",
      "kind",
      "level",
      "message",
      "pid",
      "session_id",
      "stream",
      "ts",
      "version",
    ];

    const lines = fs.readFileSync(outputLogPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);

    for (const line of lines) {
      expect(line.includes("\u001b")).toBe(false);

      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(Object.keys(entry).sort()).toEqual(expectedKeys);
      expect(typeof entry.ts).toBe("string");
      expect(Number.isNaN(Date.parse(String(entry.ts)))).toBe(false);
      expect(["info", "warn", "error"]).toContain(entry.level);
      expect(["stdout", "stderr"]).toContain(entry.stream);
      expect(typeof entry.kind).toBe("string");
      expect(typeof entry.message).toBe("string");
      expect(typeof entry.command).toBe("string");
      expect(Array.isArray(entry.argv)).toBe(true);
      expect((entry.argv as unknown[]).every((arg) => typeof arg === "string")).toBe(true);
      expect(typeof entry.cwd).toBe("string");
      expect(typeof entry.pid).toBe("number");
      expect(Number.isInteger(entry.pid)).toBe(true);
      expect(typeof entry.version).toBe("string");
      expect(typeof entry.session_id).toBe("string");
    }
  });

  it("captures invalid flag errors in .rundown/logs/output.jsonl", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "run",
      "roadmap.md",
      "--hide-agent-outputs",
    ], workspace);

    expect(result.code).toBe(1);

    const entries = readGlobalOutputLogEntries(workspace);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.command === "run")).toBe(true);
    expect(entries.some((entry) => {
      return entry.kind === "commander"
        && entry.stream === "stderr"
        && entry.message.toLowerCase().includes("unknown option")
        && entry.message.includes("--hide-agent-outputs");
    })).toBe(true);
  });

  it("captures execution failures in .rundown/logs/output.jsonl", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: __rundown_missing_command__\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(1);

    const entries = readGlobalOutputLogEntries(workspace);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => {
      return entry.command === "run"
        && entry.kind === "error"
        && entry.stream === "stderr"
        && entry.message.includes("Inline CLI exited with code");
    })).toBe(true);
  });

  it("run --trace-only enriches the latest completed run without changing tasks", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const enrichmentScriptPath = path.join(workspace, "trace-enrichment-worker.mjs");
    fs.writeFileSync(roadmapPath, "- [x] Write docs\n", "utf-8");
    fs.writeFileSync(
      enrichmentScriptPath,
      [
        "console.log('```analysis.summary');",
        "console.log(JSON.stringify({",
        "  task_complexity: 'medium',",
        "  execution_quality: 'clean',",
        "  direction_changes: 0,",
        "  modules_touched: [],",
        "  wasted_effort_pct: 0,",
        "  key_decisions: [],",
        "  risk_flags: [],",
        "  improvement_suggestions: [],",
        "  skill_gaps: [],",
        "  thinking_quality: 'clear',",
        "  uncertainty_moments: 0,",
        "}));",
        "console.log('```');",
      ].join("\n"),
      "utf-8",
    );
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "run",
      "roadmap.md",
      "--trace-only",
      "--trace",
      "--worker",
      "node",
      enrichmentScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Trace-only enrichment for run: run-20260317T000000000Z-completed"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Trace enrichment completed for run: run-20260317T000000000Z-completed"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] Write docs\n");

    const tracePath = path.join(workspace, ".rundown", "runs", "run-20260317T000000000Z-completed", "trace.jsonl");
    expect(fs.existsSync(tracePath)).toBe(true);
    const events = fs.readFileSync(tracePath, "utf-8").trim().split(/\r?\n/).map((line) => JSON.parse(line) as { event_type?: string });
    const eventTypes = events.map((event) => event.event_type);
    expect(eventTypes).toContain("phase.started");
    expect(eventTypes).toContain("phase.completed");
    expect(eventTypes).toContain("analysis.summary");
  });

  it("run --trace-only returns 3 when no completed artifacts exist", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "run",
      "roadmap.md",
      "--trace-only",
      "--trace",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("No saved runtime artifact run found for: latest completed"))).toBe(true);
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

  it("run --print-prompt does not execute inline CLI tasks", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "inline-ran.txt");

    fs.writeFileSync(
      roadmapPath,
      `- [ ] cli: node -e "require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'1')"\n`,
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("inline CLI; no worker prompt is rendered"))).toBe(true);
    expect(result.logs.some((line) => line.includes("cli: node -e"))).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli:");
  });

  it("run --print-prompt takes precedence over --dry-run", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Draft release plan\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Draft release plan"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Dry run - would run"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Dry run — would run"))).toBe(false);
  });

  it("run --help lists Git and completion hook options with clear descriptions", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["run", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--commit Auto-commit checked task file after successful completion");
    expect(compactHelpOutput).toContain("--commit-message <template> Commit message template (supports {{task}} and {{file}})");
    expect(compactHelpOutput).toContain("--on-complete <command> Run a shell command after successful task completion");
  });

  it("run passes parsed Git and hook options to the application layer", async () => {
    const workspace = makeTempWorkspace();
    const runTaskMock = vi.fn(async () => 0);

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: runTaskMock,
        reverifyTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
      }),
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
      "--commit",
      "--commit-message",
      "done: {{task}}",
      "--on-complete",
      "node scripts/after.js",
    ], workspace);

    vi.doUnmock("../../src/create-app.js");

    expect(result.code).toBe(0);
    expect(runTaskMock).toHaveBeenCalledTimes(1);
    expect(runTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "roadmap.md",
      dryRun: true,
      workerCommand: ["opencode", "run"],
      commitAfterComplete: true,
      commitMessageTemplate: "done: {{task}}",
      onCompleteCommand: "node scripts/after.js",
    }));
  });

  it("run passes default Git and hook option values when flags are omitted", async () => {
    const workspace = makeTempWorkspace();
    const runTaskMock = vi.fn(async () => 0);

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: runTaskMock,
        reverifyTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
      }),
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    vi.doUnmock("../../src/create-app.js");

    expect(result.code).toBe(0);
    expect(runTaskMock).toHaveBeenCalledTimes(1);
    expect(runTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "roadmap.md",
      dryRun: true,
      workerCommand: ["opencode", "run"],
      commitAfterComplete: false,
      commitMessageTemplate: undefined,
      onCompleteCommand: undefined,
    }));
  });

  it("run normalizes blank Git and hook option values before pass-through", async () => {
    const workspace = makeTempWorkspace();
    const runTaskMock = vi.fn(async () => 0);

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: runTaskMock,
        reverifyTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
      }),
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
      "--commit",
      "--commit-message",
      "   ",
      "--on-complete",
      "",
    ], workspace);

    vi.doUnmock("../../src/create-app.js");

    expect(result.code).toBe(0);
    expect(runTaskMock).toHaveBeenCalledTimes(1);
    expect(runTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "roadmap.md",
      dryRun: true,
      workerCommand: ["opencode", "run"],
      commitAfterComplete: true,
      commitMessageTemplate: undefined,
      onCompleteCommand: undefined,
    }));
  });

  it("run executes --on-complete command with task metadata", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const hookScript = path.join(workspace, "hook.mjs");
    fs.writeFileSync(
      hookScript,
      "console.log([process.env.RUNDOWN_TASK, process.env.RUNDOWN_SOURCE].join('|'));\n",
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--on-complete",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo hello"))).toBe(true);
    expect(result.logs.some((line) => line.includes("cli: echo hello|roadmap.md"))).toBe(true);
  });

  it("run holds the source lock while the --on-complete hook executes", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    fs.writeFileSync(path.join(workspace, sourceName), "- [ ] cli: echo hello\n", "utf-8");

    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const hookScript = path.join(workspace, "hook-check-lock.mjs");
    fs.writeFileSync(
      hookScript,
      `import fs from "node:fs";\nconsole.log("LOCK_EXISTS=" + String(fs.existsSync(${JSON.stringify(lockPath)})));\n`,
      "utf-8",
    );

    const result = await runCli([
      "run",
      sourceName,
      "--no-verify",
      "--on-complete",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("LOCK_EXISTS=true"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
  });

  it("run holds the source lock while the --on-fail hook executes", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    fs.writeFileSync(path.join(workspace, sourceName), "- [ ] cli: fail intentionally\n", "utf-8");

    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const hookScript = path.join(workspace, "hook-check-fail-lock.mjs");
    fs.writeFileSync(
      hookScript,
      `import fs from "node:fs";\nconsole.log("LOCK_EXISTS=" + String(fs.existsSync(${JSON.stringify(lockPath)})));\n`,
      "utf-8",
    );

    const result = await runCli([
      "run",
      sourceName,
      "--no-verify",
      "--on-fail",
      `node ${hookScript.replace(/\\/g, "/")}`,
      "--",
      "node",
      "-e",
      "process.exit(1)",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.logs.some((line) => line.includes("LOCK_EXISTS=true"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
  });

  it("run creates source .rundown lock directory when missing", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "projects/alpha/roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const sourceDir = path.dirname(sourcePath);
    const lockDir = path.join(sourceDir, ".rundown");
    const lockPath = path.join(lockDir, "roadmap.md.lock").replace(/\\/g, "/");

    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, "- [ ] cli: echo hello\n", "utf-8");
    expect(fs.existsSync(lockDir)).toBe(false);

    const hookScript = path.join(workspace, "hook-check-created-lock-dir.mjs");
    fs.writeFileSync(
      hookScript,
      `import fs from "node:fs";\nconsole.log("LOCK_EXISTS=" + String(fs.existsSync(${JSON.stringify(lockPath)})));\n`,
      "utf-8",
    );

    const result = await runCli([
      "run",
      sourceName,
      "--no-verify",
      "--on-complete",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("LOCK_EXISTS=true"))).toBe(true);
    expect(fs.existsSync(lockDir)).toBe(true);
    expect(fs.existsSync(path.join(lockDir, "roadmap.md.lock"))).toBe(false);
  });

  it("run with glob source holds one lock per resolved markdown file", async () => {
    const workspace = makeTempWorkspace();
    const sourceGlob = "projects/*/roadmap.md";
    const alphaDir = path.join(workspace, "projects", "alpha");
    const betaDir = path.join(workspace, "projects", "beta");
    const alphaSourcePath = path.join(alphaDir, "roadmap.md");
    const betaSourcePath = path.join(betaDir, "roadmap.md");

    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(alphaSourcePath, "- [ ] cli: echo alpha\n", "utf-8");
    fs.writeFileSync(betaSourcePath, "- [ ] cli: echo beta\n", "utf-8");

    const alphaLockPath = path.join(alphaDir, ".rundown", "roadmap.md.lock").replace(/\\/g, "/");
    const betaLockPath = path.join(betaDir, ".rundown", "roadmap.md.lock").replace(/\\/g, "/");
    const hookScript = path.join(workspace, "hook-check-multi-locks.mjs");
    fs.writeFileSync(
      hookScript,
      `import fs from "node:fs";\nconsole.log("ALPHA_LOCK_EXISTS=" + String(fs.existsSync(${JSON.stringify(alphaLockPath)})));\nconsole.log("BETA_LOCK_EXISTS=" + String(fs.existsSync(${JSON.stringify(betaLockPath)})));\n`,
      "utf-8",
    );

    const result = await runCli([
      "run",
      sourceGlob,
      "--no-verify",
      "--on-complete",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("ALPHA_LOCK_EXISTS=true"))).toBe(true);
    expect(result.logs.some((line) => line.includes("BETA_LOCK_EXISTS=true"))).toBe(true);
    expect(fs.existsSync(path.join(alphaDir, ".rundown", "roadmap.md.lock"))).toBe(false);
    expect(fs.existsSync(path.join(betaDir, ".rundown", "roadmap.md.lock"))).toBe(false);
  });

  it("run keeps verification sidecar mapping consistent while source lock is held", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(
      sourcePath,
      "- [x] already done\n- [ ] verify selected task mapping\n",
      "utf-8",
    );

    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const sidecarPath = `${sourcePath}.1.validation`.replace(/\\/g, "/");
    const hookScript = path.join(workspace, "hook-check-sidecar-lock.mjs");
    fs.writeFileSync(
      hookScript,
      [
        "import fs from \"node:fs\";",
        "const sourceFile = process.env.RUNDOWN_FILE ?? '';",
        "const taskIndex = process.env.RUNDOWN_INDEX ?? '';",
        "const derivedSidecar = `${sourceFile}.${taskIndex}.validation`;",
        `const expectedSidecar = ${JSON.stringify(sidecarPath)};`,
        `const lockPath = ${JSON.stringify(lockPath)};`,
        "console.log('LOCK_EXISTS=' + String(fs.existsSync(lockPath)));",
        "console.log('SIDECAR_MATCH=' + String(derivedSidecar.replace(/\\\\/g, '/') === expectedSidecar));",
        "console.log('SIDECAR_EXISTS=' + String(fs.existsSync(derivedSidecar)));",
        "if (fs.existsSync(derivedSidecar)) {",
        "  console.log('SIDECAR_CONTENT=' + fs.readFileSync(derivedSidecar, 'utf-8').trim());",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      sourceName,
      "--only-verify",
      "--no-repair",
      "--on-fail",
      `node ${hookScript.replace(/\\/g, "/")}`,
      "--",
      "node",
      "-e",
      "console.log('NOT_OK: verification mismatch')",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.logs.some((line) => line.includes("LOCK_EXISTS=true"))).toBe(true);
    expect(result.logs.some((line) => line.includes("SIDECAR_MATCH=true"))).toBe(true);
    expect(result.logs.some((line) => line.includes("SIDECAR_EXISTS=true"))).toBe(true);
    expect(result.logs.some((line) => line.includes("SIDECAR_CONTENT=verification mismatch"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, `${sourceName}.1.validation`), "utf-8")).toBe("verification mismatch");
  });

  (process.env.CI ? it.skip : it)("run releases source lock on Ctrl+C (SIGINT)", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    fs.writeFileSync(sourcePath, "- [ ] cli: echo hello\n", "utf-8");

    const lock = createLockfileFileLock();
    const runTaskMock = vi.fn(async () => {
      lock.acquire(sourcePath, { command: "run" });
      process.emit("SIGINT");
      return 0;
    });

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: runTaskMock,
        reverifyTask: vi.fn(async () => 0),
        revertTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        unlockTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
        releaseAllLocks: () => {
          lock.releaseAll();
        },
      }),
    }));

    const result = await runCli([
      "run",
      sourceName,
      "--no-verify",
    ], workspace);

    vi.doUnmock("../../src/create-app.js");

    expect(result.code).toBe(130);
    expect(runTaskMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("run fails fast when another run already holds the source lock", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(sourcePath, "- [ ] cli: echo hello\n", "utf-8");

    const firstRunLock = createLockfileFileLock();
    firstRunLock.acquire(sourcePath, { command: "run" });

    try {
      const startedAtMs = Date.now();
      const result = await runCli([
        "run",
        sourceName,
        "--no-verify",
      ], workspace);
      const durationMs = Date.now() - startedAtMs;

      expect(result.code).toBe(1);
      expect(result.errors.some((line) => line.includes("Source file is locked by another rundown process"))).toBe(true);
      expect(result.errors.some((line) => line.includes("--force-unlock"))).toBe(true);
      expect(result.errors.some((line) => line.includes("rundown unlock"))).toBe(true);
      expect(durationMs).toBeLessThan(1500);
    } finally {
      firstRunLock.releaseAll();
    }
  });

  it("revert is blocked when a run already holds the source lock", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(sourcePath, "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260328T000000000Z-committed",
      status: "completed",
      extra: {
        commitSha: "abc123",
        commitMessage: "rundown: complete \"Write docs\" in roadmap.md",
      },
    });

    const firstRunLock = createLockfileFileLock();
    firstRunLock.acquire(sourcePath, { command: "run" });

    try {
      const startedAtMs = Date.now();
      const result = await runCli([
        "revert",
        "--dry-run",
      ], workspace);
      const durationMs = Date.now() - startedAtMs;

      expect(result.code).toBe(1);
      expect(result.errors.some((line) => line.includes("Source file is locked by another rundown process"))).toBe(true);
      expect(result.errors.some((line) => line.includes("command=run"))).toBe(true);
      expect(result.errors.some((line) => line.includes("rundown unlock"))).toBe(true);
      expect(durationMs).toBeLessThan(1500);
    } finally {
      firstRunLock.releaseAll();
    }
  });

  it("run --force-unlock breaks a stale lock and proceeds", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    fs.writeFileSync(sourcePath, "- [ ] cli: echo hello\n", "utf-8");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 999999,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: sourcePath,
    }), "utf-8");

    const result = await runCli([
      "run",
      sourceName,
      "--no-verify",
      "--force-unlock",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Force-unlocked stale source lock"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo hello"))).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toContain("- [x] cli: echo hello");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("run keeps exit code 0 when --commit is set outside a git repository", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo hello"))).toBe(true);
    expect(result.logs.some((line) => line.includes("--commit: not inside a git repository, skipping."))).toBe(true);
  });

  it("run keeps exit code 0 when --on-complete exits non-zero", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--on-complete",
      "node -e \"process.exit(17)\"",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo hello"))).toBe(true);
    expect(result.logs.some((line) => line.includes("--on-complete hook exited with code 17"))).toBe(true);
  });

  it("run keeps --on-complete hook output visible with --hide-agent-output", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");

    const hookScript = path.join(workspace, "hook-visible.mjs");
    fs.writeFileSync(
      hookScript,
      "console.log('HOOK_STDOUT'); console.error('HOOK_STDERR');\n",
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--hide-agent-output",
      "--on-complete",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("HOOK_STDOUT"))).toBe(true);
    expect(result.stderrWrites.some((line) => line.includes("HOOK_STDERR"))).toBe(true);
  });

  it("run supports --commit on its own with the default commit message", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Committed: rundown: complete \"cli: echo hello\" in roadmap.md"))).toBe(true);

    const commitSubject = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(commitSubject).toBe("rundown: complete \"cli: echo hello\" in roadmap.md");
  });

  it("run --commit does not stage or commit source .lock files", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(true);

    const committedFiles = execFileSync("git", ["show", "--name-only", "--pretty=format:", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(committedFiles).toContain("roadmap.md");
    expect(committedFiles.some((filePath) => filePath.endsWith(".lock"))).toBe(false);

    const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: workspace,
      encoding: "utf-8",
    });
    const statusLines = status
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(statusLines.some((line) => line.endsWith(".lock"))).toBe(false);
  });

  it("run --commit exits with 1 when the worktree is dirty", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const otherFilePath = path.join(workspace, "src", "notes.txt");
    fs.mkdirSync(path.dirname(otherFilePath), { recursive: true });
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");
    fs.writeFileSync(otherFilePath, "before\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    // Simulate task side effects outside the Markdown file.
    fs.writeFileSync(otherFilePath, "after\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("--commit: working directory is not clean. Commit or stash changes before using --commit."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);

    const roadmap = fs.readFileSync(roadmapPath, "utf-8");
    expect(roadmap).toContain("- [ ] cli: echo hello");
  });

  it("run parses --commit-message without requiring --commit", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo hello\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit-message",
      "done: {{task}}",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo hello"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);
  });

  it("run returns 1 on execution failure and skips completion side effects", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: __rundown_missing_command__\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--on-complete",
      "node -e \"console.log('hook-ran')\"",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Inline CLI exited with code"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);
    expect(result.logs.some((line) => line.includes("hook-ran"))).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: __rundown_missing_command__");
  });

  it("run returns 2 on verification failure and skips completion side effects", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");

    const spawnMock = createWaitModeSpawnMock({
      exitCode: 0,
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--worker",
      "opencode",
      "run",
      "--commit",
      "--on-complete",
      "node -e \"console.log('hook-ran')\"",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Verification failed"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);
    expect(result.logs.some((line) => line.includes("hook-ran"))).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: echo hello");
  });

  it("run forwards --commit-message template when used with --commit", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--commit-message",
      "done: {{task}} ({{file}})",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Committed: done: cli: echo hello (roadmap.md)"))).toBe(true);

    const commitSubject = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(commitSubject).toBe("done: cli: echo hello (roadmap.md)");
  });

  it("run parses combined --commit, --commit-message, and --on-complete options", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    const hookScript = path.join(workspace, "hook.mjs");
    fs.writeFileSync(
      hookScript,
      "console.log([process.env.RUNDOWN_TASK, process.env.RUNDOWN_SOURCE].join('|'));\n",
      "utf-8",
    );

    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--commit-message",
      "combined: {{task}} @ {{file}}",
      "--on-complete",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Committed: combined: cli: echo hello @ roadmap.md"))).toBe(true);
    expect(result.logs.some((line) => line.includes("cli: echo hello|roadmap.md"))).toBe(true);

    const commitSubject = execFileSync("git", ["log", "-1", "--pretty=%s"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(commitSubject).toBe("combined: cli: echo hello @ roadmap.md");
  });

  it("run --all completes multiple inline CLI tasks sequentially", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo one\n- [ ] cli: echo two\n- [ ] cli: echo three\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--all",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(3);
    expect(result.logs.some((line) => line.includes("All tasks completed (3 total)"))).toBe(true);
    const content = fs.readFileSync(roadmapPath, "utf-8");
    expect(content).toBe("- [x] cli: echo one\n- [x] cli: echo two\n- [x] cli: echo three\n");
  });

  it("run --all stops on failure and preserves failure exit code", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo ok\n- [ ] cli: exit 1\n- [ ] cli: echo unreachable\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--all",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(1);
    const content = fs.readFileSync(roadmapPath, "utf-8");
    expect(content).toContain("- [x] cli: echo ok\n");
    expect(content).toContain("- [ ] cli: exit 1\n");
    expect(content).toContain("- [ ] cli: echo unreachable\n");
  });

  it("run --all returns 0 when there are no tasks to run", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] cli: echo done\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--all",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.logs.some((line) => line.includes("No unchecked tasks found"))).toBe(true);
  });

  it("run --on-fail executes hook on inline CLI failure", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: exit 1\n", "utf-8");

    const hookScript = path.join(workspace, "fail-hook.mjs");
    fs.writeFileSync(
      hookScript,
      "console.log('FAIL_HOOK:' + process.env.RUNDOWN_TASK);\n",
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--on-fail",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.logs.some((line) => line.includes("FAIL_HOOK:cli: exit 1"))).toBe(true);
  });

  it("run keeps --on-fail hook output visible with --hide-agent-output", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: exit 1\n", "utf-8");

    const hookScript = path.join(workspace, "fail-hook-visible.mjs");
    fs.writeFileSync(
      hookScript,
      "console.log('FAIL_HOOK_STDOUT'); console.error('FAIL_HOOK_STDERR');\n",
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--hide-agent-output",
      "--on-fail",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.logs.some((line) => line.includes("FAIL_HOOK_STDOUT"))).toBe(true);
    expect(result.stderrWrites.some((line) => line.includes("FAIL_HOOK_STDERR"))).toBe(true);
  });

  it("run --on-fail is not invoked on success", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo hello\n", "utf-8");

    const markerPath = path.join(workspace, "fail-marker.txt");
    const hookScript = path.join(workspace, "fail-hook.mjs");
    fs.writeFileSync(
      hookScript,
      `import fs from "fs"; fs.writeFileSync(${JSON.stringify(markerPath.replace(/\\/g, "/"))}, "ran");\n`,
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--on-fail",
      `node ${hookScript.replace(/\\/g, "/")}`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("run --help shows --all and --on-fail options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["run", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--all");
    expect(compactHelpOutput).toContain("--on-fail <command>");
    expect(compactHelpOutput).toContain("--force-unlock");
  });

  it("plan --help shows --force-unlock option", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["plan", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--force-unlock");
  });

  it("unlock --help shows source argument", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["unlock", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("unlock [options] <source>");
    expect(compactHelpOutput).toContain("Manually release a stale source lockfile");
  });

  it("unlock removes stale lockfile and exits 0", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const lockPath = path.join(workspace, ".rundown", "roadmap.md.lock");
    fs.writeFileSync(sourcePath, "- [ ] Write docs\n", "utf-8");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: 424242,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: sourcePath,
    }), "utf-8");

    const result = await runCli(["unlock", "roadmap.md"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Released stale source lock"))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("unlock refuses to remove lock held by active process", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const lockPath = path.join(workspace, ".rundown", "roadmap.md.lock");
    fs.writeFileSync(sourcePath, "- [ ] Write docs\n", "utf-8");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: sourcePath,
    }), "utf-8");

    const result = await runCli(["unlock", "roadmap.md"], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("currently held"))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
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

  it("plan rejects missing markdown file path with actionable guidance", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "plan",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("requires exactly one Markdown file path"))).toBe(true);
    expect(result.errors.some((line) => line.includes("rundown plan <markdown-file>"))).toBe(true);
  });

  it("plan rejects multiple markdown file paths", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "plan",
      "one.md",
      "two.md",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("accepts exactly one Markdown file path"))).toBe(true);
    expect(result.errors.some((line) => line.includes("one.md, two.md"))).toBe(true);
  });

  it("plan rejects non-markdown file paths", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.txt"), "plan text\n", "utf-8");

    const result = await runCli([
      "plan",
      "roadmap.txt",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Invalid plan document path: roadmap.txt"))).toBe(true);
    expect(result.errors.some((line) => line.includes(".md or .markdown"))).toBe(true);
  });

  it("plan accepts .markdown file paths", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.markdown"), "- [ ] Break down migration\n", "utf-8");

    const result = await runCli([
      "plan",
      "roadmap.markdown",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Planning document:") && line.includes("roadmap.markdown"))).toBe(true);
  });

  it("plan rejects legacy --at with migration guidance", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Break down migration\n", "utf-8");

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--at",
      "roadmap.md:1",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("--at option is no longer supported for `plan`"))).toBe(true);
    expect(result.errors.some((line) => line.includes("Remove --at"))).toBe(true);
  });

  it("plan rejects legacy --sort with migration guidance", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Break down migration\n", "utf-8");

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--sort",
      "none",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("--sort option is no longer supported for `plan`"))).toBe(true);
    expect(result.errors.some((line) => line.includes("Remove --sort"))).toBe(true);
  });

  it("plan dry-run preserves planning output semantics", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Break down migration\n", "utf-8");

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(
      result.logs.some((line) => line.includes("Planning document:") && line.includes("roadmap.md")),
    ).toBe(true);
    expect(result.logs.some((line) => line.includes("Dry run — would plan: opencode run"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Prompt length:"))).toBe(true);
  });

  it("plan converges for a document with no existing TODO items", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-no-todos.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-no-todos");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Summary\nShip the release workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (prompt.includes('- [ ] Add release checklist')) {",
        "  process.exit(0);",
        "}",
        "console.log('- [ ] Add release checklist');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "3",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("No existing TODO items detected in document"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-01-of-03"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-02-of-03"))).toBe(true);
    expect(result.logs.some((line) => line.includes("converged at scan 2"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Add release checklist");
  });

  it("plan converges for a document with partial TODO coverage", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-partial-todos.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-partial");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Next Steps\n- [ ] Existing task\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "void promptPath;",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "console.log('- [ ] Existing task');",
        "console.log('- [ ] Add CI checks');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "4",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Detected 1 existing TODO item"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-01-of-04"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-02-of-04"))).toBe(true);
    expect(result.logs.some((line) => line.includes("converged at scan 2"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Existing task");
    expect(updated).toContain("- [ ] Add CI checks");
    expect(updated.indexOf("- [ ] Existing task")).toBe(updated.lastIndexOf("- [ ] Existing task"));
    expect(updated.indexOf("- [ ] Add CI checks")).toBe(updated.lastIndexOf("- [ ] Add CI checks"));
  });

  it("plan uses markdown updated by earlier scans in later scan prompts", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-updated-state.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-updated-state");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (current === 2 && !prompt.includes('- [ ] Create API schema')) {",
        "  console.error('scan 2 did not receive markdown updates from scan 1');",
        "  process.exit(22);",
        "}",
        "if (current === 3 && !prompt.includes('- [ ] Implement API handler')) {",
        "  console.error('scan 3 did not receive markdown updates from scan 2');",
        "  process.exit(23);",
        "}",
        "if (current === 1) {",
        "  console.log('- [ ] Create API schema');",
        "  process.exit(0);",
        "}",
        "if (current === 2) {",
        "  console.log('- [ ] Implement API handler');",
        "  process.exit(0);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "4",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-01-of-04"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-02-of-04"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-03-of-04"))).toBe(true);
    expect(result.logs.some((line) => line.includes("converged at scan 3"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Inserted 2 TODO items"))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("3");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Create API schema");
    expect(updated).toContain("- [ ] Implement API handler");
    expect(updated.indexOf("- [ ] Create API schema")).toBeLessThan(updated.indexOf("- [ ] Implement API handler"));
  });

  it("plan preserves artifacts and reports clear error for invalid worker output format", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-invalid-format.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\n- [ ] Existing task\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "void fs.readFileSync(promptPath, 'utf-8');",
        "console.log('Here are missing tasks:');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("stdout contract"))).toBe(true);
    expect(result.errors.some((line) => line.includes("`- [ ]` syntax"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Runtime artifacts saved at"))).toBe(true);

    const savedRuns = readSavedRunMetadata(workspace);
    expect(savedRuns.some((run) => run.commandName === "plan" && run.status === "failed")).toBe(true);

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toBe("# Roadmap\n\n## Scope\n- [ ] Existing task\n");
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

    const runsDir = path.join(workspace, ".rundown", "runs");
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
    expect(fs.readdirSync(path.join(workspace, ".rundown", "runs")).length).toBe(0);
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
    expect(args[0]).toBe(path.join(workspace, ".rundown", "runs", "run-20260317T000000000Z-open"));
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
    expect(args[0]).toBe(path.join(workspace, ".rundown", "runs", "run-20260317T000100000Z-new"));
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
    expect(fs.existsSync(path.join(workspace, ".rundown", "runs", "run-20260317T000000000Z-keep"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "runs", "run-20260317T000100000Z-drop"))).toBe(false);
  });

  it("list exits with 0 when source has no tasks", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\nNo tasks here.\n", "utf-8");

    const result = await runCli(["list", "notes.md"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("No tasks found"))).toBe(true);
  });

  it("list remains read-only and ignores existing source lockfiles", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "notes.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    fs.writeFileSync(sourcePath, "- [ ] Parent\n", "utf-8");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: sourcePath,
    }), "utf-8");

    const result = await runCli(["list", sourceName], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Parent"))).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("list keeps blocked-task label semantics", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "notes.md"), "- [ ] Parent\n  - [ ] Child\n", "utf-8");

    const result = await runCli(["list", "notes.md"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Parent") && line.includes("blocked"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Child"))).toBe(true);
  });

  it("init creates .rundown defaults and exits with 0", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["init"], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, ".rundown", "execute.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "verify.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "repair.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "plan.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "trace.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "vars.json"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Initialized .rundown/ with default templates."))).toBe(true);
  });

  it("init keeps existing files and warns when defaults already exist", async () => {
    const workspace = makeTempWorkspace();

    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "execute.md"), "custom execute", "utf-8");

    const result = await runCli(["init"], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(workspace, ".rundown", "execute.md"), "utf-8")).toBe("custom execute");
    expect(result.logs.some((line) => line.includes(".rundown/execute.md already exists, skipping."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Initialized .rundown/ with default templates."))).toBe(true);
  });
});

function writeSavedRun(
  workspace: string,
  options: {
    runId: string;
    status: ArtifactStoreStatus;
    startedAt?: string;
    taskText?: string;
    workerCommand?: string[];
    extra?: Record<string, unknown>;
  },
): void {
  const runDir = path.join(workspace, ".rundown", "runs", options.runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "run.json"), JSON.stringify({
    runId: options.runId,
    commandName: "run",
    workerCommand: options.workerCommand ?? ["opencode", "run"],
    mode: "wait",
    transport: "file",
    source: "roadmap.md",
    task: {
      text: options.taskText ?? "Write docs",
      file: "roadmap.md",
      line: 1,
      index: 0,
      source: "roadmap.md",
    },
    keepArtifacts: true,
    startedAt: options.startedAt ?? "2026-03-17T00:00:00.000Z",
    completedAt: "2026-03-17T00:01:00.000Z",
    status: options.status,
    extra: options.extra,
  }, null, 2), "utf-8");
}

function readSavedRunMetadata(workspace: string): Array<{
  runId: string;
  commandName?: string;
  status?: string;
  extra?: Record<string, unknown>;
}> {
  const runsDir = path.join(workspace, ".rundown", "runs");
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name, "run.json"))
    .filter((filePath) => fs.existsSync(filePath));

  return runDirs.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    runId: string;
    commandName?: string;
    status?: string;
    extra?: Record<string, unknown>;
  });
}

function findSavedRunByCommand(
  workspace: string,
  commandName: string,
): {
  runId: string;
  commandName?: string;
  status?: string;
  extra?: Record<string, unknown>;
} | null {
  const runs = readSavedRunMetadata(workspace)
    .filter((run) => run.commandName === commandName)
    .sort((a, b) => b.runId.localeCompare(a.runId));
  return runs[0] ?? null;
}

function listTraceFiles(workspace: string): string[] {
  const runsDir = path.join(workspace, ".rundown", "runs");
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  return fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name, "trace.jsonl"))
    .filter((filePath) => fs.existsSync(filePath));
}

function readGlobalOutputLogEntries(workspace: string): Array<{
  command: string;
  kind: string;
  stream: string;
  message: string;
}> {
  const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
  if (!fs.existsSync(outputLogPath)) {
    return [];
  }

  return fs.readFileSync(outputLogPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as {
      command?: unknown;
      kind?: unknown;
      stream?: unknown;
      message?: unknown;
    })
    .map((entry) => ({
      command: typeof entry.command === "string" ? entry.command : "",
      kind: typeof entry.kind === "string" ? entry.kind : "",
      stream: typeof entry.stream === "string" ? entry.stream : "",
      message: typeof entry.message === "string" ? entry.message : "",
    }));
}

function createWaitModeSpawnMock(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}) {
  return vi.fn().mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      unref: () => void;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = vi.fn();

    process.nextTick(() => {
      if (options.stdout) {
        child.stdout.emit("data", Buffer.from(options.stdout));
      }
      if (options.stderr) {
        child.stderr.emit("data", Buffer.from(options.stderr));
      }
      child.emit("close", options.exitCode ?? 0);
    });

    return child;
  });
}
