import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStoreStatus } from "../../src/domain/ports/index.js";

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

  it("run --commit includes other worktree changes in the same commit", async () => {
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

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(true);

    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(status).toBe("");

    const changedFiles = execFileSync("git", ["show", "--name-only", "--pretty=", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(changedFiles).toContain("roadmap.md");
    expect(changedFiles).toContain("src/notes.txt");
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
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

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
      result.logs.some((line) => line.includes("Planning task:") && line.includes("Break down migration")),
    ).toBe(true);
    expect(result.logs.some((line) => line.includes("Dry run — would plan: opencode run"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Prompt length:"))).toBe(true);
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
  }, null, 2), "utf-8");
}

function readSavedRunMetadata(workspace: string): Array<{ commandName?: string; status?: string }> {
  const runsDir = path.join(workspace, ".rundown", "runs");
  if (!fs.existsSync(runsDir)) {
    return [];
  }

  const runDirs = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name, "run.json"))
    .filter((filePath) => fs.existsSync(filePath));

  return runDirs.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
    commandName?: string;
    status?: string;
  });
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
