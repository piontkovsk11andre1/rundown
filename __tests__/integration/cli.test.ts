import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactStoreStatus } from "../../src/domain/ports/index.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
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

const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

const GLOBAL_OUTPUT_LOG_EXPECTED_KEYS = [
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

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function normalizeLegacyWorkerPatternArgs(args: string[]): string[] {
  const normalized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    normalized.push(arg);

    if (arg !== "--worker") {
      continue;
    }

    const firstToken = args[index + 1];
    if (!firstToken) {
      continue;
    }

    const workerTokens: string[] = [firstToken];
    let lookaheadIndex = index + 2;
    while (lookaheadIndex < args.length) {
      const nextToken = args[lookaheadIndex];
      if (!nextToken || nextToken.startsWith("-")) {
        break;
      }
      workerTokens.push(nextToken);
      lookaheadIndex += 1;
    }

    if (workerTokens.length > 1) {
      normalized[normalized.length - 1] = "--worker";
      normalized.push(workerTokens.join(" "));
      index = lookaheadIndex - 1;
    }
  }

  return normalized;
}

async function runCli(args: string[], cwd: string): Promise<{
  code: number;
  logs: string[];
  errors: string[];
  stdoutWrites: string[];
  stderrWrites: string[];
}> {
  const normalizedArgs = normalizeLegacyWorkerPatternArgs(args);
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
    if (previousEnv === undefined) {
      delete process.env.RUNDOWN_DISABLE_AUTO_PARSE;
    } else {
      process.env.RUNDOWN_DISABLE_AUTO_PARSE = previousEnv;
    }
    await parseCliArgs(normalizedArgs);
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

async function withTerminalTty<T>(isTTY: boolean, callback: () => Promise<T>): Promise<T> {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    get: () => isTTY,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    get: () => isTTY,
  });

  try {
    return await callback();
  } finally {
    if (stdoutDescriptor) {
      Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
    } else {
      Reflect.deleteProperty(process.stdout, "isTTY");
    }

    if (stderrDescriptor) {
      Object.defineProperty(process.stderr, "isTTY", stderrDescriptor);
    } else {
      Reflect.deleteProperty(process.stderr, "isTTY");
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
    expect(result.errors.some((line) => line.includes("No Markdown files found matching: missing/**/*.md"))).toBe(true);
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
      "--verbose",
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

  it("run expands --worker 'claude -p $bootstrap' with bootstrap text", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(sourcePath, "- [ ] Write docs\n", "utf-8");

    const spawnMock = createWaitModeSpawnMock({ exitCode: 0 });
    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
      "--worker",
      "claude -p $bootstrap",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("claude");
    expect(args[0]).toBe("-p");
    const bootstrapText = args[1] ?? "";
    const bootstrapPrefix = "Read the task prompt file at ";
    const bootstrapSuffix = " and follow the instructions.";
    expect(bootstrapText.startsWith(bootstrapPrefix)).toBe(true);
    expect(bootstrapText.endsWith(bootstrapSuffix)).toBe(true);
    const relativePromptPath = bootstrapText.slice(
      bootstrapPrefix.length,
      bootstrapText.length - bootstrapSuffix.length,
    );
    const promptPath = path.join(workspace, ...relativePromptPath.split("/"));
    expect(fs.existsSync(promptPath)).toBe(true);
    expect(fs.readFileSync(promptPath, "utf-8")).toContain("Write docs");
  });

  it("run expands --worker 'opencode run --file $file' with prompt file path", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const spawnMock = createWaitModeSpawnMock({ exitCode: 0 });
    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
      "--worker",
      "opencode run --file $file",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args[0]).toBe("run");
    expect(args[1]).toBe("--file");
    const promptPath = args[2] ?? "";
    expect(fs.existsSync(promptPath)).toBe(true);
    expect(fs.readFileSync(promptPath, "utf-8")).toContain("Write docs");
    expect(args).toHaveLength(3);
  });

  it("run appends $file implicitly for --worker 'my-agent'", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const spawnMock = createWaitModeSpawnMock({ exitCode: 0 });
    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
      "--worker",
      "my-agent",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("my-agent");
    expect(args).toHaveLength(1);
    const promptPath = args[0] ?? "";
    expect(fs.existsSync(promptPath)).toBe(true);
    expect(fs.readFileSync(promptPath, "utf-8")).toContain("Write docs");
  });

  it("run uses worker from .rundown/config.json when no CLI worker override is provided", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), JSON.stringify({
      workers: {
        default: ["opencode", "run"],
      },
    }, null, 2), "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Dry run — would run: opencode run"))).toBe(true);
  });

  it("run keeps agent output hidden by default when worker comes from config defaults", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "run-worker-config-default-hidden-output.cjs");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });

    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "console.log('run diagnostic hidden via config defaults');",
        "console.error('run diagnostic hidden via config defaults stderr');",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", workerScriptPath.replace(/\\/g, "/")],
        },
      }, null, 2),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("run diagnostic hidden via config defaults"))).toBe(false);
    expect(result.stderrWrites.some((line) => line.includes("run diagnostic hidden via config defaults stderr"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Task checked: Write docs"))).toBe(true);
  });

  it("run rejects unknown show-agent-output variants", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--show-agent-outputs",
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
    expect(combinedOutput.includes("--show-agent-outputs")).toBe(true);
    expect(combinedOutput.includes("unknown option")).toBe(true);
  });

  it("make rejects non-wait modes that break sequential chaining", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "make",
      "please do something",
      "8. Do something.md",
      "--mode",
      "tui",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("invalid --mode value: tui")).toBe(true);
    expect(combinedOutput.includes("allowed: wait")).toBe(true);
  });

  it("make does not overwrite an existing markdown target", async () => {
    const workspace = makeTempWorkspace();
    const markdownFile = path.join(workspace, "8. Do something.md");
    fs.writeFileSync(markdownFile, "existing content\n", "utf-8");

    const result = await runCli([
      "make",
      "please do something",
      "8. Do something.md",
    ], workspace);

    expect(result.code).toBe(1);
    expect(fs.readFileSync(markdownFile, "utf-8")).toBe("existing content\n");
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("file already exists")).toBe(true);
  });

  it("make returns 1 when no worker command can be resolved", async () => {
    const workspace = makeTempWorkspace();
    const markdownFile = path.join(workspace, "8. Do something.md");

    const result = await runCli([
      "make",
      "please do something",
      "8. Do something.md",
    ], workspace);

    expect(result.code).toBe(1);
    expect(fs.readFileSync(markdownFile, "utf-8")).toBe("please do something");
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("no worker command available")).toBe(true);
  });

  it("make returns 1 when worker config is invalid", async () => {
    const workspace = makeTempWorkspace();
    const markdownFile = path.join(workspace, "8. Do something.md");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), JSON.stringify({
      workers: {
        default: "opencode",
      },
    }, null, 2), "utf-8");

    const result = await runCli([
      "make",
      "please do something",
      "8. Do something.md",
    ], workspace);

    expect(result.code).toBe(1);
    expect(fs.readFileSync(markdownFile, "utf-8")).toBe("please do something");
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("invalid worker config")).toBe(true);
  });

  it("make preserves bootstrap file and skips plan when research fails", async () => {
    const workspace = makeTempWorkspace();
    const markdownFile = path.join(workspace, "8. Do something.md");
    const invocationLogPath = path.join(workspace, "worker-invocations.log");
    const workerScriptPath = path.join(workspace, "failing-worker.cjs");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        `const invocationLogPath = ${JSON.stringify(invocationLogPath.replace(/\\/g, "/"))};`,
        "fs.appendFileSync(invocationLogPath, 'called\\n', 'utf-8');",
        "process.exit(2);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "make",
      "please do something",
      "8. Do something.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).not.toBe(0);
    expect(fs.readFileSync(markdownFile, "utf-8")).toBe("please do something");
    expect(fs.readFileSync(invocationLogPath, "utf-8")).toBe("called\n");
  });

  it("make hands off source lock cleanly from research to plan", async () => {
    const workspace = makeTempWorkspace();
    const markdownFile = path.join(workspace, "8. Do something.md");
    const sourceName = "8. Do something.md";
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const lockProbePath = path.join(workspace, "make-lock-handoff-probe.jsonl");
    const workerScriptPath = path.join(workspace, "make-lock-handoff-worker.cjs");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const lockPath = ${JSON.stringify(lockPath)};`,
        `const lockProbePath = ${JSON.stringify(lockProbePath.replace(/\\/g, "/"))};`,
        "const lockExists = fs.existsSync(lockPath);",
        "let lockCommand = 'missing';",
        "if (lockExists) {",
        "  try {",
        "    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));",
        "    lockCommand = typeof payload.command === 'string' ? payload.command : 'unknown';",
        "  } catch {",
        "    lockCommand = 'unreadable';",
        "  }",
        "}",
        "fs.appendFileSync(lockProbePath, JSON.stringify({ lockExists, lockCommand }) + '\\n', 'utf-8');",
        "if (lockCommand === 'research') {",
        "  console.log('# Roadmap\\n\\nSeed from make\\n\\n## Research Context\\n- lock observed during research phase');",
        "  process.exit(0);",
        "}",
        "if (lockCommand === 'plan') {",
        "  console.log('- [ ] Verify lock handoff sequencing');",
        "  process.exit(0);",
        "}",
        "console.error('Unexpected lock command: ' + lockCommand);",
        "process.exit(91);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "make",
      "Seed from make",
      "8. Do something.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    const probeEntries = fs.readFileSync(lockProbePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { lockExists: boolean; lockCommand: string });
    expect(probeEntries.length).toBeGreaterThanOrEqual(2);
    expect(probeEntries[0]).toEqual({ lockExists: true, lockCommand: "research" });
    expect(probeEntries.slice(1).every((entry) => entry.lockExists && entry.lockCommand === "plan")).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
  });

  it("explore on a valid markdown file runs research then plan sequentially", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const phaseProbePath = path.join(workspace, "explore-phase-probe.jsonl");
    const workerScriptPath = path.join(workspace, "explore-sequence-worker.cjs");

    fs.writeFileSync(sourcePath, "# Roadmap\n\nSeed from explore\n\n- [ ] Existing parent task\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const sourcePath = ${JSON.stringify(sourcePath.replace(/\\/g, "/"))};`,
        `const lockPath = ${JSON.stringify(lockPath)};`,
        `const phaseProbePath = ${JSON.stringify(phaseProbePath.replace(/\\/g, "/"))};`,
        "const lockExists = fs.existsSync(lockPath);",
        "let lockCommand = 'missing';",
        "if (lockExists) {",
        "  try {",
        "    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));",
        "    lockCommand = typeof payload.command === 'string' ? payload.command : 'unknown';",
        "  } catch {",
        "    lockCommand = 'unreadable';",
        "  }",
        "}",
        "fs.appendFileSync(phaseProbePath, JSON.stringify({ lockExists, lockCommand }) + '\\n', 'utf-8');",
        "if (lockCommand === 'research') {",
        "  console.log('# Roadmap\\n\\nSeed from explore\\n\\n- [ ] Existing parent task\\n\\n## Research Context\\n- Captured integration context');",
        "  process.exit(0);",
        "}",
        "if (lockCommand === 'plan') {",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (!source.includes('- [ ] Add rollout checklist')) {",
        "    fs.writeFileSync(sourcePath, source.trimEnd() + '\\n\\n- [ ] Add rollout checklist\\n', 'utf-8');",
        "  }",
        "  process.exit(0);",
        "}",
        "console.error('Unexpected lock command: ' + lockCommand);",
        "process.exit(92);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "explore",
      sourceName,
      "--scan-count",
      "1",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    const probeEntries = fs.readFileSync(phaseProbePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { lockExists: boolean; lockCommand: string });
    expect(probeEntries).toEqual([
      { lockExists: true, lockCommand: "research" },
      { lockExists: true, lockCommand: "plan" },
    ]);
    const updated = fs.readFileSync(sourcePath, "utf-8");
    expect(updated).toContain("## Research Context");
    expect(updated).toContain("- [ ] Add rollout checklist");
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
  });

  it("explore fails fast when research fails and does not run plan", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const phaseProbePath = path.join(workspace, "explore-fail-fast-probe.jsonl");
    const workerScriptPath = path.join(workspace, "explore-fail-fast-worker.cjs");

    fs.writeFileSync(sourcePath, "# Roadmap\n\nSeed from explore\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const lockPath = ${JSON.stringify(lockPath)};`,
        `const phaseProbePath = ${JSON.stringify(phaseProbePath.replace(/\\/g, "/"))};`,
        "const lockExists = fs.existsSync(lockPath);",
        "let lockCommand = 'missing';",
        "if (lockExists) {",
        "  try {",
        "    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));",
        "    lockCommand = typeof payload.command === 'string' ? payload.command : 'unknown';",
        "  } catch {",
        "    lockCommand = 'unreadable';",
        "  }",
        "}",
        "fs.appendFileSync(phaseProbePath, JSON.stringify({ lockExists, lockCommand }) + '\\n', 'utf-8');",
        "if (lockCommand === 'research') {",
        "  process.exit(7);",
        "}",
        "process.exit(93);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "explore",
      sourceName,
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).not.toBe(0);
    const probeEntries = fs.readFileSync(phaseProbePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { lockExists: boolean; lockCommand: string });
    expect(probeEntries).toEqual([
      { lockExists: true, lockCommand: "research" },
    ]);
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
  });

  it("query runs research, plan, and run end-to-end against --dir", async () => {
    const workspace = makeTempWorkspace();
    const analysisDir = path.join(workspace, "analysis");
    const workerScriptPath = path.join(workspace, "query-e2e-worker.cjs");
    const phaseProbePath = path.join(analysisDir, "query-e2e-probe.jsonl");

    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, "service.ts"), "export const authEnabled = true;\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const sourceMatch = prompt.match(/## Source file\\s+`([^`]+)`/m);",
        "const sourcePath = sourceMatch ? sourceMatch[1] : '';",
        `const phaseProbePath = ${JSON.stringify(phaseProbePath.replace(/\\/g, "/"))};`,
        "const record = (phase, extra = {}) => {",
        "  fs.appendFileSync(phaseProbePath, JSON.stringify({ phase, cwd: process.cwd(), ...extra }) + '\\n', 'utf-8');",
        "};",
        "if (prompt.includes('Research and enrich the source document with implementation context.')) {",
        "  record('research');",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (source.includes('## Research Context')) {",
        "    console.log(source);",
        "  } else {",
        "    console.log(source.trimEnd() + '\\n\\n## Research Context\\n\\n- Located authentication entry points\\n');",
        "  }",
        "  process.exit(0);",
        "}",
        "if (prompt.includes('Edit the source Markdown file directly to improve plan coverage.')) {",
        "  record('plan');",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  let updated = source;",
        "  if (!updated.includes('- [ ] Trace request entry points')) {",
        "    updated = updated.trimEnd() + '\\n\\n- [ ] Trace request entry points\\n';",
        "  }",
        "  if (!updated.includes('- [ ] Summarize authentication flow')) {",
        "    updated = updated.trimEnd() + '\\n- [ ] Summarize authentication flow\\n';",
        "  }",
        "  fs.writeFileSync(sourcePath, updated.endsWith('\\n') ? updated : `${updated}\\n`, 'utf-8');",
        "  process.exit(0);",
        "}",
        "if (prompt.includes('You are executing one step of a query investigation plan.')) {",
        "  const taskMatch = prompt.match(/- Task: (.+)/);",
        "  const task = taskMatch ? taskMatch[1].trim() : 'unknown';",
        "  record('run', { task });",
        "  console.log(`# ${task}\\n\\n- Evidence gathered from ${process.cwd()}\\n`);",
        "  process.exit(0);",
        "}",
        "record('unknown');",
        "process.exit(95);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "query",
      "map authentication flow",
      "--dir",
      analysisDir,
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Query phase 1/3: research"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Query phase 2/3: plan"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Query phase 3/3: execute (stream mode)"))).toBe(true);
    const firstStepLogIndex = result.logs.findIndex((line) => stripAnsi(line).includes("# Trace request entry points"));
    const secondStepLogIndex = result.logs.findIndex((line) => stripAnsi(line).includes("# Summarize authentication flow"));
    expect(firstStepLogIndex).toBeGreaterThanOrEqual(0);
    expect(secondStepLogIndex).toBeGreaterThan(firstStepLogIndex);

    const probeEntries = fs.readFileSync(phaseProbePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; cwd: string; task?: string });
    const phaseSequence = probeEntries.map((entry) => entry.phase);
    expect(phaseSequence[0]).toBe("research");
    expect(phaseSequence[1]).toBe("plan");
    expect(phaseSequence.filter((phase) => phase === "run")).toHaveLength(2);
    expect(probeEntries.every((entry) => path.resolve(entry.cwd) === path.resolve(analysisDir))).toBe(true);
    expect(probeEntries.filter((entry) => entry.phase === "run").map((entry) => entry.task)).toEqual([
      "Trace request entry points",
      "Summarize authentication flow",
    ]);
  });

  it("query resolves question tasks before heavy investigation steps and persists answers", async () => {
    const workspace = makeTempWorkspace();
    const analysisDir = path.join(workspace, "analysis-question");
    const workerScriptPath = path.join(workspace, "query-question-worker.cjs");
    const phaseProbePath = path.join(analysisDir, "query-question-probe.jsonl");

    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, "service.ts"), "export const authEnabled = true;\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const resolveSourcePath = () => {",
        "  const sourceMatch = prompt.match(/## Source file\\s+`([^`]+)`/m);",
        "  if (sourceMatch && sourceMatch[1]) {",
        "    return sourceMatch[1];",
        "  }",
        "  const runsRoot = path.join(process.cwd(), '.rundown', 'runs');",
        "  if (!fs.existsSync(runsRoot)) {",
        "    return '';",
        "  }",
        "  const runIds = fs.readdirSync(runsRoot).sort();",
        "  for (let index = runIds.length - 1; index >= 0; index -= 1) {",
        "    const candidate = path.join(runsRoot, runIds[index], 'query.md');",
        "    if (fs.existsSync(candidate)) {",
        "      return candidate;",
        "    }",
        "  }",
        "  return '';",
        "};",
        "const sourcePath = resolveSourcePath();",
        `const phaseProbePath = ${JSON.stringify(phaseProbePath.replace(/\\/g, "/"))};`,
        "const record = (phase, extra = {}) => {",
        "  fs.appendFileSync(phaseProbePath, JSON.stringify({ phase, ...extra }) + '\\n', 'utf-8');",
        "};",
        "if (prompt.includes('Research and enrich the source document with implementation context.')) {",
        "  record('research');",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (source.includes('## Research Context')) {",
        "    console.log(source);",
        "  } else {",
        "    console.log(source.trimEnd() + '\\n\\n## Research Context\\n\\n- Located auth module\\n');",
        "  }",
        "  process.exit(0);",
        "}",
        "if (prompt.includes('Edit the source Markdown file directly to improve plan coverage.')) {",
        "  record('plan');",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  let updated = source;",
        "  if (!updated.includes('- [ ] question: Which bounded context should we prioritize?')) {",
        "    updated = updated.trimEnd()",
        "      + '\\n\\n- [ ] question: Which bounded context should we prioritize?'",
        "      + '\\n- [ ] Trace communication flow for selected context\\n';",
        "  }",
        "  fs.writeFileSync(sourcePath, updated.endsWith('\\n') ? updated : `${updated}\\n`, 'utf-8');",
        "  process.exit(0);",
        "}",
        "if (prompt.includes('You are executing one step of a query investigation plan.')) {",
        "  const taskMatch = prompt.match(/- Task: (.+)/);",
        "  const task = taskMatch ? taskMatch[1].trim() : 'unknown';",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  const hasAnswer = source.includes('answer: Auth');",
        "  record('run', { task, hasAnswer });",
        "  if (!hasAnswer) {",
        "    process.exit(97);",
        "  }",
        "  console.log(`# ${task}\\n\\n- Focused on Auth context\\n`);",
        "  process.exit(0);",
        "}",
        "record('unknown');",
        "process.exit(95);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const stdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    const input = new PassThrough() as PassThrough & { isTTY: boolean };
    input.isTTY = true;

    Object.defineProperty(process, "stdin", {
      configurable: true,
      value: input,
    });

    let result;
    try {
      result = await withTerminalTty(true, async () => {
        setTimeout(() => {
          input.write("Auth\n");
        }, 25);

        return runCli([
          "query",
          "map communication flow",
          "--dir",
          analysisDir,
          "--worker",
          "node",
          workerScriptPath.replace(/\\/g, "/"),
        ], workspace);
      });
    } finally {
      if (stdinDescriptor) {
        Object.defineProperty(process, "stdin", stdinDescriptor);
      } else {
        Reflect.deleteProperty(process, "stdin");
      }
    }

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Running tool: question"))).toBe(true);

    const probeEntries = fs.readFileSync(phaseProbePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { phase: string; task?: string; hasAnswer?: boolean });
    const runEntries = probeEntries.filter((entry) => entry.phase === "run");
    expect(probeEntries.map((entry) => entry.phase)).toContain("research");
    expect(probeEntries.map((entry) => entry.phase)).toContain("plan");
    expect(runEntries).toHaveLength(1);
    expect(runEntries[0]).toMatchObject({
      task: "Trace communication flow for selected context",
      hasAnswer: true,
    });
  });

  it("query --format json writes aggregated output to --output file", async () => {
    const workspace = makeTempWorkspace();
    const analysisDir = path.join(workspace, "analysis-json");
    const workerScriptPath = path.join(workspace, "query-json-worker.cjs");
    const outputPath = path.join(workspace, "result", "query.json");

    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, "service.ts"), "export const authEnabled = true;\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const sourceMatch = prompt.match(/## Source file\\s+`([^`]+)`/m);",
        "const sourcePath = sourceMatch ? sourceMatch[1] : '';",
        "if (prompt.includes('Research and enrich the source document with implementation context.')) {",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (source.includes('## Research Context')) {",
        "    console.log(source);",
        "  } else {",
        "    console.log(source.trimEnd() + '\\n\\n## Research Context\\n\\n- Located auth module\\n');",
        "  }",
        "  process.exit(0);",
        "}",
        "if (prompt.includes('Edit the source Markdown file directly to improve plan coverage.')) {",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  let updated = source;",
        "  if (!updated.includes('- [ ] Capture auth findings')) {",
        "    updated = updated.trimEnd() + '\\n\\n- [ ] Capture auth findings\\n';",
        "  }",
        "  fs.writeFileSync(sourcePath, updated.endsWith('\\n') ? updated : `${updated}\\n`, 'utf-8');",
        "  process.exit(0);",
        "}",
        "if (prompt.includes('You are executing one step of a query investigation plan.')) {",
        "  const stepPathMatch = prompt.match(/`([^`]*step-[^`]+\\.md)`/);",
        "  if (!stepPathMatch) {",
        "    process.exit(96);",
        "  }",
        "  fs.writeFileSync(stepPathMatch[1], '# Evidence\\n\\n- Verified service.ts exports authEnabled\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
        "process.exit(95);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "query",
      "explain authentication flow",
      "--dir",
      analysisDir,
      "--format",
      "json",
      "--output",
      outputPath,
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(outputPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(outputPath, "utf-8")) as {
      query: string;
      steps: Array<{ title: string; content: string }>;
      output: string;
    };
    expect(parsed.query).toBe("explain authentication flow");
    expect(parsed.steps[0]?.title).toBe("Evidence");
    expect(parsed.steps[0]?.content).toContain("service.ts");
    expect(parsed.output).toContain("## Step 1: Evidence");
  });

  it("query emits yn verdict and honors success-error exit code with --output", async () => {
    const workspace = makeTempWorkspace();
    const analysisDir = path.join(workspace, "analysis-verdicts");
    const ynWorkerScriptPath = path.join(workspace, "query-yn-worker.cjs");
    const successErrorWorkerScriptPath = path.join(workspace, "query-success-error-worker.cjs");
    const successErrorOutputPath = path.join(workspace, "result", "success-error.txt");

    fs.mkdirSync(analysisDir, { recursive: true });
    fs.writeFileSync(path.join(analysisDir, "service.ts"), "export const authEnabled = true;\n", "utf-8");

    const baseScriptLines = [
      "const fs = require('node:fs');",
      "const promptPath = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      "const sourceMatch = prompt.match(/## Source file\\s+`([^`]+)`/m);",
      "const sourcePath = sourceMatch ? sourceMatch[1] : '';",
      "if (prompt.includes('Research and enrich the source document with implementation context.')) {",
      "  const source = fs.readFileSync(sourcePath, 'utf-8');",
      "  if (source.includes('## Research Context')) {",
      "    console.log(source);",
      "  } else {",
      "    console.log(source.trimEnd() + '\\n\\n## Research Context\\n\\n- Added context\\n');",
      "  }",
      "  process.exit(0);",
      "}",
      "if (prompt.includes('Edit the source Markdown file directly to improve plan coverage.')) {",
      "  const source = fs.readFileSync(sourcePath, 'utf-8');",
      "  let updated = source;",
      "  if (!updated.includes('- [ ] Assess auth verdict')) {",
      "    updated = updated.trimEnd() + '\\n\\n- [ ] Assess auth verdict\\n';",
      "  }",
      "  fs.writeFileSync(sourcePath, updated.endsWith('\\n') ? updated : `${updated}\\n`, 'utf-8');",
      "  process.exit(0);",
      "}",
      "if (prompt.includes('You are executing one step of a query investigation plan.')) {",
      "  const stepPathMatch = prompt.match(/`([^`]*step-[^`]+\\.md)`/);",
      "  if (!stepPathMatch) {",
      "    process.exit(96);",
      "  }",
      "  fs.writeFileSync(stepPathMatch[1], '# Verdict\\n\\n__VERDICT__\\n', 'utf-8');",
      "  process.exit(0);",
      "}",
      "process.exit(95);",
      "",
    ];

    fs.writeFileSync(
      ynWorkerScriptPath,
      baseScriptLines.join("\n").replace("__VERDICT__", "Y"),
      "utf-8",
    );
    fs.writeFileSync(
      successErrorWorkerScriptPath,
      baseScriptLines.join("\n").replace("__VERDICT__", "failure: missing coverage"),
      "utf-8",
    );

    const ynResult = await runCli([
      "query",
      "is auth enabled?",
      "--dir",
      analysisDir,
      "--format",
      "yn",
      "--worker",
      "node",
      ynWorkerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(ynResult.code).toBe(0);
    const ynOutput = [...ynResult.logs, ...ynResult.stdoutWrites, ...ynResult.stderrWrites].join("\n");
    expect(ynOutput).toContain("Y");

    const successErrorResult = await runCli([
      "query",
      "does migration cover all breaking changes?",
      "--dir",
      analysisDir,
      "--format",
      "success-error",
      "--output",
      successErrorOutputPath,
      "--worker",
      "node",
      successErrorWorkerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(successErrorResult.code).toBe(1);
    expect(fs.existsSync(successErrorOutputPath)).toBe(true);
    expect(fs.readFileSync(successErrorOutputPath, "utf-8")).toBe("failure: missing coverage");
  });

  it("explore forwards --scan-count, --deep, and --max-items to the plan phase only", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const forwardingProbePath = path.join(workspace, "explore-plan-options-forwarding-probe.jsonl");
    const workerScriptPath = path.join(workspace, "explore-plan-options-forwarding-worker.cjs");

    fs.writeFileSync(sourcePath, "# Roadmap\n\nSeed from explore\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const sourcePath = ${JSON.stringify(sourcePath.replace(/\\/g, "/"))};`,
        `const lockPath = ${JSON.stringify(lockPath)};`,
        `const forwardingProbePath = ${JSON.stringify(forwardingProbePath.replace(/\\/g, "/"))};`,
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const lockCommand = (() => {",
        "  if (!fs.existsSync(lockPath)) {",
        "    return 'missing';",
        "  }",
        "  try {",
        "    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));",
        "    return typeof payload.command === 'string' ? payload.command : 'unknown';",
        "  } catch {",
        "    return 'unreadable';",
        "  }",
        "})();",
        "if (lockCommand === 'research') {",
        "  fs.appendFileSync(forwardingProbePath, JSON.stringify({",
        "    phase: 'research',",
        "    hasScanPassContext: prompt.includes('Scan pass 1 of 3.'),",
        "    hasDeepPassContext: prompt.includes('Deep pass 1 of 2.'),",
        "    hasMaxItemsContext: prompt.includes('Max-items cap: 7.'),",
        "  }) + '\\n', 'utf-8');",
        "  console.log('# Roadmap\\n\\nSeed from explore\\n\\n## Research Context\\n- Captured integration context\\n\\n- [ ] Existing parent task');",
        "  process.exit(0);",
        "}",
        "if (lockCommand === 'plan') {",
        "  const isDeepPrompt = prompt.includes('## Deep Pass Context');",
        "  fs.appendFileSync(forwardingProbePath, JSON.stringify({",
        "    phase: 'plan',",
        "    isDeepPrompt,",
        "    hasScanPassContext: prompt.includes('Scan pass 1 of 3.'),",
        "    hasDeepPassContext: prompt.includes('Deep pass 1 of 2.'),",
        "    hasMaxItemsContext: prompt.includes('Max-items cap: 7.'),",
        "  }) + '\\n', 'utf-8');",
        "  if (!isDeepPrompt) {",
        "    const source = fs.readFileSync(sourcePath, 'utf-8');",
        "    if (!source.includes('- [ ] Parent task for deep forwarding')) {",
        "      fs.writeFileSync(sourcePath, source.trimEnd() + '\\n\\n- [ ] Parent task for deep forwarding\\n', 'utf-8');",
        "    }",
        "  }",
        "  process.exit(0);",
        "}",
        "process.exit(94);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "explore",
      sourceName,
      "--scan-count",
      "3",
      "--deep",
      "2",
      "--max-items",
      "7",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    const probeEntries = fs.readFileSync(forwardingProbePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        phase: "research" | "plan";
        isDeepPrompt?: boolean;
        hasScanPassContext: boolean;
        hasDeepPassContext: boolean;
        hasMaxItemsContext: boolean;
      });

    const researchEntry = probeEntries.find((entry) => entry.phase === "research");
    expect(researchEntry).toBeDefined();
    expect(researchEntry).toMatchObject({
      hasScanPassContext: false,
      hasDeepPassContext: false,
      hasMaxItemsContext: false,
    });

    const planScanEntry = probeEntries.find((entry) => entry.phase === "plan" && entry.isDeepPrompt === false);
    expect(planScanEntry).toBeDefined();
    expect(planScanEntry).toMatchObject({
      hasScanPassContext: true,
      hasDeepPassContext: false,
      hasMaxItemsContext: true,
    });

    const planDeepEntry = probeEntries.find((entry) => entry.phase === "plan" && entry.isDeepPrompt === true);
    expect(planDeepEntry).toBeDefined();
    expect(planDeepEntry).toMatchObject({
      hasDeepPassContext: true,
      hasMaxItemsContext: true,
    });
  });

  it("make forwards --max-items to plan and stops after reaching the item cap", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "8. Do something.md";
    const markdownFile = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    const workerScriptPath = path.join(workspace, "make-max-items-worker.cjs");
    const planScanMarkerPath = path.join(workspace, ".make-max-items-plan-scan-count");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const sourcePath = ${JSON.stringify(markdownFile.replace(/\\/g, "/"))};`,
        `const lockPath = ${JSON.stringify(lockPath.replace(/\\/g, "/"))};`,
        `const planScanMarkerPath = ${JSON.stringify(planScanMarkerPath.replace(/\\/g, "/"))};`,
        "const lockCommand = (() => {",
        "  if (!fs.existsSync(lockPath)) {",
        "    return 'missing';",
        "  }",
        "  try {",
        "    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));",
        "    return typeof payload.command === 'string' ? payload.command : 'unknown';",
        "  } catch {",
        "    return 'unreadable';",
        "  }",
        "})();",
        "if (lockCommand === 'plan') {",
        "  const previous = fs.existsSync(planScanMarkerPath) ? Number(fs.readFileSync(planScanMarkerPath, 'utf-8')) : 0;",
        "  const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "  fs.writeFileSync(planScanMarkerPath, String(current));",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (current === 1) {",
        "    fs.writeFileSync(sourcePath, source.trimEnd() + '\\n- [ ] Item one\\n- [ ] Item two\\n', 'utf-8');",
        "    process.exit(0);",
        "  }",
        "  fs.writeFileSync(sourcePath, source.trimEnd() + '\\n- [ ] Should not be added\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "make",
      "Seed from make",
      sourceName,
      "--scan-count",
      "5",
      "--max-items",
      "1",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(planScanMarkerPath, "utf-8").trim()).toBe("1");

    const updated = fs.readFileSync(markdownFile, "utf-8");
    expect(updated).toContain("Item one");
    expect(updated).toContain("Item two");
    expect(updated).not.toContain("Should not be added");
  });

  it("make without --max-items keeps planning unbounded by item count", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "8. Do something.md";
    const markdownFile = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    const workerScriptPath = path.join(workspace, "make-without-max-items-worker.cjs");
    const planScanMarkerPath = path.join(workspace, ".make-without-max-items-plan-scan-count");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const sourcePath = ${JSON.stringify(markdownFile.replace(/\\/g, "/"))};`,
        `const lockPath = ${JSON.stringify(lockPath.replace(/\\/g, "/"))};`,
        `const planScanMarkerPath = ${JSON.stringify(planScanMarkerPath.replace(/\\/g, "/"))};`,
        "const lockCommand = (() => {",
        "  if (!fs.existsSync(lockPath)) {",
        "    return 'missing';",
        "  }",
        "  try {",
        "    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));",
        "    return typeof payload.command === 'string' ? payload.command : 'unknown';",
        "  } catch {",
        "    return 'unreadable';",
        "  }",
        "})();",
        "if (lockCommand === 'plan') {",
        "  const previous = fs.existsSync(planScanMarkerPath) ? Number(fs.readFileSync(planScanMarkerPath, 'utf-8')) : 0;",
        "  const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "  fs.writeFileSync(planScanMarkerPath, String(current));",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (current === 1) {",
        "    fs.writeFileSync(sourcePath, source.trimEnd() + '\\n- [ ] Item one\\n- [ ] Item two\\n', 'utf-8');",
        "    process.exit(0);",
        "  }",
        "  fs.writeFileSync(sourcePath, source.trimEnd() + '\\n- [ ] Added on second scan\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "make",
      "Seed from make",
      sourceName,
      "--scan-count",
      "2",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(planScanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(markdownFile, "utf-8");
    expect(updated).toContain("Item one");
    expect(updated).toContain("Item two");
    expect(updated).toContain("Added on second scan");
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

  it.each(["fast", "raw"])("run executes %s-prefixed tasks without verification when --verify is enabled", async (prefix) => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), `- [ ] ${prefix}: release docs are consistent\n`, "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--verify",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task uses fast/raw intent"))).toBe(true);
    expect(result.logs.some((line) => line.includes("would run: opencode run"))).toBe(true);
    expect(result.logs.some((line) => line.includes("would run verification"))).toBe(false);
  });

  it.each(["fast", "raw"])("run skips empty %s payload tasks and surfaces warning output", async (prefix) => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "empty-fast-payload-worker.cjs");
    const workerProbePath = path.join(workspace, "empty-fast-payload-worker-ran.txt");

    fs.writeFileSync(roadmapPath, `- [ ] ${prefix}:   \n`, "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(workerProbePath.replace(/\\/g, "/"))}, 'ran\\n', 'utf-8');`,
      "process.exit(0);",
      "",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("Fast task has no payload text; skipping.")).toBe(true);
    expect(fs.existsSync(workerProbePath)).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(`- [ ] ${prefix}:   \n`);
  });

  it.each(["fast", "raw"])("run mixed %s/normal plans verify only the normal task under --verify", async (prefix) => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "verify-probe-worker.mjs");
    const phaseLogPath = path.join(workspace, ".worker-phase.log");
    const normalizedWorkerScriptPath = workerScriptPath.replace(/\\/g, "/");

    fs.writeFileSync(workerScriptPath, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const promptPath = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      "const phaseLogPath = path.join(process.cwd(), '.worker-phase.log');",
      "if (prompt.includes('Verify whether the selected task is complete.')) {",
      "  fs.appendFileSync(phaseLogPath, 'verify\\n');",
      "  console.log('OK');",
      "  process.exit(0);",
      "}",
      "fs.appendFileSync(phaseLogPath, 'execute\\n');",
      "process.exit(0);",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(roadmapPath, [
      `- [ ] ${prefix}: release docs are consistent`,
      "- [ ] finalize release notes",
      "",
    ].join("\n"), "utf-8");

    const fastTaskResult = await runCli([
      "run",
      "roadmap.md",
      "--verify",
      "--worker",
      "node",
      normalizedWorkerScriptPath,
    ], workspace);

    expect(fastTaskResult.code).toBe(0);
    expect(fastTaskResult.logs.some((line) => line.includes("Task uses fast/raw intent"))).toBe(true);
    expect(fastTaskResult.logs.some((line) => line.includes(`node ${normalizedWorkerScriptPath} [wait]`))).toBe(true);
    expect(fastTaskResult.logs.some((line) => line.includes("Running tool:"))).toBe(false);
    const phasesAfterFastTask = fs.readFileSync(phaseLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(phasesAfterFastTask.filter((phase) => phase === "execute")).toHaveLength(1);
    expect(phasesAfterFastTask.filter((phase) => phase === "verify")).toHaveLength(0);

    const normalTaskResult = await runCli([
      "run",
      "roadmap.md",
      "--verify",
      "--worker",
      "node",
      normalizedWorkerScriptPath,
    ], workspace);

    expect(normalTaskResult.code).toBe(0);
    const phasesAfterNormalTask = fs.readFileSync(phaseLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(phasesAfterNormalTask.filter((phase) => phase === "execute")).toHaveLength(2);
    expect(phasesAfterNormalTask.filter((phase) => phase === "verify")).toHaveLength(1);
  });

  it.each(["fast", "raw"])("run inherits %s directives for child tasks and skips verification under --verify", async (prefix) => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "verify-probe-worker-inherited-fast.mjs");
    const phaseLogPath = path.join(workspace, ".worker-phase.log");
    const normalizedWorkerScriptPath = workerScriptPath.replace(/\\/g, "/");

    fs.writeFileSync(workerScriptPath, [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const promptPath = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      "const phaseLogPath = path.join(process.cwd(), '.worker-phase.log');",
      "if (prompt.includes('Verify whether the selected task is complete.')) {",
      "  fs.appendFileSync(phaseLogPath, 'verify\\n');",
      "  console.log('OK');",
      "  process.exit(0);",
      "}",
      "fs.appendFileSync(phaseLogPath, 'execute\\n');",
      "process.exit(0);",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(roadmapPath, [
      `- ${prefix}:`,
      "  - [ ] ship release docs",
      "  - [ ] audit changelog links",
      "",
    ].join("\n"), "utf-8");

    const firstChildResult = await runCli([
      "run",
      "roadmap.md",
      "--verify",
      "--worker",
      "node",
      normalizedWorkerScriptPath,
    ], workspace);

    expect(firstChildResult.code).toBe(0);
    const phasesAfterFirstChild = fs.readFileSync(phaseLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(phasesAfterFirstChild.filter((phase) => phase === "execute")).toHaveLength(1);
    expect(phasesAfterFirstChild.filter((phase) => phase === "verify")).toHaveLength(0);

    const secondChildResult = await runCli([
      "run",
      "roadmap.md",
      "--verify",
      "--worker",
      "node",
      normalizedWorkerScriptPath,
    ], workspace);

    expect(secondChildResult.code).toBe(0);
    const phasesAfterSecondChild = fs.readFileSync(phaseLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(phasesAfterSecondChild.filter((phase) => phase === "execute")).toHaveLength(2);
    expect(phasesAfterSecondChild.filter((phase) => phase === "verify")).toHaveLength(0);
  });

  it.each(["fast", "raw"])("run keeps verify/memory prefix behavior unchanged when %s aliases are present", async (prefix) => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "verify-memory-regression-worker.cjs");
    const phaseLogPath = path.join(workspace, ".worker-phase.log");
    const normalizedWorkerScriptPath = workerScriptPath.replace(/\\/g, "/");

    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const promptPath = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      "const phaseLogPath = path.join(process.cwd(), '.worker-phase.log');",
      "if (prompt.includes('Verify whether the selected task is complete.')) {",
      "  fs.appendFileSync(phaseLogPath, 'verify\\n');",
      "  console.log('OK');",
      "  process.exit(0);",
      "}",
      "fs.appendFileSync(phaseLogPath, 'execute\\n');",
      "console.log('Captured release context');",
      "process.exit(0);",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(roadmapPath, [
      `- [ ] ${prefix}: prep release context`,
      "- [ ] verify: release docs are consistent",
      "- [ ] memory: capture release context",
      "",
    ].join("\n"), "utf-8");

    const fastTaskResult = await runCli([
      "run",
      "roadmap.md",
      "--verify",
      "--worker",
      "node",
      normalizedWorkerScriptPath,
    ], workspace);

    expect(fastTaskResult.code).toBe(0);
    expect(fastTaskResult.logs.some((line) => line.includes("Task uses fast/raw intent"))).toBe(true);
    const phasesAfterFastTask = fs.readFileSync(phaseLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(phasesAfterFastTask.filter((phase) => phase === "execute")).toHaveLength(1);
    expect(phasesAfterFastTask.filter((phase) => phase === "verify")).toHaveLength(0);

    const verifyTaskResult = await runCli([
      "run",
      "roadmap.md",
      "--verify",
      "--worker",
      "node",
      normalizedWorkerScriptPath,
    ], workspace);

    expect(verifyTaskResult.code).toBe(0);
    const phasesAfterVerifyTask = fs.readFileSync(phaseLogPath, "utf-8").trim().split("\n").filter(Boolean);
    expect(phasesAfterVerifyTask.filter((phase) => phase === "execute")).toHaveLength(1);
    expect(phasesAfterVerifyTask.filter((phase) => phase === "verify")).toHaveLength(1);

    const memoryTaskResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      normalizedWorkerScriptPath,
    ], workspace);

    expect(memoryTaskResult.code).toBe(0);
    expect(memoryTaskResult.logs.some((line) => line.includes("Task checked: capture release context"))).toBe(true);

    const memoryFilePath = path.join(workspace, ".rundown", "roadmap.md.memory.md");
    const memoryIndexPath = path.join(workspace, ".rundown", "memory-index.json");
    const canonicalSourcePath = path.resolve(roadmapPath);

    expect(fs.existsSync(memoryFilePath)).toBe(true);
    expect(fs.existsSync(memoryIndexPath)).toBe(true);
    expect(fs.readFileSync(memoryFilePath, "utf-8")).toContain("Captured release context");

    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(index[canonicalSourcePath]?.summary).toBe("Captured release context");
  });

  it("run keeps directive-based profile behavior for verify tasks during migration", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(
      path.join(workspace, "roadmap.md"),
      [
        "- profile=legacy",
        "  - [ ] verify: release docs are consistent",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), JSON.stringify({
      workers: {
        default: ["opencode", "run"],
      },
      profiles: {
        legacy: ["opencode", "run", "--profile", "legacy-directive"],
        modern: ["opencode", "run", "--profile", "modern-prefix"],
      },
    }, null, 2), "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would run verification with: opencode run --profile legacy-directive"))).toBe(true);
  });

  it("run prefers prefix-based profile over directive-based profile during migration", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(
      path.join(workspace, "roadmap.md"),
      [
        "- profile=legacy",
        "  - [ ] profile=modern, verify: release docs are consistent",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), JSON.stringify({
      workers: {
        default: ["opencode", "run"],
      },
      profiles: {
        legacy: ["opencode", "run", "--profile", "legacy-directive"],
        modern: ["opencode", "run", "--profile", "modern-prefix"],
      },
    }, null, 2), "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--dry-run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(
      result.logs.some(
        (line) => line.includes("would run verification with: opencode run --profile modern-prefix"),
      ),
    ).toBe(true);
  });

  it("do is registered and rejects non-wait modes before execution", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "do",
      "please do something",
      "8. Do something.md",
      "--mode",
      "tui",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("invalid --mode value: tui")).toBe(true);
    expect(combinedOutput.includes("allowed: wait")).toBe(true);
    expect(combinedOutput.includes("unknown command")).toBe(false);
  });

  it("run executes memory-prefixed tasks and persists source-local memory artifacts", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "memory-capture-worker.cjs");
    fs.writeFileSync(roadmapPath, "- [ ] memory: capture release context\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "console.log('Captured release context');",
        "console.log('Owner: platform');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: capture release context"))).toBe(true);

    const memoryFilePath = path.join(workspace, ".rundown", "roadmap.md.memory.md");
    const memoryIndexPath = path.join(workspace, ".rundown", "memory-index.json");
    const canonicalSourcePath = path.resolve(roadmapPath);

    expect(fs.existsSync(memoryFilePath)).toBe(true);
    expect(fs.existsSync(memoryIndexPath)).toBe(true);
    expect(fs.readFileSync(memoryFilePath, "utf-8")).toContain("Captured release context");

    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(index[canonicalSourcePath]?.summary).toBe("Captured release context");
  });

  it("run expands tool tasks into children and continues with inserted work", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "tool-expansion-worker.cjs");
    const childTaskScriptPath = path.join(workspace, "child-task.cjs");
    const childProbePath = path.join(workspace, "child-task-ran.txt");
    const toolTemplatePath = path.join(workspace, ".rundown", "tools", "post-on-gitea.md");

    fs.mkdirSync(path.dirname(toolTemplatePath), { recursive: true });
    fs.writeFileSync(toolTemplatePath, "Request: {{payload}}\nContext:\n{{context}}\n", "utf-8");
    fs.writeFileSync(
      roadmapPath,
      [
        "- [ ] post-on-gitea: report auth flow",
        "- [ ] Later sibling task",
      ].join("\n") + "\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "console.log('- [ ] cli: node child-task.cjs');",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      childTaskScriptPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(childProbePath.replace(/\\/g, "/"))}, 'ok\\n', 'utf-8');`,
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: report auth flow"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: node child-task.cjs"))).toBe(true);
    expect(fs.existsSync(childProbePath)).toBe(true);
    expect(fs.readFileSync(childProbePath, "utf-8")).toBe("ok\n");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] post-on-gitea: report auth flow",
      "  - [x] cli: node child-task.cjs",
      "- [ ] Later sibling task",
      "",
    ].join("\n"));
  });

  it("run falls through gracefully when a tool prefix has no matching file", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "missing-tool-worker.cjs");

    fs.writeFileSync(roadmapPath, "- [ ] missing-tool: handle auth regression\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "console.log('Handled as a normal task');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: missing-tool: handle auth regression"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] missing-tool: handle auth regression\n");
  });

  it("run prefers built-in prefixes over same-named tool files", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "built-in-prefix-worker.cjs");
    const childTaskScriptPath = path.join(workspace, "child-task.cjs");
    const childProbePath = path.join(workspace, "child-task-ran.txt");
    const toolTemplatePath = path.join(workspace, ".rundown", "tools", "memory.md");

    fs.mkdirSync(path.dirname(toolTemplatePath), { recursive: true });
    fs.writeFileSync(toolTemplatePath, "Request: {{payload}}\n", "utf-8");
    fs.writeFileSync(roadmapPath, "- [ ] memory: capture release context\n", "utf-8");
    fs.writeFileSync(workerScriptPath, "console.log('- [ ] cli: node child-task.cjs');\n", "utf-8");
    fs.writeFileSync(
      childTaskScriptPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(childProbePath.replace(/\\/g, "/"))}, 'ran\\n', 'utf-8');`,
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: capture release context"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] memory: capture release context\n");
    expect(fs.existsSync(childProbePath)).toBe(false);

    const memoryFilePath = path.join(workspace, ".rundown", "roadmap.md.memory.md");
    expect(fs.existsSync(memoryFilePath)).toBe(true);
    expect(fs.readFileSync(memoryFilePath, "utf-8")).toContain("- [ ] cli: node child-task.cjs");
  });

  it("run end tool skips remaining siblings when condition evaluates to true", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "end-condition-worker.cjs");
    const workerProbePath = path.join(workspace, "end-worker-probe.log");

    fs.writeFileSync(roadmapPath, [
      "- [ ] end: there is no output to process",
      "- [ ] Ship release notes",
      "  - [ ] Verify links",
      "- [ ] Publish changelog",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      "const promptPath = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      `const probePath = ${JSON.stringify(workerProbePath.replace(/\\/g, "/"))};`,
      "if (prompt.includes('You are evaluating an end-condition for a Markdown task runner.')) {",
      "  fs.appendFileSync(probePath, 'evaluate\\n', 'utf-8');",
      "  console.log('{\"decision\":\"yes\"}');",
      "  process.exit(0);",
      "}",
      "fs.appendFileSync(probePath, 'execute\\n', 'utf-8');",
      "process.exit(0);",
      "",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(workerProbePath, "utf-8")).toBe("evaluate\n");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] end: there is no output to process",
      "- [x] Ship release notes",
      "  - skipped: there is no output to process",
      "  - [x] Verify links",
      "    - skipped: there is no output to process",
      "- [x] Publish changelog",
      "  - skipped: there is no output to process",
      "",
    ].join("\n"));
  });

  describe("run control-flow prefix compatibility aliases", () => {
    async function runControlFlowAliasScenario(params: {
      prefix: "optional" | "skip" | "end" | "return" | "quit" | "break";
      scenario: "true" | "false" | "ambiguous" | "error";
    }): Promise<{
      roadmapPath: string;
      workerProbePath: string;
      result: Awaited<ReturnType<typeof runCli>>;
    }> {
      const workspace = makeTempWorkspace();
      const roadmapPath = path.join(workspace, "roadmap.md");
      const workerScriptPath = path.join(workspace, `${params.prefix}-condition-worker.cjs`);
      const workerProbePath = path.join(workspace, `${params.prefix}-worker-probe.log`);

      fs.writeFileSync(roadmapPath, [
        `- [ ] ${params.prefix}: there is no output to process`,
        "- [ ] Ship release notes",
        "- [ ] Publish changelog",
        "",
      ].join("\n"), "utf-8");

      const conditionLogic = (() => {
        if (params.scenario === "true") {
          return [
            "  fs.appendFileSync(probePath, 'evaluate\\n', 'utf-8');",
            "  console.log('{\"decision\":\"yes\"}');",
            "  process.exit(0);",
          ].join("\n");
        }

        if (params.scenario === "false") {
          return [
            "  fs.appendFileSync(probePath, 'evaluate\\n', 'utf-8');",
            "  console.log('{\"decision\":\"no\"}');",
            "  process.exit(0);",
          ].join("\n");
        }

        if (params.scenario === "ambiguous") {
          return [
            "  fs.appendFileSync(probePath, 'evaluate\\n', 'utf-8');",
            "  console.log('maybe');",
            "  process.exit(0);",
          ].join("\n");
        }

        return [
          "  fs.appendFileSync(probePath, 'evaluate\\n', 'utf-8');",
          "  process.exit(11);",
        ].join("\n");
      })();

      fs.writeFileSync(workerScriptPath, [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        `const probePath = ${JSON.stringify(workerProbePath.replace(/\\/g, "/"))};`,
        "if (prompt.includes('You are evaluating an end-condition for a Markdown task runner.')) {",
        conditionLogic,
        "}",
        "fs.appendFileSync(probePath, 'execute\\n', 'utf-8');",
        "process.exit(0);",
        "",
      ].join("\n"), "utf-8");

      const result = await runCli([
        "run",
        "roadmap.md",
        "--all",
        "--no-verify",
        "--worker",
        "node",
        workerScriptPath.replace(/\\/g, "/"),
      ], workspace);

      return {
        roadmapPath,
        workerProbePath,
        result,
      };
    }

    it.each(["optional", "skip", "end", "return", "quit", "break"] as const)(
      "%s: true condition skips remaining siblings",
      async (prefix) => {
        const { result, roadmapPath, workerProbePath } = await runControlFlowAliasScenario({
          prefix,
          scenario: "true",
        });

        expect(result.code).toBe(0);
        expect(fs.readFileSync(workerProbePath, "utf-8")).toBe("evaluate\n");
        expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
          `- [x] ${prefix}: there is no output to process`,
          "- [x] Ship release notes",
          "  - skipped: there is no output to process",
          "- [x] Publish changelog",
          "  - skipped: there is no output to process",
          "",
        ].join("\n"));
      },
    );

    it.each(["optional", "skip", "end", "return", "quit", "break"] as const)(
      "%s: false condition continues with sibling execution",
      async (prefix) => {
        const { result, roadmapPath, workerProbePath } = await runControlFlowAliasScenario({
          prefix,
          scenario: "false",
        });

        expect(result.code).toBe(0);
        expect(fs.readFileSync(workerProbePath, "utf-8")).toBe("evaluate\nexecute\nexecute\n");
        expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
          `- [x] ${prefix}: there is no output to process`,
          "- [x] Ship release notes",
          "- [x] Publish changelog",
          "",
        ].join("\n"));
      },
    );

    it.each(["optional", "skip", "end", "return", "quit", "break"] as const)(
      "%s: ambiguous condition defaults to no and continues",
      async (prefix) => {
        const { result, roadmapPath, workerProbePath } = await runControlFlowAliasScenario({
          prefix,
          scenario: "ambiguous",
        });

        expect(result.code).toBe(0);
        expect(fs.readFileSync(workerProbePath, "utf-8")).toBe("evaluate\nexecute\nexecute\n");
        expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
          `- [x] ${prefix}: there is no output to process`,
          "- [x] Ship release notes",
          "- [x] Publish changelog",
          "",
        ].join("\n"));
      },
    );

    it.each(["optional", "skip", "end", "return", "quit", "break"] as const)(
      "%s: worker error returns execution failure without checking tasks",
      async (prefix) => {
        const { result, roadmapPath, workerProbePath } = await runControlFlowAliasScenario({
          prefix,
          scenario: "error",
        });

        expect(result.code).toBe(1);
        expect(fs.readFileSync(workerProbePath, "utf-8")).toBe("evaluate\n");
        expect(result.errors.some((line) => line.includes("End condition worker exited with code 11."))).toBe(true);
        expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
          `- [ ] ${prefix}: there is no output to process`,
          "- [ ] Ship release notes",
          "- [ ] Publish changelog",
          "",
        ].join("\n"));
      },
    );
  });

  it("run returns execution error for memory prefix with empty payload and does not write memory files", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] memory:   \n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Memory capture task requires payload text after the prefix"))).toBe(true);

    const memoryFilePath = path.join(workspace, ".rundown", "roadmap.md.memory.md");
    const memoryIndexPath = path.join(workspace, ".rundown", "memory-index.json");
    expect(fs.existsSync(memoryFilePath)).toBe(false);
    expect(fs.existsSync(memoryIndexPath)).toBe(false);
  });

  it("run --print-prompt renders memory-map template fields when source memory is available", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const sourceCanonicalPath = path.resolve(roadmapPath);
    const memoryFilePath = path.join(workspace, ".rundown", "roadmap.md.memory.md");
    const memoryIndexPath = path.join(workspace, ".rundown", "memory-index.json");
    fs.writeFileSync(roadmapPath, "- [ ] Draft release checklist\n", "utf-8");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [sourceCanonicalPath]: {
        summary: "Captured release context",
      },
    }, null, 2), "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("## Memory context")).toBe(true);
    expect(combinedOutput.includes("- Status: available")).toBe(true);
    expect(combinedOutput.includes(`- File: \`${memoryFilePath}\``)).toBe(true);
    expect(combinedOutput.includes(`- Index: \`${memoryIndexPath}\``)).toBe(true);
    expect(combinedOutput.includes("- Summary: Captured release context")).toBe(true);
    expect(combinedOutput.includes("Memory map:")).toBe(true);
    expect(combinedOutput.includes('"status":"available"')).toBe(true);
    expect(combinedOutput.includes('"summary":"Captured release context"')).toBe(true);
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
      "--verbose",
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

  it("reverify --all --oldest-first --dry-run lists selected runs oldest-first", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000300000Z-newest-completed",
      status: "completed",
      startedAt: "2026-03-17T00:03:00.000Z",
      taskText: "task newest",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000200000Z-middle-completed",
      status: "reverify-completed",
      startedAt: "2026-03-17T00:02:00.000Z",
      taskText: "task middle",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-oldest-completed",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
      taskText: "task oldest",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000400000Z-failed",
      status: "verification-failed",
      startedAt: "2026-03-17T00:04:00.000Z",
      taskText: "task failed",
    });

    const result = await runCli([
      "reverify",
      "--all",
      "--oldest-first",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("would re-verify 3 completed runs"))).toBe(true);
    const listedRuns = result.logs
      .filter((line) => line.includes("run-20260317T"));
    expect(listedRuns).toHaveLength(3);
    expect(listedRuns[0]).toContain("run-20260317T000100000Z-oldest-completed");
    expect(listedRuns[1]).toContain("run-20260317T000200000Z-middle-completed");
    expect(listedRuns[2]).toContain("run-20260317T000300000Z-newest-completed");
    expect(result.logs.some((line) => line.includes("run-20260317T000400000Z-failed"))).toBe(false);
  });

  it("reverify --all --oldest-first processes runs in oldest-first order and keeps failure exit code", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(
      path.join(workspace, "roadmap.md"),
      "- [x] task oldest\n- [x] task middle\n- [x] task newest\n",
      "utf-8",
    );
    writeSavedRun(workspace, {
      runId: "run-20260317T000300000Z-newest-completed",
      status: "completed",
      startedAt: "2026-03-17T00:03:00.000Z",
      taskText: "task newest",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000200000Z-middle-completed",
      status: "reverify-completed",
      startedAt: "2026-03-17T00:02:00.000Z",
      taskText: "task middle",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-oldest-completed",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
      taskText: "task oldest",
    });

    const result = await runCli([
      "reverify",
      "--all",
      "--oldest-first",
      "--no-repair",
      "--verbose",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('task newest')){console.log('NOT_OK: newest fails');process.exit(0);}console.log('OK');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Verification failed after all repair attempts."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Re-verify pass summary: 2 successes, 1 failure."))).toBe(true);
    const stderrOutput = stripAnsi([...result.errors, ...result.stderrWrites].join("\n"));
    expect(stderrOutput.includes("newest fails")).toBe(true);
    const reverifyLines = result.logs.filter((line) => line.includes("Re-verify task:"));
    expect(reverifyLines).toHaveLength(3);
    expect(reverifyLines[0]).toContain("task oldest");
    expect(reverifyLines[1]).toContain("task middle");
    expect(reverifyLines[2]).toContain("task newest");
    expect(result.errors.some((line) => line.includes("Re-verify stopped on run-20260317T000300000Z-newest-completed after 2 successful task(s)."))).toBe(true);
  });

  it("reverify --help lists run targeting and repair options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["reverify", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--run <id|latest> Choose artifact run id or 'latest'");
    expect(compactHelpOutput).toContain("--oldest-first Process selected runs in oldest-first order");
    expect(compactHelpOutput).toContain("--repair-attempts <n> Max repair attempts on verification failure");
    expect(compactHelpOutput).toContain("--resolve-repair-attempts <n> Max resolve-informed repair attempts after diagnosis");
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
    expect(compactHelpOutput).toContain("--keep-artifacts Preserve runtime prompts, logs, and metadata under <config-dir>/runs");
  });

  it("revert returns 3 when no completed artifacts exist", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "revert",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("No saved runtime artifact run found for: latest completed"))).toBe(true);
  });

  it("revert suggests `rundown log --revertable` when completed runs exist but none are revertable", async () => {
    const workspace = makeTempWorkspace();

    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed-no-sha",
      status: "completed",
      extra: {
        note: "missing commit SHA",
      },
    });

    const result = await runCli([
      "revert",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("No revertable runs found."))).toBe(true);
    expect(result.errors.some((line) => line.includes("rundown log --revertable"))).toBe(true);
  });

  it("revert explains file-done final-artifact targeting for explicit non-final run ids", async () => {
    const workspace = makeTempWorkspace();

    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-file-done-nonfinal",
      status: "completed",
      startedAt: "2026-03-17T00:00:00.000Z",
      extra: {
        note: "file-done non-final artifact has no commitSha",
      },
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-file-done-final",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
      extra: {
        commitSha: "abc123",
      },
    });

    const result = await runCli([
      "revert",
      "--run",
      "run-20260317T000000000Z-file-done-nonfinal",
    ], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("is not revertable because it does not include extra.commitSha"))).toBe(true);
    expect(result.errors.some((line) => line.includes("--commit-mode file-done"))).toBe(true);
    expect(result.errors.some((line) => line.includes("--run latest"))).toBe(true);
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
    expect(revertResult.logs.some((line) => line.includes("Revert operation summary: 3 successes, 0 failures."))).toBe(true);
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

  it("undo enforces dirty-worktree safety unless --force and keeps task state consistent when blocked", async () => {
    const blockedWorkspace = makeTempWorkspace();
    setupUndoDirtyWorkspace(blockedWorkspace, {
      runId: "run-20260411T161022955Z-undo-blocked",
      taskText: "Write docs",
    });

    const blockedResult = await runCli([
      "undo",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], blockedWorkspace);

    expect(blockedResult.code).toBe(1);
    expect(blockedResult.errors.some((line) => line.includes("Working directory is not clean"))).toBe(true);
    expect(fs.readFileSync(path.join(blockedWorkspace, "roadmap.md"), "utf-8")).toContain("- [x] Write docs");

    const forcedWorkspace = makeTempWorkspace();
    setupUndoDirtyWorkspace(forcedWorkspace, {
      runId: "run-20260411T161022955Z-undo-force",
      taskText: "Write docs",
    });

    const forcedResult = await runCli([
      "undo",
      "--force",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], forcedWorkspace);

    expect(forcedResult.code).toBe(0);
    expect(forcedResult.logs.some((line) => line.includes("--force enabled: skipping clean-worktree precondition check."))).toBe(true);
    expect(fs.readFileSync(path.join(forcedWorkspace, "roadmap.md"), "utf-8")).toContain("- [ ] Write docs");
  });

  it("migrate down mirrors undo dirty-worktree safety and --force behavior", async () => {
    const blockedWorkspace = makeTempWorkspace();
    setupUndoDirtyWorkspace(blockedWorkspace, {
      runId: "run-20260411T161022955Z-down-blocked",
      taskText: "Write docs",
    });

    const blockedResult = await runCli([
      "migrate",
      "down",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], blockedWorkspace);

    expect(blockedResult.code).toBe(1);
    expect(blockedResult.errors.some((line) => line.includes("Working directory is not clean"))).toBe(true);
    expect(fs.readFileSync(path.join(blockedWorkspace, "roadmap.md"), "utf-8")).toContain("- [x] Write docs");

    const forcedWorkspace = makeTempWorkspace();
    setupUndoDirtyWorkspace(forcedWorkspace, {
      runId: "run-20260411T161022955Z-down-force",
      taskText: "Write docs",
    });

    const forcedResult = await runCli([
      "migrate",
      "down",
      "--force",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], forcedWorkspace);

    expect(forcedResult.code).toBe(0);
    expect(forcedResult.logs.some((line) => line.includes("--force enabled: skipping clean-worktree precondition check."))).toBe(true);
    expect(fs.readFileSync(path.join(forcedWorkspace, "roadmap.md"), "utf-8")).toContain("- [ ] Write docs");
  });

  it("migrate down [n] routes to undo --last <n> and preserves --force/--commit flags", async () => {
    const undoWorkspace = makeTempWorkspace();
    setupUndoLastRunsWorkspace(undoWorkspace);

    const undoResult = await runCli([
      "undo",
      "--last",
      "2",
      "--force",
      "--commit",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], undoWorkspace);

    expect(undoResult.code).toBe(0);
    expect(undoResult.logs.some((line) => line.includes("--force enabled: skipping clean-worktree precondition check."))).toBe(true);
    expect(fs.readFileSync(path.join(undoWorkspace, "roadmap.md"), "utf-8")).toBe([
      "- [x] Oldest task",
      "- [ ] Middle task",
      "- [ ] Newest task",
      "",
    ].join("\n"));

    const migrateWorkspace = makeTempWorkspace();
    setupUndoLastRunsWorkspace(migrateWorkspace);

    const migrateResult = await runCli([
      "migrate",
      "down",
      "2",
      "--force",
      "--commit",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], migrateWorkspace);

    expect(migrateResult.code).toBe(0);
    expect(migrateResult.logs.some((line) => line.includes("--force enabled: skipping clean-worktree precondition check."))).toBe(true);
    expect(fs.readFileSync(path.join(migrateWorkspace, "roadmap.md"), "utf-8")).toBe([
      "- [x] Oldest task",
      "- [ ] Middle task",
      "- [ ] Newest task",
      "",
    ].join("\n"));
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
    expect(result.errors.some((line) => line.includes("No worker command available"))).toBe(true);
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

  it("reverify accepts --show-agent-output option", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "reverify",
      "--show-agent-output",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(3);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("--show-agent-output")).toBe(false);
    expect(combinedOutput.includes("unknown option")).toBe(false);
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

  it("reverify shows worker stderr when --show-agent-output is set", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--show-agent-output",
      "--",
      "node",
      "-e",
      "console.error('reverify worker diagnostic');console.log('OK')",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.stderrWrites.some((line) => line.includes("reverify worker diagnostic"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Re-verification passed."))).toBe(true);
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
      "console.log('NOT_OK: verify output missing required section');process.exit(0)",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Verification failed after all repair attempts."))).toBe(true);
    expect(result.errors.some((line) => line.includes("Last validation error: verify output missing required section"))).toBe(true);
    const stderrOutput = stripAnsi([...result.errors, ...result.stderrWrites].join("\n"));
    expect(stderrOutput.includes("verify output missing required section")).toBe(true);
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

  it("reverify surfaces verification reason after failed repair attempts", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
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
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK: still failing after repair');process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Verification failed after all repair attempts."))).toBe(true);
    expect(result.errors.some((line) => line.includes("Last validation error: still failing after repair"))).toBe(true);
    const stderrOutput = stripAnsi([...result.errors, ...result.stderrWrites].join("\n"));
    expect(stderrOutput.includes("still failing after repair")).toBe(true);
  });

  it("reverify returns 2 when resolve outcome is unresolved", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--repair-attempts",
      "2",
      "--",
      "node",
      "-e",
      [
        "const fs=require('node:fs');",
        "const p=process.argv[process.argv.length-1];",
        "const prompt=fs.readFileSync(p,'utf-8');",
        "if(prompt.includes('Diagnose why verification still fails after repair attempts are exhausted.')){console.log('UNRESOLVED: cannot isolate root cause from available signals');process.exit(0);}",
        "if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK: still failing after repeated repairs');process.exit(0);}",
        "if(prompt.includes('Repair the selected task after a failed verification pass.')){process.exit(0);}",
        "process.exit(0);",
      ].join(""),
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Resolve phase could not diagnose the issue"))).toBe(true);
  });

  it("reverify returns 2 when resolve-informed repair attempts are exhausted", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-completed",
      status: "completed",
    });

    const result = await runCli([
      "reverify",
      "--repair-attempts",
      "2",
      "--resolve-repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      [
        "const fs=require('node:fs');",
        "const p=process.argv[process.argv.length-1];",
        "const prompt=fs.readFileSync(p,'utf-8');",
        "if(prompt.includes('Diagnose why verification still fails after repair attempts are exhausted.')){console.log('RESOLVED: tests keep failing because the integration fixture is still incorrect');process.exit(0);}",
        "if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK: failure persists after resolve-informed repair');process.exit(0);}",
        "if(prompt.includes('Repair the selected task after a failed verification pass.')){process.exit(0);}",
        "process.exit(0);",
      ].join(""),
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Resolve-informed repair attempts exhausted after 1 attempt(s)."))).toBe(true);
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

  it("run forwards worker stdout and stderr in wait mode when --show-agent-output is set", async () => {
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
      "--show-agent-output",
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

  it("run hides worker stdout and stderr by default", async () => {
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
    expect(result.logs.some((line) => line.includes("worker stdout"))).toBe(false);
    expect(result.stderrWrites.some((line) => line.includes("worker stderr"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Task checked: Write docs"))).toBe(true);
  });

  it("run and plan keep agent output hidden by default", async () => {
    const runWorkspace = makeTempWorkspace();
    const runRoadmapPath = path.join(runWorkspace, "run-roadmap.md");
    const runWorkerScriptPath = path.join(runWorkspace, "run-worker-hidden-parity.cjs");
    fs.writeFileSync(runRoadmapPath, "- [ ] Write docs\n", "utf-8");
    fs.writeFileSync(
      runWorkerScriptPath,
      [
        "console.log('parity hidden run stdout');",
        "console.error('parity hidden run stderr');",
      ].join("\n"),
      "utf-8",
    );

    const runResult = await runCli([
      "run",
      "run-roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      runWorkerScriptPath.replace(/\\/g, "/"),
    ], runWorkspace);

    const planWorkspace = makeTempWorkspace();
    const planRoadmapPath = path.join(planWorkspace, "plan-roadmap.md");
    const planWorkerScriptPath = path.join(planWorkspace, "plan-worker-hidden-parity.cjs");
    fs.writeFileSync(
      planRoadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      planWorkerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(planRoadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add release checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
        "}",
        "console.error('parity hidden plan stderr');",
      ].join("\n"),
      "utf-8",
    );

    const planResult = await runCli([
      "plan",
      "plan-roadmap.md",
      "--scan-count",
      "1",
      "--worker",
      "node",
      planWorkerScriptPath.replace(/\\/g, "/"),
    ], planWorkspace);

    expect(runResult.code).toBe(0);
    expect(planResult.code).toBe(0);
    expect(runResult.logs.some((line) => line.includes("parity hidden run stdout"))).toBe(false);
    expect(runResult.stderrWrites.some((line) => line.includes("parity hidden run stderr"))).toBe(false);
    expect(planResult.stderrWrites.some((line) => line.includes("parity hidden plan stderr"))).toBe(false);
    expect(planResult.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("run keeps exit code stable on inline CLI success with hidden agent output by default", async () => {
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
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs).not.toContain("inline stdout\n");
    expect(result.stderrWrites).not.toContain("inline stderr\n");
    expect(result.logs.some((line) => line.includes("Task checked: cli: node -e"))).toBe(true);
  });

  it("run --all keeps inline CLI success output hidden by default", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(
      path.join(workspace, "roadmap.md"),
      "- [ ] cli: node -e \"console.log('inline all stdout'); console.error('inline all stderr')\"\n",
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs).not.toContain("inline all stdout\n");
    expect(result.stderrWrites).not.toContain("inline all stderr\n");
    expect(result.logs.some((line) => line.includes("Task checked: cli: node -e"))).toBe(true);
  });

  it("run inserts total_time and execution_time trace statistics for inline CLI tasks", async () => {
    const workspace = makeTempWorkspace();
    const configDir = path.join(workspace, ".rundown");
    const inlineScriptPath = path.join(workspace, "inline-trace-stats.cjs");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        traceStatistics: {
          enabled: true,
          fields: ["total_time", "execution_time"],
        },
      }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      inlineScriptPath,
      "setTimeout(() => { console.log('inline done'); }, 1100);\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "roadmap.md"),
      "- [ ] cli: node inline-trace-stats.cjs\n",
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    const updated = fs.readFileSync(path.join(workspace, "roadmap.md"), "utf-8");
    expect(updated).toContain("- [x] cli: node inline-trace-stats.cjs");
    expect(updated).toMatch(/\n\s+- total time: (?:<1s|\d+s)\n/);
    expect(updated).toMatch(/\n\s+- execution: (?:<1s|\d+s)\n/);
  });

  it("run keeps failure exit code and rundown error output visible with hidden agent output by default", async () => {
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

  it("run keeps verification/repair summaries visible with hidden agent output by default", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){fs.writeFileSync('.repair-done','1');console.log('repair stdout');console.error('repair stderr');process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){if(fs.existsSync('.repair-done')){console.log('OK');}else{console.log('NOT_OK: failing checks');}console.error('verify stderr');process.exit(0);}console.log('worker stdout');console.error('worker stderr');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("[1/1]") && line.includes("Write docs"))).toBe(true);
    expect(result.errors.some((line) => line.includes("Verification failed:") && line.includes("Running repair (1 attempt(s))..."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Repair succeeded after 1 attempt(s)."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: Write docs"))).toBe(true);
    expect(result.logs).not.toContain("worker stdout\n");
    expect(result.stderrWrites).not.toContain("worker stderr\n");
  });

  it("run shows execute-stage worker output with --show-agent-output while keeping verification flow visible", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--show-agent-output",
      "--repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){fs.writeFileSync('.repair-done','1');console.log('repair stdout');console.error('repair stderr');process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){if(fs.existsSync('.repair-done')){console.log('OK');}else{console.log('NOT_OK: failing checks');}console.error('verify stderr');process.exit(0);}console.log('worker stdout');console.error('worker stderr');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("worker stdout"))).toBe(true);
    expect(result.stderrWrites.some((line) => line.includes("worker stderr"))).toBe(true);
    expect(result.errors.some((line) => line.includes("Verification failed:"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Repair attempt 1 of 1: starting..."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Repair succeeded after 1 attempt(s)."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: Write docs"))).toBe(true);
  });

  it("run does not create *.validation files during a full run", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--keep-artifacts",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Verify whether the selected task is complete.')){console.log('OK');}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("[1/1]") && line.includes("Write docs"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: Write docs"))).toBe(true);

    const validationFiles = listFilesRecursively(workspace)
      .filter((filePath) => filePath.endsWith(".validation"));
    expect(validationFiles).toEqual([]);
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

  it("run with config.json missing traceStatistics keeps baseline behavior when tracing is off", async () => {
    const workspace = makeTempWorkspace();
    const configDir = path.join(workspace, ".rundown");
    const workerScriptPath = path.join(workspace, "baseline-no-trace-stats-worker.mjs");

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", workerScriptPath.replace(/\\/g, "/")],
        },
      }, null, 2),
      "utf-8",
    );
    fs.writeFileSync(workerScriptPath, "console.log('done');\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    const updated = fs.readFileSync(path.join(workspace, "roadmap.md"), "utf-8");
    expect(updated).toContain("- [x] Write docs");
    expect(updated).not.toContain("total time:");
    expect(updated).not.toContain("tokens estimated:");
  });

  it("run --trace inserts default inline trace statistics in source Markdown", async () => {
    const workspace = makeTempWorkspace();
    const workerScriptPath = path.join(workspace, "trace-stats-worker.mjs");
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Write docs\n", "utf-8");
    fs.writeFileSync(workerScriptPath, "console.log('done');\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--trace",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);

    const updated = fs.readFileSync(path.join(workspace, "roadmap.md"), "utf-8");
    expect(updated).toContain("- [x] Write docs");
    expect(updated).toMatch(/\n\s+- total time: (?:<1s|\d+s)\n/);
    expect(updated).toMatch(/\n\s+- tokens estimated: \d+\n/);
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
    expect(
      taskContextEvent?.payload?.cli_args === null
        || typeof taskContextEvent?.payload?.cli_args === "string",
    ).toBe(true);
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

  it("run writes success-path output to global log even when runtime artifacts are not preserved", async () => {
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
    expect(entries.some((entry) => {
      return entry.command === "run"
        && entry.stream === "stdout"
        && entry.kind !== "commander";
    })).toBe(true);

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

    const firstEntries = firstLines.map((line) => JSON.parse(line) as {
      command?: string;
      session_id?: string;
    });
    const appendedEntries = secondLines.slice(firstLines.length)
      .map((line) => JSON.parse(line) as {
        command?: string;
        session_id?: string;
      });
    expect(firstEntries.some((entry) => entry.command === "run")).toBe(true);
    expect(appendedEntries.some((entry) => entry.command === "run")).toBe(true);

    const firstSessionIds = new Set(
      firstEntries
        .map((entry) => entry.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    );
    const appendedSessionIds = new Set(
      appendedEntries
        .map((entry) => entry.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    );
    expect(firstSessionIds.size).toBeGreaterThan(0);
    expect(appendedSessionIds.size).toBeGreaterThan(0);
    for (const sessionId of appendedSessionIds) {
      expect(firstSessionIds.has(sessionId)).toBe(false);
    }

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

  it("uses one append-only output log for mixed next/list/run invocations with distinct session ids", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "tasks.md"), "- [ ] Ship release notes\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: echo mixed run\n", "utf-8");

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

    const thirdResult = await runCli(["run", "roadmap.md", "--no-verify"], workspace);
    expect(thirdResult.code).toBe(0);

    const thirdLines = fs.readFileSync(outputLogPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    expect(thirdLines.length).toBeGreaterThan(secondLines.length);
    expect(thirdLines.slice(0, secondLines.length)).toEqual(secondLines);

    const firstEntries = firstLines.map((line) => JSON.parse(line) as { command?: string; session_id?: string });
    const secondEntries = secondLines.slice(firstLines.length)
      .map((line) => JSON.parse(line) as { command?: string; session_id?: string });
    const thirdEntries = thirdLines.slice(secondLines.length)
      .map((line) => JSON.parse(line) as { command?: string; session_id?: string });

    expect(firstEntries.some((entry) => entry.command === "next")).toBe(true);
    expect(secondEntries.some((entry) => entry.command === "list")).toBe(true);
    expect(thirdEntries.some((entry) => entry.command === "run")).toBe(true);

    const firstSessionIds = new Set(
      firstEntries
        .map((entry) => entry.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    );
    const secondSessionIds = new Set(
      secondEntries
        .map((entry) => entry.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    );
    const thirdSessionIds = new Set(
      thirdEntries
        .map((entry) => entry.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === "string"),
    );

    expect(firstSessionIds.size).toBeGreaterThan(0);
    expect(secondSessionIds.size).toBeGreaterThan(0);
    expect(thirdSessionIds.size).toBeGreaterThan(0);

    for (const sessionId of secondSessionIds) {
      expect(firstSessionIds.has(sessionId)).toBe(false);
    }
    for (const sessionId of thirdSessionIds) {
      expect(firstSessionIds.has(sessionId)).toBe(false);
      expect(secondSessionIds.has(sessionId)).toBe(false);
    }
  });

  it("writes global output log under the upward-discovered config dir", async () => {
    const workspace = makeTempWorkspace();
    const repoRoot = path.join(workspace, "repo");
    const projectDir = path.join(repoRoot, "packages", "app");
    const discoveredConfigDir = path.join(repoRoot, ".rundown");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(discoveredConfigDir, { recursive: true });
    fs.writeFileSync(path.join(discoveredConfigDir, "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(projectDir, "tasks.md"), "- [ ] Ship release notes\n", "utf-8");

    const result = await runCli(["next", "tasks.md"], projectDir);
    expect(result.code).toBe(0);

    const discoveredLogPath = path.join(discoveredConfigDir, "logs", "output.jsonl");
    const localLogPath = path.join(projectDir, ".rundown", "logs", "output.jsonl");
    expect(fs.existsSync(discoveredLogPath)).toBe(true);
    expect(fs.existsSync(localLogPath)).toBe(false);
  });

  it("writes global output log under an explicit relative --config-dir", async () => {
    const workspace = makeTempWorkspace();
    const projectDir = path.join(workspace, "project");
    const explicitConfigDir = path.join(workspace, "custom-config");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(explicitConfigDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "tasks.md"), "- [ ] Ship release notes\n", "utf-8");

    const result = await runCli([
      "next",
      "tasks.md",
      "--config-dir",
      "../custom-config",
    ], projectDir);

    expect(result.code).toBe(0);

    const explicitLogPath = path.join(explicitConfigDir, "logs", "output.jsonl");
    const localLogPath = path.join(projectDir, ".rundown", "logs", "output.jsonl");
    expect(fs.existsSync(explicitLogPath)).toBe(true);
    expect(fs.existsSync(localLogPath)).toBe(false);
  });

  it("writes global output log under linked workspace config dir when workspace.link resolves", async () => {
    const workspace = makeTempWorkspace();
    const sourceWorkspace = path.join(workspace, "source-workspace");
    const linkedInvocationDir = path.join(workspace, "linked-invocation");
    const linkedConfigDir = path.join(sourceWorkspace, ".rundown");
    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(linkedConfigDir, { recursive: true });
    fs.writeFileSync(path.join(linkedConfigDir, "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(path.join(sourceWorkspace, "tasks.md"), "- [ ] Capture workspace context\n", "utf-8");

    const result = await runCli(["next", path.join(sourceWorkspace, "tasks.md")], linkedInvocationDir);
    expect(result.code).toBe(0);

    const linkedLogPath = path.join(linkedConfigDir, "logs", "output.jsonl");
    const invocationLogPath = path.join(linkedInvocationDir, ".rundown", "logs", "output.jsonl");
    expect(fs.existsSync(linkedLogPath)).toBe(true);
    expect(fs.existsSync(invocationLogPath)).toBe(false);
  });

  it("falls back to invocation .rundown output log path when linked workspace has no discovered config dir", async () => {
    const workspace = makeTempWorkspace();
    const sourceWorkspace = path.join(workspace, "source-workspace");
    const linkedInvocationDir = path.join(workspace, "linked-invocation");
    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(path.join(sourceWorkspace, "tasks.md"), "- [ ] Capture workspace context\n", "utf-8");

    const result = await runCli(["next", path.join(sourceWorkspace, "tasks.md")], linkedInvocationDir);
    expect(result.code).toBe(0);

    const invocationLogPath = path.join(linkedInvocationDir, ".rundown", "logs", "output.jsonl");
    const linkedLogPath = path.join(sourceWorkspace, ".rundown", "logs", "output.jsonl");
    expect(fs.existsSync(invocationLogPath)).toBe(true);
    expect(fs.existsSync(linkedLogPath)).toBe(false);
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

  it("strips ANSI escape sequences from JSONL messages emitted by task text", async () => {
    const workspace = makeTempWorkspace();
    const ansiRed = "\u001b[31m";
    const ansiReset = "\u001b[0m";
    fs.writeFileSync(
      path.join(workspace, "tasks.md"),
      `- [ ] ${ansiRed}Ship release notes${ansiReset}\n`,
      "utf-8",
    );

    const result = await runCli(["next", "tasks.md"], workspace);
    expect(result.code).toBe(0);

    const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
    const lines = fs.readFileSync(outputLogPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(stripAnsi(line)).toBe(line);
    }

    const entries = readGlobalOutputLogEntries(workspace);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(stripAnsi(entry.message)).toBe(entry.message);
    }
  });

  it("strips ANSI escape sequences from JSONL messages emitted by inline CLI output", async () => {
    const workspace = makeTempWorkspace();
    const scriptPath = path.join(workspace, "ansi-output.cjs");
    fs.writeFileSync(
      scriptPath,
      "process.stdout.write(\"\\u001b[32mansi stdout\\u001b[0m\\n\");\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] cli: node ansi-output.cjs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--show-agent-output",
      "--keep-artifacts",
    ], workspace);

    expect(result.code).toBe(0);

    const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
    const lines = fs.readFileSync(outputLogPath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(stripAnsi(line)).toBe(line);
    }

    const entries = readGlobalOutputLogEntries(workspace);
    const ansiCliEntry = entries.find((entry) => entry.message.includes("ansi stdout"));
    expect(ansiCliEntry).toBeDefined();
    expect(stripAnsi(ansiCliEntry?.message ?? "")).toBe(ansiCliEntry?.message ?? "");
  });

  it("captures parse-time Commander invalid flag errors in .rundown/logs/output.jsonl", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "run",
      "roadmap.md",
      "--show-agent-outputs",
    ], workspace);

    expect(result.code).toBe(1);

    const entries = readGlobalOutputLogEntries(workspace);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((entry) => entry.command === "run")).toBe(true);
    expect(entries.some((entry) => {
      return entry.kind === "commander"
        && entry.level === "error"
        && entry.stream === "stderr"
        && entry.message.toLowerCase().includes("unknown option")
        && entry.message.includes("--show-agent-outputs");
    })).toBe(true);
    expect(readSavedRunMetadata(workspace)).toHaveLength(0);
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
        && entry.level === "error"
        && entry.stream === "stderr"
        && entry.message.includes("Inline CLI exited with code");
    })).toBe(true);
  });

  it("plan writes paired group-start/group-end entries for each executed scan", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-group-pairing-worker.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nInitial plan.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add implementation checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add implementation checklist\\n', 'utf-8');",
        "}",
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
    expectCommandGroupEventsToBePaired(workspace, "plan", { minPairs: 2 });
  });

  it("research writes paired group-start/group-end entries", async () => {
    const workspace = makeTempWorkspace();
    const workerScriptPath = path.join(workspace, "research-group-pairing-worker.cjs");
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "# Roadmap\n\nSeed context.\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      "console.log('# Roadmap\\n\\nResearched context.\\n');\n",
      "utf-8",
    );

    const result = await runCli([
      "research",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expectCommandGroupEventsToBePaired(workspace, "research", { expectedPairs: 1 });
  });

  it("discuss writes paired group-start/group-end entries", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Discuss rollout\n", "utf-8");

    const result = await runCli([
      "discuss",
      "roadmap.md",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    expect(result.code).toBe(0);
    expectCommandGroupEventsToBePaired(workspace, "discuss", { expectedPairs: 1 });
  });

  it("reverify --all writes paired group-start/group-end entries for each selected run", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [x] Write docs\n", "utf-8");
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-group-a",
      status: "completed",
      startedAt: "2026-03-17T00:00:00.000Z",
    });
    writeSavedRun(workspace, {
      runId: "run-20260317T000100000Z-group-b",
      status: "completed",
      startedAt: "2026-03-17T00:01:00.000Z",
    });

    const result = await runCli([
      "reverify",
      "--all",
      "--",
      "node",
      "-e",
      "console.log('OK')",
    ], workspace);

    expect(result.code).toBe(0);
    expectCommandGroupEventsToBePaired(workspace, "reverify", { expectedPairs: 2 });
  });

  it("revert writes paired group-start/group-end entries for each revert operation", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: echo first\n- [ ] cli: echo second\n",
      "utf-8",
    );
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    for (let runIndex = 0; runIndex < 2; runIndex += 1) {
      const runResult = await runCli([
        "run",
        "roadmap.md",
        "--no-verify",
        "--commit",
        "--keep-artifacts",
      ], workspace);
      expect(runResult.code).toBe(0);
    }

    const result = await runCli(["revert", "--last", "2"], workspace);

    expect(result.code).toBe(0);
    expectCommandGroupEventsToBePaired(workspace, "revert", { expectedPairs: 2 });
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

  it("run --trace-only returns 1 when enrichment output is missing analysis.summary", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const enrichmentScriptPath = path.join(workspace, "trace-enrichment-worker-missing-summary.mjs");
    fs.writeFileSync(roadmapPath, "- [x] Write docs\n", "utf-8");
    fs.writeFileSync(
      enrichmentScriptPath,
      [
        "console.log('worker output without analysis summary');",
      ].join("\n"),
      "utf-8",
    );
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-missing-analysis",
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

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Trace enrichment output did not contain a valid analysis.summary block."))).toBe(true);
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
    expect(result.errors.some((line) => line.includes("No worker command available"))).toBe(true);
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


  it("run --print-prompt executes cli fenced blocks and prints expanded output", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "echo cli-block-output",
        "```",
        "",
        "- [ ] Draft release plan",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("<command>echo cli-block-output</command>")).toBe(true);
    expect(combinedOutput.includes("cli-block-output")).toBe(true);
  });

  it("run annotates timed-out cli fenced block output", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "node -e \"setTimeout(function () {}, 2000)\"",
        "```",
        "",
        "- [ ] Draft release plan",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--cli-block-timeout",
      "50",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes('<command exit_code="timeout">node -e &quot;setTimeout(function () {}, 2000)&quot;</command>')).toBe(true);
    expect(combinedOutput.includes("ERROR: command timed out")).toBe(true);
    expect(combinedOutput.includes("Command timed out after 50ms.")).toBe(true);
  });

  it("run executes cli fenced blocks before worker and worker receives expanded prompt", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "echo cli-block-output",
        "```",
        "",
        "- [ ] Draft release plan",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--show-agent-output",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');process.stdout.write(prompt);",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("<command>echo cli-block-output</command>")).toBe(true);
    expect(combinedOutput.includes("cli-block-output")).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] Draft release plan");
  });

  it("run writes expanded successful source cli blocks into the staged prompt file", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "node -e \"process.stdout.write('prompt-file-success\\n')\"",
        "```",
        "",
        "- [ ] Validate prompt file cli success",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--show-agent-output",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];process.stdout.write(fs.readFileSync(p,'utf-8'));",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("<command>node -e")).toBe(true);
    expect(combinedOutput.includes("prompt-file-success")).toBe(true);
  });

  it("run writes failed source cli block diagnostics into the staged prompt file", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "node -e \"process.stderr.write('prompt-file-failure\\n');process.exit(7)\"",
        "```",
        "",
        "- [ ] Validate prompt file cli failure",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--show-agent-output",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];process.stdout.write(fs.readFileSync(p,'utf-8'));",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes('`cli` fenced command failed in source markdown (exit 7)')).toBe(true);
    expect(combinedOutput.includes('<command exit_code="7">node -e')).toBe(true);
    expect(combinedOutput.includes("prompt-file-failure")).toBe(true);
  });

  it("run --keep-artifacts persists successful source cli expansion in execute prompt.md", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "node -e \"process.stdout.write('prompt-file-artifact-success\\n')\"",
        "```",
        "",
        "- [ ] Validate prompt file artifact success",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    expect(result.code).toBe(0);
    const savedRun = findSavedRunByCommand(workspace, "run");
    expect(savedRun).toBeDefined();
    const runDir = path.join(workspace, ".rundown", "runs", savedRun!.runId);
    const workerPhaseDir = fs.readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runDir, entry.name))
      .find((phaseDir) => {
        const metadataPath = path.join(phaseDir, "metadata.json");
        if (!fs.existsSync(metadataPath)) {
          return false;
        }
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
          phase?: unknown;
          promptFile?: unknown;
        };
        return metadata.phase === "execute" && metadata.promptFile === "prompt.md";
      });

    expect(workerPhaseDir).toBeDefined();
    const promptPath = path.join(workerPhaseDir!, "prompt.md");
    expect(fs.existsSync(promptPath)).toBe(true);
    const promptSource = fs.readFileSync(promptPath, "utf-8");
    expect(promptSource).toContain("prompt-file-artifact-success");
    expect(promptSource).not.toContain("```cli");
  });

  it("run --keep-artifacts persists failed source cli diagnostics in execute prompt.md", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "node -e \"process.stderr.write('prompt-file-artifact-failure\\n');process.exit(11)\"",
        "```",
        "",
        "- [ ] Validate prompt file artifact failure",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    expect(result.code).toBe(0);
    const savedRun = findSavedRunByCommand(workspace, "run");
    expect(savedRun).toBeDefined();
    const runDir = path.join(workspace, ".rundown", "runs", savedRun!.runId);
    const workerPhaseDir = fs.readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runDir, entry.name))
      .find((phaseDir) => {
        const metadataPath = path.join(phaseDir, "metadata.json");
        if (!fs.existsSync(metadataPath)) {
          return false;
        }
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
          phase?: unknown;
          promptFile?: unknown;
        };
        return metadata.phase === "execute" && metadata.promptFile === "prompt.md";
      });

    expect(workerPhaseDir).toBeDefined();
    const promptPath = path.join(workerPhaseDir!, "prompt.md");
    expect(fs.existsSync(promptPath)).toBe(true);
    const promptSource = fs.readFileSync(promptPath, "utf-8");
    expect(promptSource).toContain('<command exit_code="11">node -e');
    expect(promptSource).toContain("prompt-file-artifact-failure");
    expect(promptSource).not.toContain("```cli");
  });

  it("run preserves source cli command ordering and non-fatal failure semantics in staged prompt files", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "node -e \"process.stdout.write('prompt-order-first\\n')\"",
        "node -e \"process.stderr.write('prompt-order-fail\\n');process.exit(9)\"",
        "node -e \"process.stdout.write('prompt-order-third\\n')\"",
        "```",
        "",
        "- [ ] Validate prompt file cli ordering and failure handling",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--show-agent-output",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];process.stdout.write(fs.readFileSync(p,'utf-8'));",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes('`cli` fenced command failed in source markdown (exit 9)')).toBe(true);
    expect(combinedOutput.includes("prompt-order-first")).toBe(true);
    expect(combinedOutput.includes("prompt-order-fail")).toBe(true);
    expect(combinedOutput.includes("prompt-order-third")).toBe(true);

    const firstIndex = combinedOutput.indexOf("prompt-order-first");
    const failedIndex = combinedOutput.indexOf("prompt-order-fail");
    const thirdIndex = combinedOutput.indexOf("prompt-order-third");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(failedIndex).toBeGreaterThan(firstIndex);
    expect(thirdIndex).toBeGreaterThan(failedIndex);
  });

  it("run --keep-artifacts writes cli fenced block stdout/stderr files", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        "echo cli-block-artifacts",
        "```",
        "",
        "- [ ] Draft release plan",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--keep-artifacts",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    expect(result.code).toBe(0);

    const latestRun = findSavedRunByCommand(workspace, "run");
    expect(latestRun).not.toBeNull();

    const runDir = path.join(workspace, ".rundown", "runs", latestRun!.runId);
    const cliSourcePhaseDir = fs.readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runDir, entry.name))
      .find((phaseDir) => {
        const metadataPath = path.join(phaseDir, "metadata.json");
        if (!fs.existsSync(metadataPath)) {
          return false;
        }

        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
          phaseLabel?: unknown;
          extra?: { cliBlockCommand?: unknown };
        };
        return metadata.phaseLabel === "cli-source"
          && metadata.extra?.cliBlockCommand === "echo cli-block-artifacts";
      });

    expect(cliSourcePhaseDir).toBeDefined();
    expect(fs.readFileSync(path.join(cliSourcePhaseDir!, "cli-block-1-stdout.txt"), "utf-8").trim()).toBe("cli-block-artifacts");
    expect(fs.readFileSync(path.join(cliSourcePhaseDir!, "cli-block-1-stderr.txt"), "utf-8")).toBe("");
  });

  it("run --dry-run skips cli fenced block execution and reports skipped block count", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "cli-block-dry-run.txt");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        `node -e \"require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'1')\"`,
        "```",
        "",
        "- [ ] Draft release plan",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--dry-run",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");
    const normalizedOutput = stripAnsi(combinedOutput).replace(/\s+/g, " ");

    expect(result.code).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(normalizedOutput).toMatch(/Dry run .+ skipped `cli` fenced block execution; would execute \d+ blocks?\./);
  });

  it("run --ignore-cli-block leaves cli fenced blocks unexpanded", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "cli-block-ran.txt");

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        `node -e \"require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'1')\"`,
        "```",
        "",
        "- [ ] Draft release plan",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--ignore-cli-block",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(result.logs.some((line) => line.includes("```cli"))).toBe(true);
    expect(result.logs.some((line) => line.includes("<command>"))).toBe(false);
  });

  it("run --ignore-cli-block still executes inline CLI tasks", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const fencedMarkerName = "fenced-skipped.txt";
    const inlineMarkerName = "inline-ran.txt";
    const fencedMarkerPath = path.join(workspace, fencedMarkerName);
    const inlineMarkerPath = path.join(workspace, inlineMarkerName);

    fs.writeFileSync(
      roadmapPath,
      [
        "```cli",
        `node -e "require('node:fs').writeFileSync('${fencedMarkerName}','1')"`,
        "```",
        "",
        `- [ ] cli: node -e "require('node:fs').writeFileSync('${inlineMarkerName}','1')"`,
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--ignore-cli-block",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(fencedMarkerPath)).toBe(false);
    expect(fs.existsSync(inlineMarkerPath)).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: node -e"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: node -e");
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

  it("run --print-prompt exposes workspace context vars in non-linked and linked invocations", async () => {
    const readWorkspaceContextValue = (output: string, key: string): string => {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = output.match(new RegExp(`${escapedKey}=([^\\r\\n]*)`));
      return match?.[1] ?? "";
    };

    const nonLinkedWorkspace = makeTempWorkspace();
    fs.writeFileSync(path.join(nonLinkedWorkspace, "roadmap.md"), "- [ ] Capture workspace context\n", "utf-8");

    const nonLinkedResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], nonLinkedWorkspace);

    const nonLinkedOutput = [
      ...nonLinkedResult.logs,
      ...nonLinkedResult.errors,
      ...nonLinkedResult.stdoutWrites,
      ...nonLinkedResult.stderrWrites,
    ].join("\n");
    expect(nonLinkedResult.code).toBe(0);
    expect(readWorkspaceContextValue(nonLinkedOutput, "invocationDir")).toBe(path.resolve(nonLinkedWorkspace));
    expect(readWorkspaceContextValue(nonLinkedOutput, "workspaceDir")).toBe(path.resolve(nonLinkedWorkspace));
    expect(readWorkspaceContextValue(nonLinkedOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(nonLinkedOutput, "isLinkedWorkspace")).toBe("false");

    const linkedSandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(linkedSandbox, "source-workspace");
    const linkedInvocationDir = path.join(linkedSandbox, "linked-invocation");
    const workspaceLinkPath = path.join(linkedInvocationDir, ".rundown", "workspace.link");
    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      workspaceLinkPath,
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(path.join(sourceWorkspace, "roadmap.md"), "- [ ] Capture workspace context\n", "utf-8");

    const linkedResult = await runCli([
      "run",
      path.join(sourceWorkspace, "roadmap.md"),
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], linkedInvocationDir);

    const linkedOutput = [
      ...linkedResult.logs,
      ...linkedResult.errors,
      ...linkedResult.stdoutWrites,
      ...linkedResult.stderrWrites,
    ].join("\n");
    expect(linkedResult.code).toBe(0);
    const linkedInvocationValue = readWorkspaceContextValue(linkedOutput, "invocationDir");
    const linkedWorkspaceValue = readWorkspaceContextValue(linkedOutput, "workspaceDir");
    const linkedWorkspaceLinkValue = readWorkspaceContextValue(linkedOutput, "workspaceLinkPath");
    expect(linkedInvocationValue).toBe(path.resolve(linkedInvocationDir));
    expect(linkedWorkspaceValue).toBe(path.resolve(sourceWorkspace));
    expect(linkedWorkspaceLinkValue).toBe(path.resolve(workspaceLinkPath));
    expect(linkedInvocationValue).not.toBe(linkedWorkspaceValue);
    expect(readWorkspaceContextValue(linkedOutput, "isLinkedWorkspace")).toBe("true");

    const brokenLinkSandbox = makeTempWorkspace();
    const brokenLinkInvocationDir = path.join(brokenLinkSandbox, "broken-linked-invocation");
    fs.mkdirSync(path.join(brokenLinkInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(brokenLinkInvocationDir, ".rundown", "workspace.link"), "../missing-workspace", "utf-8");
    fs.writeFileSync(path.join(brokenLinkInvocationDir, "roadmap.md"), "- [ ] Capture workspace context\n", "utf-8");

    const brokenLinkResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], brokenLinkInvocationDir);

    const brokenLinkOutput = [
      ...brokenLinkResult.logs,
      ...brokenLinkResult.errors,
      ...brokenLinkResult.stdoutWrites,
      ...brokenLinkResult.stderrWrites,
    ].join("\n");
    expect(brokenLinkResult.code).toBe(0);
    expect(readWorkspaceContextValue(brokenLinkOutput, "invocationDir")).toBe(path.resolve(brokenLinkInvocationDir));
    expect(readWorkspaceContextValue(brokenLinkOutput, "workspaceDir")).toBe(path.resolve(brokenLinkInvocationDir));
    expect(readWorkspaceContextValue(brokenLinkOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(brokenLinkOutput, "isLinkedWorkspace")).toBe("false");

    const staleLinkSandbox = makeTempWorkspace();
    const staleLinkInvocationDir = path.join(staleLinkSandbox, "stale-linked-invocation");
    const staleLinkTargetFile = path.join(staleLinkSandbox, "stale-workspace.txt");
    fs.mkdirSync(path.join(staleLinkInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(staleLinkTargetFile, "stale", "utf-8");
    fs.writeFileSync(
      path.join(staleLinkInvocationDir, ".rundown", "workspace.link"),
      path.relative(staleLinkInvocationDir, staleLinkTargetFile).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(path.join(staleLinkInvocationDir, "roadmap.md"), "- [ ] Capture workspace context\n", "utf-8");

    const staleLinkResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], staleLinkInvocationDir);

    const staleLinkOutput = [
      ...staleLinkResult.logs,
      ...staleLinkResult.errors,
      ...staleLinkResult.stdoutWrites,
      ...staleLinkResult.stderrWrites,
    ].join("\n");
    expect(staleLinkResult.code).toBe(0);
    expect(readWorkspaceContextValue(staleLinkOutput, "invocationDir")).toBe(path.resolve(staleLinkInvocationDir));
    expect(readWorkspaceContextValue(staleLinkOutput, "workspaceDir")).toBe(path.resolve(staleLinkInvocationDir));
    expect(readWorkspaceContextValue(staleLinkOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(staleLinkOutput, "isLinkedWorkspace")).toBe("false");

    const emptyLinkSandbox = makeTempWorkspace();
    const emptyLinkInvocationDir = path.join(emptyLinkSandbox, "empty-linked-invocation");
    fs.mkdirSync(path.join(emptyLinkInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(emptyLinkInvocationDir, ".rundown", "workspace.link"), "   \n", "utf-8");
    fs.writeFileSync(path.join(emptyLinkInvocationDir, "roadmap.md"), "- [ ] Capture workspace context\n", "utf-8");

    const emptyLinkResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], emptyLinkInvocationDir);

    const emptyLinkOutput = [
      ...emptyLinkResult.logs,
      ...emptyLinkResult.errors,
      ...emptyLinkResult.stdoutWrites,
      ...emptyLinkResult.stderrWrites,
    ].join("\n");
    expect(emptyLinkResult.code).toBe(0);
    expect(readWorkspaceContextValue(emptyLinkOutput, "invocationDir")).toBe(path.resolve(emptyLinkInvocationDir));
    expect(readWorkspaceContextValue(emptyLinkOutput, "workspaceDir")).toBe(path.resolve(emptyLinkInvocationDir));
    expect(readWorkspaceContextValue(emptyLinkOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(emptyLinkOutput, "isLinkedWorkspace")).toBe("false");

    const absoluteLinkSandbox = makeTempWorkspace();
    const absoluteLinkInvocationDir = path.join(absoluteLinkSandbox, "absolute-linked-invocation");
    const absoluteLinkTargetDir = path.join(absoluteLinkSandbox, "source-workspace");
    fs.mkdirSync(path.join(absoluteLinkInvocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(absoluteLinkTargetDir, { recursive: true });
    fs.writeFileSync(path.join(absoluteLinkInvocationDir, ".rundown", "workspace.link"), path.resolve(absoluteLinkTargetDir), "utf-8");
    fs.writeFileSync(path.join(absoluteLinkInvocationDir, "roadmap.md"), "- [ ] Capture workspace context\n", "utf-8");

    const absoluteLinkResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], absoluteLinkInvocationDir);

    const absoluteLinkOutput = [
      ...absoluteLinkResult.logs,
      ...absoluteLinkResult.errors,
      ...absoluteLinkResult.stdoutWrites,
      ...absoluteLinkResult.stderrWrites,
    ].join("\n");
    expect(absoluteLinkResult.code).toBe(0);
    expect(readWorkspaceContextValue(absoluteLinkOutput, "invocationDir")).toBe(path.resolve(absoluteLinkInvocationDir));
    expect(readWorkspaceContextValue(absoluteLinkOutput, "workspaceDir")).toBe(path.resolve(absoluteLinkInvocationDir));
    expect(readWorkspaceContextValue(absoluteLinkOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(absoluteLinkOutput, "isLinkedWorkspace")).toBe("false");
  });

  it("run --config-dir uses templates from the specified directory", async () => {
    const workspace = makeTempWorkspace();
    const projectDir = path.join(workspace, "project");
    const sharedConfigDir = path.join(workspace, "shared", ".rundown");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(sharedConfigDir, { recursive: true });

    fs.writeFileSync(path.join(projectDir, "TODO.md"), "- [ ] Validate shared config templates\n", "utf-8");
    fs.writeFileSync(path.join(sharedConfigDir, "execute.md"), "CUSTOM EXECUTE TEMPLATE FROM SHARED CONFIG\n{{TASK_TEXT}}\n", "utf-8");

    const result = await runCli([
      "run",
      "--config-dir",
      "../shared/.rundown",
      "TODO.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], projectDir);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("CUSTOM EXECUTE TEMPLATE FROM SHARED CONFIG"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Validate shared config templates"))).toBe(true);
  });

  it("make --config-dir applies shared templates consistently to research and plan phases", async () => {
    const workspace = makeTempWorkspace();
    const projectDir = path.join(workspace, "project");
    const sharedConfigDir = path.join(workspace, "shared", ".rundown");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(sharedConfigDir, { recursive: true });

    fs.writeFileSync(path.join(sharedConfigDir, "research.md"), "CUSTOM RESEARCH TEMPLATE\n{{task}}\n", "utf-8");
    fs.writeFileSync(path.join(sharedConfigDir, "plan.md"), "CUSTOM PLAN TEMPLATE\n{{task}}\n", "utf-8");

    const result = await runCli([
      "make",
      "Seed from make",
      "TODO.md",
      "--config-dir",
      "../shared/.rundown",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], projectDir);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(projectDir, "TODO.md"), "utf-8")).toBe("Seed from make");
    expect(result.logs.some((line) => line.includes("CUSTOM RESEARCH TEMPLATE"))).toBe(true);
    expect(result.logs.some((line) => line.includes("CUSTOM PLAN TEMPLATE"))).toBe(true);
  });

  it("run expands cli blocks in custom templates after template variable substitution", async () => {
    const workspace = makeTempWorkspace();
    const projectDir = path.join(workspace, "project");
    const sharedConfigDir = path.join(workspace, "shared", ".rundown");
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(sharedConfigDir, { recursive: true });

    fs.writeFileSync(path.join(projectDir, "TODO.md"), "- [ ] Verify cli template var expansion\n", "utf-8");
    fs.writeFileSync(
      path.join(sharedConfigDir, "execute.md"),
      [
        "CUSTOM TEMPLATE",
        "```cli",
        "node -e \"process.stdout.write('FILE_VAR=' + process.argv[1])\" \"{{file}}\"",
        "```",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "--config-dir",
      "../shared/.rundown",
      "TODO.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], projectDir);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("CUSTOM TEMPLATE")).toBe(true);
    expect(combinedOutput.includes("<command>node -e")).toBe(true);
    expect(combinedOutput.includes("FILE_VAR=")).toBe(true);
    expect(combinedOutput.includes("FILE_VAR={{file}}")).toBe(false);
    expect(combinedOutput.includes("{{file}}")).toBe(false);
  });

  it("run --help lists Git and completion hook options with clear descriptions", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["run", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--commit Auto-commit checked task file after successful completion");
    expect(compactHelpOutput).toContain("--commit-message <template> Commit message template (supports {{task}} and {{file}})");
    expect(compactHelpOutput).toContain("--force-attempts <n> Default outer retry attempts for force:-prefixed tasks");
    expect(compactHelpOutput).toContain("--commit-mode <mode> Commit timing for --commit: per-task (default) or file-done (effective run-all via --all/all/--redo/--clean)");
    expect(compactHelpOutput).toContain("--on-complete <command> Run a shell command after successful task completion");
  });

  it("run --help lists --trace-stats option", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["run", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--trace-stats Insert inline task trace statistics under completed TODOs in source Markdown");
  });

  it("run rejects invalid --commit-mode values", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "run",
      "roadmap.md",
      "--commit-mode",
      "later",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("invalid --commit-mode value: later")).toBe(true);
    expect(combinedOutput.includes("allowed: per-task, file-done")).toBe(true);
  });

  it("run rejects --commit-mode file-done unless --all is enabled", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "run",
      "roadmap.md",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("invalid --commit-mode usage")).toBe(true);
    expect(combinedOutput.includes("file-done is only supported with effective run-all (`run --all`, `all`, or implicit `--redo`/`--clean`)"))
      .toBe(true);
  });

  it("call is registered and enforces clean, all, and cache-cli-blocks semantics", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] cli: echo already done\n- [ ] cli: echo next\n", "utf-8");

    const result = await runCli([
      "call",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(2);
    expect(result.logs.some((line) => /Reset 1 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(result.logs.some((line) => /Reset 2 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [ ] cli: echo already done\n- [ ] cli: echo next\n");
  });

  it("call --help includes run-style options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["call", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--clean Shorthand for --redo --reset-after");
    expect(compactHelpOutput).toContain("--all Run all tasks sequentially instead of stopping after one (alias: all)");
    expect(compactHelpOutput).toContain("--cache-cli-blocks Cache `cli` fenced block command output for the duration of this run");
  });

  it("loop --help includes loop and run-style options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["loop", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--cooldown <seconds> Cooldown delay in seconds between iterations");
    expect(compactHelpOutput).toContain("--iterations <n> Stop after N iterations (default: unlimited)");
    expect(compactHelpOutput).toContain("--continue-on-error Continue loop after iteration failure");
    expect(compactHelpOutput).toContain("--worker <pattern> Optional worker pattern override (alternative to -- <command>)");
    expect(compactHelpOutput).toContain("--no-verify Disable verification after task execution");
  });

  it("loop rejects non-wait modes before execution", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "loop",
      "roadmap.md",
      "--mode",
      "tui",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput.includes("invalid --mode value: tui")).toBe(true);
    expect(combinedOutput.includes("allowed: wait")).toBe(true);
    expect(combinedOutput.includes("unknown command")).toBe(false);
  });

  it("do forwards --max-items to bootstrap planning before run-all execution", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "8. Do something.md";
    const markdownFile = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    const workerScriptPath = path.join(workspace, "do-max-items-worker.cjs");
    const planScanMarkerPath = path.join(workspace, ".do-max-items-plan-scan-count");
    const runInvocationMarkerPath = path.join(workspace, ".do-max-items-run-invocations");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const sourcePath = ${JSON.stringify(markdownFile.replace(/\\/g, "/"))};`,
        `const lockPath = ${JSON.stringify(lockPath.replace(/\\/g, "/"))};`,
        `const planScanMarkerPath = ${JSON.stringify(planScanMarkerPath.replace(/\\/g, "/"))};`,
        `const runInvocationMarkerPath = ${JSON.stringify(runInvocationMarkerPath.replace(/\\/g, "/"))};`,
        "const lockCommand = (() => {",
        "  if (!fs.existsSync(lockPath)) {",
        "    return 'missing';",
        "  }",
        "  try {",
        "    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));",
        "    return typeof payload.command === 'string' ? payload.command : 'unknown';",
        "  } catch {",
        "    return 'unreadable';",
        "  }",
        "})();",
        "if (lockCommand === 'plan') {",
        "  const previous = fs.existsSync(planScanMarkerPath) ? Number(fs.readFileSync(planScanMarkerPath, 'utf-8')) : 0;",
        "  const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "  fs.writeFileSync(planScanMarkerPath, String(current));",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (current === 1) {",
        "    fs.writeFileSync(sourcePath, source.trimEnd() + '\\n- [ ] Item one\\n- [ ] Item two\\n', 'utf-8');",
        "    process.exit(0);",
        "  }",
        "  fs.writeFileSync(sourcePath, source.trimEnd() + '\\n- [ ] Should not be added\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
        "if (lockCommand === 'run') {",
        "  const previous = fs.existsSync(runInvocationMarkerPath) ? Number(fs.readFileSync(runInvocationMarkerPath, 'utf-8')) : 0;",
        "  const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "  fs.writeFileSync(runInvocationMarkerPath, String(current));",
        "  process.exit(0);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "do",
      "Seed from do",
      sourceName,
      "--scan-count",
      "5",
      "--max-items",
      "1",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(planScanMarkerPath, "utf-8").trim()).toBe("1");
    expect(Number(fs.readFileSync(runInvocationMarkerPath, "utf-8").trim())).toBeGreaterThan(0);

    const updated = fs.readFileSync(markdownFile, "utf-8");
    expect(updated).toContain("Item one");
    expect(updated).toContain("Item two");
    expect(updated).not.toContain("Should not be added");
  });

  it("do without --max-items keeps bootstrap planning unbounded by item count", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "8. Do something.md";
    const markdownFile = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    const workerScriptPath = path.join(workspace, "do-without-max-items-worker.cjs");
    const planScanMarkerPath = path.join(workspace, ".do-without-max-items-plan-scan-count");
    const runInvocationMarkerPath = path.join(workspace, ".do-without-max-items-run-invocations");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const sourcePath = ${JSON.stringify(markdownFile.replace(/\\/g, "/"))};`,
        `const lockPath = ${JSON.stringify(lockPath.replace(/\\/g, "/"))};`,
        `const planScanMarkerPath = ${JSON.stringify(planScanMarkerPath.replace(/\\/g, "/"))};`,
        `const runInvocationMarkerPath = ${JSON.stringify(runInvocationMarkerPath.replace(/\\/g, "/"))};`,
        "const lockCommand = (() => {",
        "  if (!fs.existsSync(lockPath)) {",
        "    return 'missing';",
        "  }",
        "  try {",
        "    const payload = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));",
        "    return typeof payload.command === 'string' ? payload.command : 'unknown';",
        "  } catch {",
        "    return 'unreadable';",
        "  }",
        "})();",
        "if (lockCommand === 'plan') {",
        "  const previous = fs.existsSync(planScanMarkerPath) ? Number(fs.readFileSync(planScanMarkerPath, 'utf-8')) : 0;",
        "  const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "  fs.writeFileSync(planScanMarkerPath, String(current));",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (current === 1) {",
        "    fs.writeFileSync(sourcePath, source.trimEnd() + '\\n- [ ] Item one\\n- [ ] Item two\\n', 'utf-8');",
        "    process.exit(0);",
        "  }",
        "  fs.writeFileSync(sourcePath, source.trimEnd() + '\\n- [ ] Added on second scan\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
        "if (lockCommand === 'run') {",
        "  const previous = fs.existsSync(runInvocationMarkerPath) ? Number(fs.readFileSync(runInvocationMarkerPath, 'utf-8')) : 0;",
        "  const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "  fs.writeFileSync(runInvocationMarkerPath, String(current));",
        "  process.exit(0);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "do",
      "Seed from do",
      sourceName,
      "--scan-count",
      "2",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(planScanMarkerPath, "utf-8").trim()).toBe("2");
    expect(Number(fs.readFileSync(runInvocationMarkerPath, "utf-8").trim())).toBeGreaterThan(0);

    const updated = fs.readFileSync(markdownFile, "utf-8");
    expect(updated).toContain("Item one");
    expect(updated).toContain("Item two");
    expect(updated).toContain("Added on second scan");
  });

  it("loop forwards run-style options to inner call execution", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "loop-forwarded-worker.cjs");
    fs.writeFileSync(roadmapPath, "- [ ] ship release docs\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      "process.exit(0);\n",
      "utf-8",
    );

    const result = await runCli([
      "loop",
      "roadmap.md",
      "--iterations",
      "1",
      "--cooldown",
      "0",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Loop iteration 1 starting"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: ship release docs"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [ ] ship release docs\n");
  });

  it("loop runs multiple iterations and respects cooldown delay", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "loop-cooldown-worker.cjs");
    const probePath = path.join(workspace, "loop-cooldown-probe.log");
    fs.writeFileSync(roadmapPath, "- [ ] ship release docs\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const probePath = ${JSON.stringify(probePath.replace(/\\/g, "/"))};`,
        "fs.appendFileSync(probePath, String(Date.now()) + '\\n', 'utf-8');",
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "loop",
      "roadmap.md",
      "--iterations",
      "2",
      "--cooldown",
      "1",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    const timestamps = fs.readFileSync(probePath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => Number.parseInt(line, 10))
      .filter((value) => Number.isFinite(value));

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Loop iteration 1 starting"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Loop iteration 2 starting"))).toBe(true);
    expect(timestamps).toHaveLength(2);
    expect((timestamps[1] ?? 0) - (timestamps[0] ?? 0)).toBeGreaterThanOrEqual(900);
  });

  it("call removes stale on-disk cli cache artifacts at startup", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const staleCacheDir = path.join(workspace, ".rundown", "cache", "cli-blocks");
    fs.mkdirSync(staleCacheDir, { recursive: true });
    fs.writeFileSync(path.join(staleCacheDir, "stale-cache.json"), "{\"stale\":true}\n", "utf-8");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo cleanup cache\n", "utf-8");

    const result = await runCli([
      "call",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(staleCacheDir)).toBe(false);
  });

  it("call tears down cli cache artifacts on success", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const cacheDir = path.join(workspace, ".rundown", "cache", "cli-blocks");
    const workerScriptPath = path.join(workspace, "create-cache-success.cjs");

    fs.writeFileSync(roadmapPath, "- [ ] complete task\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const cacheDir = path.join(process.cwd(), '.rundown', 'cache', 'cli-blocks');",
        "fs.mkdirSync(cacheDir, { recursive: true });",
        "fs.writeFileSync(path.join(cacheDir, 'runtime-cache.json'), '{\"ok\":true}', 'utf-8');",
        "console.log('OK');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "call",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("call tears down cli cache artifacts on failure", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const cacheDir = path.join(workspace, ".rundown", "cache", "cli-blocks");
    const workerScriptPath = path.join(workspace, "create-cache-fail.cjs");

    fs.writeFileSync(roadmapPath, "- [ ] fail task\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const cacheDir = path.join(process.cwd(), '.rundown', 'cache', 'cli-blocks');",
        "fs.mkdirSync(cacheDir, { recursive: true });",
        "fs.writeFileSync(path.join(cacheDir, 'runtime-cache.json'), '{\"ok\":false}', 'utf-8');",
        "process.exit(1);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "call",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(1);
    expect(fs.existsSync(cacheDir)).toBe(false);
  });

  it("run --cache-cli-blocks reuses cached CLI expansion results across reached expansion phases", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const cliHitCounterPath = path.join(workspace, "cli-block-hit-count.log");
    const workerScriptPath = path.join(workspace, "verify-ok-worker.cjs");
    const normalizedHitCounterPath = cliHitCounterPath.replace(/\\/g, "/");
    const cliBlockCommand = `node -e \"const fs=require('node:fs');fs.appendFileSync('${normalizedHitCounterPath}','hit\\n','utf-8');console.log('cached-cli-block');\"`;

    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "execute.md"),
      [
        "## Execute",
        "",
        "```cli",
        cliBlockCommand,
        "```",
        "",
        "{{task}}",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, ".rundown", "verify.md"),
      [
        "## Verify",
        "",
        "```cli",
        cliBlockCommand,
        "```",
        "",
        "Return exactly OK when the task is complete.",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      roadmapPath,
      [
        "# Roadmap",
        "",
        "```cli",
        cliBlockCommand,
        "```",
        "",
        "- [ ] Confirm cached CLI blocks",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(workerScriptPath, "console.log('OK');\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--cache-cli-blocks",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    const hitLines = fs.readFileSync(cliHitCounterPath, "utf-8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    expect(hitLines).toHaveLength(1);
  });

  it("discuss --help lists mode, prompt, and lock options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["discuss", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("discuss [options] [source]");
    expect(compactHelpOutput).toContain("interactive discussion session for the next unchecked task or a finished run");
    expect(compactHelpOutput).toContain("--mode <mode> Discuss execution mode: wait, tui");
    expect(compactHelpOutput).toContain("--print-prompt Print the rendered discuss prompt and exit");
    expect(compactHelpOutput).toContain("--trace Enable structured trace output at <config-dir>/runs/<id>/trace.jsonl");
    expect(compactHelpOutput).toContain("--force-unlock Break stale source lockfiles before acquiring discuss locks");
  });

  it("discuss supports --run without requiring <source>", async () => {
    const workspace = makeTempWorkspace();
    const discussTaskMock = vi.fn(async () => 0);

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: vi.fn(async () => 0),
        discussTask: discussTaskMock,
        reverifyTask: vi.fn(async () => 0),
        revertTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        unlockTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
      }),
    }));

    const result = await runCli([
      "discuss",
      "--run",
      "latest",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    vi.doUnmock("../../src/create-app.js");

    expect(result.code).toBe(0);
    expect(discussTaskMock).toHaveBeenCalledTimes(1);
    expect(discussTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "",
      runId: "latest",
      workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
    }));
  });

  it("discuss rejects unknown options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli([
      "discuss",
      "roadmap.md",
      "--show-agent-outputs",
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
    expect(combinedOutput.includes("--show-agent-outputs")).toBe(true);
    expect(combinedOutput.includes("unknown option")).toBe(true);
  });

  it("discuss passes parsed options to the application layer", async () => {
    const workspace = makeTempWorkspace();
    const discussTaskMock = vi.fn(async () => 0);

    vi.doMock("../../src/create-app.js", () => ({
      createApp: () => ({
        runTask: vi.fn(async () => 0),
        discussTask: discussTaskMock,
        reverifyTask: vi.fn(async () => 0),
        revertTask: vi.fn(async () => 0),
        nextTask: vi.fn(async () => 0),
        listTasks: vi.fn(async () => 0),
        planTask: vi.fn(async () => 0),
        unlockTask: vi.fn(async () => 0),
        initProject: vi.fn(async () => 0),
        manageArtifacts: vi.fn(() => 0),
      }),
    }));

    const result = await runCli([
      "discuss",
      "roadmap.md",
      "--mode",
      "wait",
      "--sort",
      "old-first",
      "--dry-run",
      "--print-prompt",
      "--keep-artifacts",
      "--trace",
      "--vars-file",
      ".rundown/custom-vars.json",
      "--var",
      "audience=engineering",
      "--show-agent-output",
      "--force-unlock",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    vi.doUnmock("../../src/create-app.js");

    expect(result.code).toBe(0);
    expect(discussTaskMock).toHaveBeenCalledTimes(1);
    expect(discussTaskMock).toHaveBeenCalledWith(expect.objectContaining({
      source: "roadmap.md",
      mode: "wait",
      sortMode: "old-first",
      dryRun: true,
      printPrompt: true,
      keepArtifacts: true,
      trace: true,
      varsFileOption: ".rundown/custom-vars.json",
      cliTemplateVarArgs: ["audience=engineering"],
      showAgentOutput: true,
      forceUnlock: true,
      workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
    }));
  });

  it("discuss <file> -- <worker> selects next unchecked task and invokes worker in tui mode", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(
      sourcePath,
      [
        "- [x] Already done",
        "- [ ] First pending task",
        "- [ ] Second pending task",
        "",
      ].join("\n"),
      "utf-8",
    );

    const spawnMock = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      process.nextTick(() => {
        child.emit("close", 0);
      });
      return child;
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "discuss",
      sourceName,
      "--keep-artifacts",
      "--verbose",
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [cmd, args, options] = spawnMock.mock.calls[0] as [string, string[], { stdio?: string }];
    expect(["cmd", "node"]).toContain(cmd);
    const stdio = options.stdio;
    const isSupportedStdio = stdio === "ignore"
      || stdio === "inherit"
      || (Array.isArray(stdio) && stdio.join(",") === "inherit,pipe,pipe");
    expect(isSupportedStdio).toBe(true);

    const promptFilePath = args.find((arg) => arg.endsWith(".md"));

    expect(typeof promptFilePath).toBe("string");
    expect(fs.existsSync(promptFilePath!)).toBe(true);

    const renderedPrompt = fs.readFileSync(promptFilePath!, "utf-8");
    expect(renderedPrompt).toContain("## Selected task\n\nFirst pending task");
    expect(renderedPrompt).toContain("- [ ] Second pending task");
    expect(result.logs.some((line) => line.includes("Next task:") && line.includes("First pending task"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Discussion completed."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Discuss turn summary: 1 success, 0 failures."))).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toContain("- [ ] First pending task");
  });

  it("discuss tui on win32 invokes worker in-terminal without cmd start wrapper", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(sourcePath, "- [ ] First pending task\n", "utf-8");

    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const spawnMock = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      process.nextTick(() => {
        child.emit("close", 0);
      });
      return child;
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "discuss",
      sourceName,
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    vi.doUnmock("cross-spawn");
    platformSpy.mockRestore();

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [cmd, args, options] = spawnMock.mock.calls[0] as [string, string[], { stdio?: string }];
    expect(cmd).toBe("node");
    expect(args).not.toContain("/c");
    expect(args).not.toContain("start");
    expect(options.stdio).toBe("inherit");
  });

  it("discuss maps worker failures to CLI exit code 1", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(sourcePath, "- [ ] First pending task\n", "utf-8");

    const spawnMock = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      process.nextTick(() => {
        child.emit("close", 7);
      });
      return child;
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "discuss",
      sourceName,
      "--",
      "node",
      "-e",
      "process.exit(0)",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(result.errors.some((line) => line.includes("Discussion exited with code 7"))).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toContain("- [ ] First pending task");
  });

  it("discuss keeps worker output silent even when --show-agent-output is set", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(sourcePath, "- [ ] First pending task\n", "utf-8");

    const result = await runCli([
      "discuss",
      sourceName,
      "--mode",
      "wait",
      "--show-agent-output",
      "--",
      "node",
      "-e",
      "console.log('discuss worker stdout');console.error('discuss worker stderr');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.stdoutWrites.some((line) => line.includes("discuss worker stdout"))).toBe(false);
    expect(result.stderrWrites.some((line) => line.includes("discuss worker stderr"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Discussion completed."))).toBe(true);
  });

  it("discuss --print-prompt expands cli blocks in discuss templates", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "- [ ] Discuss rollout plan\n", "utf-8");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "discuss.md"),
      [
        "CUSTOM DISCUSS TEMPLATE",
        "```cli",
        "echo discuss-cli-block-output",
        "```",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "discuss",
      "roadmap.md",
      "--print-prompt",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("CUSTOM DISCUSS TEMPLATE")).toBe(true);
    expect(combinedOutput.includes("<command>echo discuss-cli-block-output</command>")).toBe(true);
    expect(combinedOutput.includes("discuss-cli-block-output")).toBe(true);
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
      workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      commitAfterComplete: true,
      commitMode: "per-task",
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
      workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      commitAfterComplete: false,
      commitMode: "per-task",
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
      workerPattern: inferWorkerPatternFromCommand(["opencode", "run"]),
      commitAfterComplete: true,
      commitMode: "per-task",
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

  it("run persists verification failure details in verify phase artifacts while source lock is held", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    fs.writeFileSync(
      sourcePath,
      "- [x] already done\n- [ ] verify selected task mapping\n",
      "utf-8",
    );

    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const hookScript = path.join(workspace, "hook-check-artifacts-lock.mjs");
    fs.writeFileSync(
      hookScript,
      [
        "import fs from \"node:fs\";",
        `const lockPath = ${JSON.stringify(lockPath)};`,
        "console.log('LOCK_EXISTS=' + String(fs.existsSync(lockPath)));",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      sourceName,
      "--only-verify",
      "--no-repair",
      "--keep-artifacts",
      "--on-fail",
      `node ${hookScript.replace(/\\/g, "/")}`,
      "--",
      "node",
      "-e",
      "console.log('NOT_OK: verification mismatch')",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.logs.some((line) => line.includes("LOCK_EXISTS=true"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
    const latestRun = findSavedRunByCommand(workspace, "run");
    expect(latestRun).not.toBeNull();

    const runDir = path.join(workspace, ".rundown", "runs", latestRun!.runId);
    const verifyPhaseMetadataPath = fs.readdirSync(runDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(runDir, entry.name, "metadata.json"))
      .find((metadataPath) => {
        if (!fs.existsSync(metadataPath)) {
          return false;
        }
        const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as { phase?: unknown };
        return metadata.phase === "verify";
      });

    expect(verifyPhaseMetadataPath).toBeDefined();
    const verifyPhaseMetadata = JSON.parse(fs.readFileSync(verifyPhaseMetadataPath!, "utf-8")) as {
      verificationResult?: unknown;
    };
    expect(verifyPhaseMetadata.verificationResult).toBe("verification mismatch");
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

  it("run memory-capture fails fast under an existing source lock and does not persist memory artifacts", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const workerScriptPath = path.join(workspace, "memory-capture-locked-worker.cjs");
    fs.writeFileSync(sourcePath, "- [ ] memory: capture release context\n", "utf-8");
    fs.writeFileSync(workerScriptPath, "console.log('Captured release context');\n", "utf-8");

    const firstRunLock = createLockfileFileLock();
    firstRunLock.acquire(sourcePath, { command: "run" });

    try {
      const result = await runCli([
        "run",
        sourceName,
        "--no-verify",
        "--worker",
        "node",
        workerScriptPath.replace(/\\/g, "/"),
      ], workspace);

      expect(result.code).toBe(1);
      expect(result.errors.some((line) => line.includes("Source file is locked by another rundown process"))).toBe(true);

      const memoryFilePath = path.join(workspace, ".rundown", "roadmap.md.memory.md");
      const memoryIndexPath = path.join(workspace, ".rundown", "memory-index.json");
      expect(fs.existsSync(memoryFilePath)).toBe(false);
      expect(fs.existsSync(memoryIndexPath)).toBe(false);
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
    expect(result.errors.some((line) => line.includes("--commit: not inside a git repository, skipping."))).toBe(true);
  });

  it("run --all file-done commit skips commit with warning outside a git repository and still completes the run", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo one"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo two"))).toBe(true);
    expect(result.errors.some((line) => line.includes("--commit: not inside a git repository, skipping."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo one");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo two");
  });

  it("all alias file-done commit skips commit with warning outside a git repository and still completes the run", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    const result = await runCli([
      "all",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo one"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo two"))).toBe(true);
    expect(result.errors.some((line) => line.includes("--commit: not inside a git repository, skipping."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo one");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [x] cli: echo two");
  });

  it("run --all file-done commit succeeds with exactly one final commit and stores commitSha only on the final saved run artifact", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--keep-artifacts",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Committed:"))).toHaveLength(1);

    const commitDeltaCount = Number(execFileSync("git", ["rev-list", "--count", "HEAD~1..HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim());
    expect(commitDeltaCount).toBe(1);

    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    const runArtifacts = readSavedRunMetadata(workspace)
      .filter((run) => run.commandName === "run" && run.status === "completed");
    expect(runArtifacts.length).toBe(2);

    const runArtifactsWithCommitSha = runArtifacts.filter((run) => typeof run.extra?.commitSha === "string");
    expect(runArtifactsWithCommitSha).toHaveLength(1);
    expect(runArtifactsWithCommitSha[0]?.extra?.commitSha).toBe(headSha);
  });

  it("run --all file-done commit waits for inserted child and remaining tasks before committing", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const roadmapPath = path.join(workspace, sourceName);
    const workerScriptPath = path.join(workspace, "tool-expansion-worker.cjs");
    const childTaskScriptPath = path.join(workspace, "child-task.cjs");
    const finalTaskScriptPath = path.join(workspace, "final-task.cjs");
    const childProbePath = path.join(workspace, "child-task-ran.txt");
    const finalProbePath = path.join(workspace, "final-task-ran.txt");
    const toolTemplatePath = path.join(workspace, ".rundown", "tools", "post-on-gitea.md");

    fs.mkdirSync(path.dirname(toolTemplatePath), { recursive: true });
    fs.writeFileSync(toolTemplatePath, "Request: {{payload}}\nContext:\n{{context}}\n", "utf-8");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] post-on-gitea: report auth flow\n- [ ] cli: node final-task.cjs\n",
      "utf-8",
    );
    fs.writeFileSync(workerScriptPath, "console.log('- [ ] cli: node child-task.cjs');\n", "utf-8");
    fs.writeFileSync(
      childTaskScriptPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(childProbePath.replace(/\\/g, "/"))}, 'ok\\n', 'utf-8');`,
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      finalTaskScriptPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(finalProbePath.replace(/\\/g, "/"))}, 'done\\n', 'utf-8');`,
      ].join("\n"),
      "utf-8",
    );

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "run",
      sourceName,
      "--all",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: report auth flow"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: node child-task.cjs"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: node final-task.cjs"))).toBe(true);
    expect(result.logs.filter((line) => line.includes("Committed:"))).toHaveLength(1);
    expect(fs.existsSync(childProbePath)).toBe(true);
    expect(fs.existsSync(finalProbePath)).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] post-on-gitea: report auth flow",
      "  - [x] cli: node child-task.cjs",
      "- [x] cli: node final-task.cjs",
      "",
    ].join("\n"));

    const commitDeltaCount = Number(execFileSync("git", ["rev-list", "--count", "HEAD~1..HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim());
    expect(commitDeltaCount).toBe(1);

    const statusPorcelain = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(statusPorcelain).toBe("");

    const committedFiles = execFileSync("git", ["show", "--pretty=", "--name-only", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    });
    expect(committedFiles).toContain("roadmap.md");
    expect(committedFiles).toContain("child-task-ran.txt");
    expect(committedFiles).toContain("final-task-ran.txt");

    const headMessage = execFileSync("git", ["log", "-1", "--pretty=%B"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(headMessage).toContain("cli: node final-task.cjs");
  });

  it("run --all file-done commit with --reset-after commits after reset side effects and before lock release", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const roadmapPath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const commitProbePath = path.join(workspace, "commit-observed-state.json");
    const hookObserverPath = path.join(workspace, "pre-commit-observer.cjs");
    const preCommitHookPath = path.join(workspace, ".git", "hooks", "pre-commit");
    fs.writeFileSync(roadmapPath, "- [x] Previously done\n- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    fs.writeFileSync(
      hookObserverPath,
      [
        "const fs = require('node:fs');",
        "const [probePath, observedLockPath, observedSourcePath] = process.argv.slice(2);",
        "const observed = {",
        "  lockExists: fs.existsSync(observedLockPath),",
        "  sourceText: fs.readFileSync(observedSourcePath, 'utf-8'),",
        "};",
        "fs.writeFileSync(probePath, JSON.stringify(observed), 'utf-8');",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      preCommitHookPath,
      [
        "#!/bin/sh",
        `node \"${hookObserverPath.replace(/\\/g, "/")}\" \"${commitProbePath.replace(/\\/g, "/")}\" \"${lockPath}\" \"${roadmapPath.replace(/\\/g, "/")}\"`,
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.chmodSync(preCommitHookPath, 0o755);
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "install pre-commit observer"], { cwd: workspace, stdio: "ignore" });
    if (fs.existsSync(commitProbePath)) {
      fs.rmSync(commitProbePath);
    }

    const result = await runCli([
      "run",
      sourceName,
      "--all",
      "--reset-after",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Committed:"))).toHaveLength(1);
    expect(result.logs.some((line) => /Reset 3 checkbox(?:es)? in /.test(line) && line.includes(sourceName))).toBe(true);
    expect(fs.existsSync(commitProbePath)).toBe(true);

    const observed = JSON.parse(fs.readFileSync(commitProbePath, "utf-8")) as {
      lockExists: boolean;
      sourceText: string;
    };
    expect(observed.lockExists).toBe(true);
    expect(observed.sourceText).toBe("- [ ] Previously done\n- [ ] cli: echo one\n- [ ] cli: echo two\n");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [ ] Previously done\n- [ ] cli: echo one\n- [ ] cli: echo two\n");
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
  });

  it("run --all file-done commit does not create a final commit when execution fails", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo ok\n- [ ] cli: exit 1\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const initialHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);

    const finalHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(finalHeadSha).toBe(initialHeadSha);
  });

  it("run --all file-done commit does not create a final commit on verification failure", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n- [ ] Ship release\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const initialHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--commit",
      "--commit-mode",
      "file-done",
      "--repair-attempts",
      "0",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK: verification mismatch');process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Verification failed"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);

    const finalHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(finalHeadSha).toBe(initialHeadSha);
  });

  (process.env.CI || process.platform === "win32" ? it.skip : it)("run --all file-done commit does not create a final commit when interrupted", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: node -e \"setTimeout(() => process.exit(0), 5000)\"\n- [ ] cli: echo two\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const initialHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    const runPromise = runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    await new Promise((resolve) => setTimeout(resolve, 75));
    try {
      process.emit("SIGINT");
    } catch {
      // Handled by runCli's process.exit interception in test mode.
    }

    const result = await runPromise;

    expect(result.code).toBe(130);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);

    const finalHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(finalHeadSha).toBe(initialHeadSha);
  });

  it("run --all file-done commit does not create a final commit in dry-run mode", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const initialHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--dry-run",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);

    const finalHeadSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim();
    expect(finalHeadSha).toBe(initialHeadSha);
  });

  it("all alias file-done commit succeeds with exactly one final commit", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "all",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo one"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: echo two"))).toBe(true);
    expect(result.logs.filter((line) => line.includes("Committed:"))).toHaveLength(1);

    const commitDeltaCount = Number(execFileSync("git", ["rev-list", "--count", "HEAD~1..HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim());
    expect(commitDeltaCount).toBe(1);
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
    expect(result.errors.some((line) => line.includes("--on-complete hook exited with code 17"))).toBe(true);
  });

  it("run keeps --on-complete hook output visible with hidden agent output by default", async () => {
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

  it("run --all file-done commit exits with 1 before execution when the worktree is dirty", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const otherFilePath = path.join(workspace, "src", "notes.txt");
    const executedMarkerPath = path.join(workspace, "executed.txt");
    fs.mkdirSync(path.dirname(otherFilePath), { recursive: true });
    fs.writeFileSync(roadmapPath, "- [ ] cli: node -e \"require('node:fs').writeFileSync('executed.txt', 'ran')\"\n- [ ] cli: echo two\n", "utf-8");
    fs.writeFileSync(otherFilePath, "before\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    // Simulate existing uncommitted changes before run starts.
    fs.writeFileSync(otherFilePath, "after\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("--commit: working directory is not clean. Commit or stash changes before using --commit."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Task checked:"))).toBe(false);
    expect(fs.existsSync(executedMarkerPath)).toBe(false);

    const roadmap = fs.readFileSync(roadmapPath, "utf-8");
    expect(roadmap).toContain("- [ ] cli: node -e \"require('node:fs').writeFileSync('executed.txt', 'ran')\"");
    expect(roadmap).toContain("- [ ] cli: echo two");
  });

  it("all alias file-done commit exits with 1 before execution when the worktree is dirty", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const otherFilePath = path.join(workspace, "src", "notes.txt");
    const executedMarkerPath = path.join(workspace, "executed.txt");
    fs.mkdirSync(path.dirname(otherFilePath), { recursive: true });
    fs.writeFileSync(roadmapPath, "- [ ] cli: node -e \"require('node:fs').writeFileSync('executed.txt', 'ran')\"\n- [ ] cli: echo two\n", "utf-8");
    fs.writeFileSync(otherFilePath, "before\n", "utf-8");

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    // Simulate existing uncommitted changes before run starts.
    fs.writeFileSync(otherFilePath, "after\n", "utf-8");

    const result = await runCli([
      "all",
      "roadmap.md",
      "--no-verify",
      "--commit",
      "--commit-mode",
      "file-done",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("--commit: working directory is not clean. Commit or stash changes before using --commit."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Task checked:"))).toBe(false);
    expect(fs.existsSync(executedMarkerPath)).toBe(false);

    const roadmap = fs.readFileSync(roadmapPath, "utf-8");
    expect(roadmap).toContain("- [ ] cli: node -e \"require('node:fs').writeFileSync('executed.txt', 'ran')\"");
    expect(roadmap).toContain("- [ ] cli: echo two");
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

  it("run force-prefixed task succeeds on first attempt without retry", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "force-first-attempt-worker.cjs");
    const runLogPath = path.join(workspace, "force-first-attempt-worker.log");

    fs.writeFileSync(roadmapPath, "- [ ] force: implement release docs\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(runLogPath.replace(/\\/g, "/"))}, 'execute\\n', 'utf-8');`,
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Force retry"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Task checked: force: implement release docs"))).toBe(true);
    expect(fs.readFileSync(runLogPath, "utf-8").trim().split("\n").filter(Boolean)).toHaveLength(1);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] force: implement release docs\n");
  });

  it("run force-prefixed task fails then succeeds with retry", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "force-fail-then-succeed-worker.cjs");
    const runLogPath = path.join(workspace, "force-fail-then-succeed-worker.log");
    const attemptsPath = path.join(workspace, "force-fail-then-succeed-worker.attempt");

    fs.writeFileSync(roadmapPath, "- [ ] force: implement release docs\n", "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const runLogPath = ${JSON.stringify(runLogPath.replace(/\\/g, "/"))};`,
        `const attemptsPath = ${JSON.stringify(attemptsPath.replace(/\\/g, "/"))};`,
        "const attempts = fs.existsSync(attemptsPath) ? Number.parseInt(fs.readFileSync(attemptsPath, 'utf-8'), 10) : 0;",
        "const nextAttempt = Number.isFinite(attempts) ? attempts + 1 : 1;",
        "fs.writeFileSync(attemptsPath, String(nextAttempt), 'utf-8');",
        "fs.appendFileSync(runLogPath, `execute:${nextAttempt}\\n`, 'utf-8');",
        "process.exit(nextAttempt === 1 ? 1 : 0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.errors.some((line) => line.includes("Force retry 2 of 2"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: force: implement release docs"))).toBe(true);
    expect(fs.readFileSync(runLogPath, "utf-8").trim().split("\n").filter(Boolean)).toHaveLength(2);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] force: implement release docs\n");
  });

  it("run force: with inline cli task retries failed inline execution", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const inlineScriptPath = path.join(workspace, "force-inline-retry.cjs");
    const attemptsPath = path.join(workspace, "force-inline-retry.attempt");

    fs.writeFileSync(
      roadmapPath,
      `- [ ] force: cli: node ${path.basename(inlineScriptPath)}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      inlineScriptPath,
      [
        "const fs = require('node:fs');",
        `const attemptsPath = ${JSON.stringify(attemptsPath.replace(/\\/g, "/"))};`,
        "const attempts = fs.existsSync(attemptsPath) ? Number.parseInt(fs.readFileSync(attemptsPath, 'utf-8'), 10) : 0;",
        "const nextAttempt = Number.isFinite(attempts) ? attempts + 1 : 1;",
        "fs.writeFileSync(attemptsPath, String(nextAttempt), 'utf-8');",
        "process.exit(nextAttempt === 1 ? 1 : 0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.errors.some((line) => line.includes("Force retry 2 of 2"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: force: cli: node force-inline-retry.cjs"))).toBe(true);
    expect(fs.readFileSync(attemptsPath, "utf-8")).toBe("2");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] force: cli: node force-inline-retry.cjs\n");
  });

  it("run force: verify: task retries verify-only iteration after verification failure", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const verifyAttemptsPath = path.join(workspace, "force-verify.attempt");
    fs.writeFileSync(roadmapPath, "- [ ] force: verify: tests pass\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-repair",
      "--",
      "node",
      "-e",
      `const fs=require('node:fs');const attemptsPath=${JSON.stringify(verifyAttemptsPath.replace(/\\/g, "/"))};const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Verify whether the selected task is complete.')){const attempts=fs.existsSync(attemptsPath)?Number.parseInt(fs.readFileSync(attemptsPath,'utf-8'),10):0;const nextAttempt=Number.isFinite(attempts)?attempts+1:1;fs.writeFileSync(attemptsPath,String(nextAttempt),'utf-8');console.log(nextAttempt===1?'NOT_OK: tests still failing':'OK');process.exit(0);}process.exit(0);`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Execution phase skipped; entering verification phase."))).toBe(true);
    expect(result.errors.some((line) => line.includes("Force retry 2 of 2"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: force: verify: tests pass"))).toBe(true);
    expect(fs.readFileSync(verifyAttemptsPath, "utf-8")).toBe("2");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] force: verify: tests pass\n");
  });

  it("run force retry restarts iteration after inner repair loop exhaustion", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const verifyAttemptsPath = path.join(workspace, "force-verify-repair-exhausted.verify");
    const repairAttemptsPath = path.join(workspace, "force-verify-repair-exhausted.repair");
    fs.writeFileSync(roadmapPath, "- [ ] force: verify: tests pass\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      `const fs=require('node:fs');const verifyAttemptsPath=${JSON.stringify(verifyAttemptsPath.replace(/\\/g, "/"))};const repairAttemptsPath=${JSON.stringify(repairAttemptsPath.replace(/\\/g, "/"))};const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){const attempts=fs.existsSync(repairAttemptsPath)?Number.parseInt(fs.readFileSync(repairAttemptsPath,'utf-8'),10):0;const nextAttempt=Number.isFinite(attempts)?attempts+1:1;fs.writeFileSync(repairAttemptsPath,String(nextAttempt),'utf-8');process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){const attempts=fs.existsSync(verifyAttemptsPath)?Number.parseInt(fs.readFileSync(verifyAttemptsPath,'utf-8'),10):0;const nextAttempt=Number.isFinite(attempts)?attempts+1:1;fs.writeFileSync(verifyAttemptsPath,String(nextAttempt),'utf-8');console.log(nextAttempt<=2?'NOT_OK: tests still failing':'OK');process.exit(0);}process.exit(0);`,
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Execution phase skipped; entering verification phase."))).toBe(true);
    expect(result.errors.some((line) => line.includes("Force retry 2 of 2"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: force: verify: tests pass"))).toBe(true);
    expect(fs.readFileSync(verifyAttemptsPath, "utf-8")).toBe("3");
    expect(fs.readFileSync(repairAttemptsPath, "utf-8")).toBe("1");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] force: verify: tests pass\n");
  });

  it("run trace events correctly distinguish force retries from repair attempts", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const verifyAttemptsPath = path.join(workspace, "force-trace.verify");
    const repairAttemptsPath = path.join(workspace, "force-trace.repair");
    fs.writeFileSync(roadmapPath, "- [ ] force: verify: tests pass\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--repair-attempts",
      "1",
      "--trace",
      "--keep-artifacts",
      "--",
      "node",
      "-e",
      `const fs=require('node:fs');const verifyAttemptsPath=${JSON.stringify(verifyAttemptsPath.replace(/\\/g, "/"))};const repairAttemptsPath=${JSON.stringify(repairAttemptsPath.replace(/\\/g, "/"))};const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){const attempts=fs.existsSync(repairAttemptsPath)?Number.parseInt(fs.readFileSync(repairAttemptsPath,'utf-8'),10):0;const nextAttempt=Number.isFinite(attempts)?attempts+1:1;fs.writeFileSync(repairAttemptsPath,String(nextAttempt),'utf-8');process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){const attempts=fs.existsSync(verifyAttemptsPath)?Number.parseInt(fs.readFileSync(verifyAttemptsPath,'utf-8'),10):0;const nextAttempt=Number.isFinite(attempts)?attempts+1:1;fs.writeFileSync(verifyAttemptsPath,String(nextAttempt),'utf-8');console.log(nextAttempt<=2?'NOT_OK: tests still failing':'OK');process.exit(0);}process.exit(0);`,
    ], workspace);

    expect(result.code).toBe(0);
    const traceEvents = listTraceFiles(workspace)
      .flatMap((tracePath) => fs.readFileSync(tracePath, "utf-8")
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as {
          run_id?: string;
          event_type?: string;
          payload?: Record<string, unknown>;
        }));

    const repairAttemptEvents = traceEvents.filter((event) => event.event_type === "repair.attempt");
    const forceRetryEvents = traceEvents.filter((event) => event.event_type === "force.retry");
    expect(repairAttemptEvents).toHaveLength(1);
    expect(forceRetryEvents).toHaveLength(1);

    const forceRetryEvent = forceRetryEvents[0];
    expect(forceRetryEvent?.payload).toEqual(expect.objectContaining({
      attempt_number: 2,
      max_attempts: 2,
      previous_exit_code: 2,
    }));
    expect(typeof forceRetryEvent?.payload?.previous_run_id).toBe("string");
    expect(forceRetryEvent?.payload?.previous_run_id).not.toBe(forceRetryEvent?.run_id);
  });

  it("run --dry-run with force: logs retries and avoids execution side effects", async () => {
    const workspace = makeTempWorkspace();
    const projectDir = path.join(workspace, "project");
    const sharedConfigDir = path.join(workspace, "shared", ".rundown");
    const templateCliPath = path.join(workspace, "force-dry-run-template-cli.cjs");
    const templateCliAttemptsPath = path.join(workspace, "force-dry-run-template-cli.attempt");
    const workerScriptPath = path.join(workspace, "force-dry-run-worker.cjs");
    const markerPath = path.join(workspace, "force-dry-run-worker-executed.txt");

    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(sharedConfigDir, { recursive: true });

    fs.writeFileSync(
      path.join(projectDir, "roadmap.md"),
      "- [ ] force: implement release docs\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sharedConfigDir, "execute.md"),
      [
        "```cli",
        `node ${templateCliPath.replace(/\\/g, "/")}`,
        "```",
        "",
        "{{task}}",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      templateCliPath,
      [
        "const fs = require('node:fs');",
        `const attemptsPath = ${JSON.stringify(templateCliAttemptsPath.replace(/\\/g, "/"))};`,
        "const attempts = fs.existsSync(attemptsPath) ? Number.parseInt(fs.readFileSync(attemptsPath, 'utf-8'), 10) : 0;",
        "const nextAttempt = Number.isFinite(attempts) ? attempts + 1 : 1;",
        "fs.writeFileSync(attemptsPath, String(nextAttempt), 'utf-8');",
        "process.exit(1);",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(markerPath.replace(/\\/g, "/"))}, 'ran', 'utf-8');`,
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--config-dir",
      "../shared/.rundown",
      "--dry-run",
      "--print-prompt",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], projectDir);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Force retry 2 of 2"))).toBe(true);
    expect(fs.readFileSync(templateCliAttemptsPath, "utf-8")).toBe("2");
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, "roadmap.md"), "utf-8")).toBe("- [ ] force: implement release docs\n");
  });

  it("run returns 1 on execution failure and skips completion side effects", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: node -e \"console.error('inline-cli-fail-detail'); process.exit(1)\"\n",
      "utf-8",
    );

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
    const combinedFailureOutput = stripAnsi([
      ...result.errors,
      ...result.stderrWrites,
      ...result.stdoutWrites,
    ].join("\n"));
    expect(combinedFailureOutput.includes("inline-cli-fail-detail")).toBe(true);
    expect(result.logs.some((line) => line.includes("Committed:"))).toBe(false);
    expect(result.logs.some((line) => line.includes("hook-ran"))).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8"))
      .toContain("- [ ] cli: node -e \"console.error('inline-cli-fail-detail'); process.exit(1)\"");
  });

  it("run routes failing inline CLI stdout/stderr to correct streams and preserves multiline details", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const failingScriptPath = path.join(workspace, "inline-cli-fail-streams.cjs");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: node inline-cli-fail-streams.cjs\n",
      "utf-8",
    );
    fs.writeFileSync(
      failingScriptPath,
      [
        "process.stdout.write('inline-stdout-line-1\\ninline-stdout-line-2\\n');",
        "process.stderr.write('inline-stderr-line-1\\ninline-stderr-line-2\\n');",
        "process.exit(2);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Inline CLI exited with code 2"))).toBe(true);

    const stdoutOutput = stripAnsi([
      ...result.logs,
      ...result.stdoutWrites,
    ].join("\n"));
    const stderrOutput = stripAnsi([
      ...result.errors,
      ...result.stderrWrites,
    ].join("\n"));

    expect(stdoutOutput.includes("inline-stdout-line-1\n")).toBe(true);
    expect(stdoutOutput.includes("inline-stdout-line-2")).toBe(true);
    expect(stderrOutput.includes("inline-stderr-line-1\n")).toBe(true);
    expect(stderrOutput.includes("inline-stderr-line-2")).toBe(true);
    expect(stdoutOutput.includes("inline-stderr-line-1")).toBe(false);
    expect(stderrOutput.includes("inline-stdout-line-1")).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toContain("- [ ] cli: node inline-cli-fail-streams.cjs");
  });

  it("run --all shows failing inline CLI stdout/stderr details with correct stream routing", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const failingScriptPath = path.join(workspace, "inline-cli-fail-all-streams.cjs");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: node inline-cli-fail-all-streams.cjs\n- [ ] cli: echo should-not-run\n",
      "utf-8",
    );
    fs.writeFileSync(
      failingScriptPath,
      [
        "process.stdout.write('all-stdout-line-1\\nall-stdout-line-2\\n');",
        "process.stderr.write('all-stderr-line-1\\nall-stderr-line-2\\n');",
        "process.exit(3);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Inline CLI exited with code 3"))).toBe(true);

    const stdoutOutput = stripAnsi([
      ...result.logs,
      ...result.stdoutWrites,
    ].join("\n"));
    const stderrOutput = stripAnsi([
      ...result.errors,
      ...result.stderrWrites,
    ].join("\n"));

    expect(stdoutOutput.includes("all-stdout-line-1\n")).toBe(true);
    expect(stdoutOutput.includes("all-stdout-line-2")).toBe(true);
    expect(stderrOutput.includes("all-stderr-line-1\n")).toBe(true);
    expect(stderrOutput.includes("all-stderr-line-2")).toBe(true);
    expect(stdoutOutput.includes("all-stderr-line-1")).toBe(false);
    expect(stderrOutput.includes("all-stdout-line-1")).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(
      "- [ ] cli: node inline-cli-fail-all-streams.cjs\n- [ ] cli: echo should-not-run\n",
    );
  });

  it("run and run --all use shared inline CLI failure output without changing failure control flow", async () => {
    const workspace = makeTempWorkspace();
    const failingScriptPath = path.join(workspace, "inline-cli-shared-failure.cjs");
    const singleRunPath = path.join(workspace, "single-run.md");
    const runAllPath = path.join(workspace, "run-all.md");

    fs.writeFileSync(
      failingScriptPath,
      [
        "process.stdout.write('shared-failure-stdout\\n');",
        "process.stderr.write('shared-failure-stderr\\n');",
        "process.exit(7);",
      ].join("\n"),
      "utf-8",
    );

    fs.writeFileSync(singleRunPath, "- [ ] cli: node inline-cli-shared-failure.cjs\n", "utf-8");
    fs.writeFileSync(
      runAllPath,
      "- [ ] cli: node inline-cli-shared-failure.cjs\n- [ ] cli: echo should-not-run\n",
      "utf-8",
    );

    const singleResult = await runCli([
      "run",
      "single-run.md",
      "--no-verify",
    ], workspace);

    expect(singleResult.code).toBe(1);
    expect(singleResult.errors.some((line) => line.includes("Inline CLI exited with code 7"))).toBe(true);
    const singleCombinedOutput = stripAnsi([
      ...singleResult.logs,
      ...singleResult.errors,
      ...singleResult.stdoutWrites,
      ...singleResult.stderrWrites,
    ].join("\n"));
    expect(singleCombinedOutput.includes("shared-failure-stdout")).toBe(true);
    expect(singleCombinedOutput.includes("shared-failure-stderr")).toBe(true);

    const allResult = await runCli([
      "run",
      "run-all.md",
      "--all",
      "--no-verify",
    ], workspace);

    expect(allResult.code).toBe(1);
    expect(allResult.errors.some((line) => line.includes("Inline CLI exited with code 7"))).toBe(true);
    const allCombinedOutput = stripAnsi([
      ...allResult.logs,
      ...allResult.errors,
      ...allResult.stdoutWrites,
      ...allResult.stderrWrites,
    ].join("\n"));
    expect(allCombinedOutput.includes("shared-failure-stdout")).toBe(true);
    expect(allCombinedOutput.includes("shared-failure-stderr")).toBe(true);
    expect(fs.readFileSync(runAllPath, "utf-8")).toBe(
      "- [ ] cli: node inline-cli-shared-failure.cjs\n- [ ] cli: echo should-not-run\n",
    );
    expect(allResult.logs.some((line) => line.includes("should-not-run"))).toBe(false);
  });

  it("run shows stderr-only inline CLI failure details on stderr", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const failingScriptPath = path.join(workspace, "inline-cli-fail-stderr-only.cjs");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: node inline-cli-fail-stderr-only.cjs\n",
      "utf-8",
    );
    fs.writeFileSync(
      failingScriptPath,
      [
        "process.stderr.write('stderr-only-detail\\nsecond-line\\n');",
        "process.exit(4);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Inline CLI exited with code 4"))).toBe(true);

    const stdoutOutput = stripAnsi([
      ...result.logs,
      ...result.stdoutWrites,
    ].join("\n"));
    const stderrOutput = stripAnsi([
      ...result.errors,
      ...result.stderrWrites,
    ].join("\n"));

    expect(stderrOutput.includes("stderr-only-detail\n")).toBe(true);
    expect(stderrOutput.includes("second-line")).toBe(true);
    expect(stdoutOutput.includes("stderr-only-detail")).toBe(false);
  });

  it("run shows stdout-only inline CLI failure details on stdout", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const failingScriptPath = path.join(workspace, "inline-cli-fail-stdout-only.cjs");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: node inline-cli-fail-stdout-only.cjs\n",
      "utf-8",
    );
    fs.writeFileSync(
      failingScriptPath,
      [
        "process.stdout.write('stdout-only-detail\\nsecond-line\\n');",
        "process.exit(5);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Inline CLI exited with code 5"))).toBe(true);

    const stdoutOutput = stripAnsi([
      ...result.logs,
      ...result.stdoutWrites,
    ].join("\n"));
    const stderrOutput = stripAnsi([
      ...result.errors,
      ...result.stderrWrites,
    ].join("\n"));

    expect(stdoutOutput.includes("stdout-only-detail\n")).toBe(true);
    expect(stdoutOutput.includes("second-line")).toBe(true);
    expect(stderrOutput.includes("stdout-only-detail")).toBe(false);
  });

  it("run keeps generic inline CLI failure message when failing command emits no output", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const failingScriptPath = path.join(workspace, "inline-cli-fail-empty-output.cjs");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: node inline-cli-fail-empty-output.cjs\n",
      "utf-8",
    );
    fs.writeFileSync(
      failingScriptPath,
      [
        "process.exit(6);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Inline CLI exited with code 6"))).toBe(true);
  });

  it("run truncates very large inline CLI failure output while preserving tail root-cause lines", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const failingScriptPath = path.join(workspace, "inline-cli-fail-large-output.cjs");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: node inline-cli-fail-large-output.cjs\n",
      "utf-8",
    );
    fs.writeFileSync(
      failingScriptPath,
      [
        "const hugeStdout = 'S'.repeat(2000) + '\\nMIDDLE_STDOUT_OMIT\\n' + 'm'.repeat(7000) + '\\n' + 't'.repeat(5000) + '\\nROOT_STDOUT_LINE\\n';",
        "const hugeStderr = 'E'.repeat(2000) + '\\nMIDDLE_STDERR_OMIT\\n' + 'n'.repeat(7000) + '\\n' + 'u'.repeat(5000) + '\\nROOT_STDERR_LINE\\n';",
        "process.stdout.write(hugeStdout);",
        "process.stderr.write(hugeStderr);",
        "process.exit(8);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Inline CLI exited with code 8"))).toBe(true);

    const stdoutOutput = stripAnsi([
      ...result.logs,
      ...result.stdoutWrites,
    ].join("\n"));
    const stderrOutput = stripAnsi([
      ...result.errors,
      ...result.stderrWrites,
    ].join("\n"));

    expect(stdoutOutput.includes("[Inline CLI stdout truncated: showing first 2000 and last 4000 characters")).toBe(true);
    expect(stdoutOutput.includes("[... omitted ")).toBe(true);
    expect(stdoutOutput.includes("ROOT_STDOUT_LINE")).toBe(true);
    expect(stdoutOutput.includes("MIDDLE_STDOUT_OMIT")).toBe(false);

    expect(stderrOutput.includes("[Inline CLI stderr truncated: showing first 2000 and last 4000 characters")).toBe(true);
    expect(stderrOutput.includes("[... omitted ")).toBe(true);
    expect(stderrOutput.includes("ROOT_STDERR_LINE")).toBe(true);
    expect(stderrOutput.includes("MIDDLE_STDERR_OMIT")).toBe(false);
  });

  it("run returns 2 on verification failure, skips completion side effects, and writes fix annotation", async () => {
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
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] cli: echo hello",
      "  - fix: Verification worker returned empty output. Expected OK or a short failure reason.",
      "",
    ].join("\n"));
  });

  it("run surfaces verification reason after failed repair attempts", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Repair the selected task')){process.exit(0);}if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK: release validation still failing');process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Verification failed after all repair attempts. Task not checked."))).toBe(true);
    expect(result.errors.some((line) => line.includes("Last validation error: release validation still failing"))).toBe(true);
    const stderrOutput = stripAnsi([...result.errors, ...result.stderrWrites].join("\n"));
    expect(stderrOutput.includes("release validation still failing")).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] Write docs",
      "  - fix: release validation still failing",
      "",
    ].join("\n"));
  });

  it("run writes checked task with fix annotation when verification fails", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-repair",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK: release validation still failing');process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(2);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] Write docs",
      "  - fix: release validation still failing",
      "",
    ].join("\n"));
  });

  it("run still returns exit code 2 when verification fails after writing fix annotation", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] Verify release docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-repair",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK: release verification failed');process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(2);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] Verify release docs",
      "  - fix: release verification failed",
      "",
    ].join("\n"));
  });

  it("run writes fallback fix annotation when verification has no details", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-repair",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK:   ');process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(2);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] Write docs",
      "  - fix: Verification failed (no details).",
      "",
    ].join("\n"));
  });

  it("run surfaces the no-details verification sentinel in end-to-end console output", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] Write docs\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-repair",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('Verify whether the selected task is complete.')){console.log('NOT_OK:   ');process.exit(0);}process.exit(0);",
    ], workspace);

    expect(result.code).toBe(2);
    expect(result.errors.some((line) => line.includes("Verification failed after all repair attempts. Task not checked."))).toBe(true);
    expect(result.errors.some((line) => line.includes("Verification failed (no details)."))).toBe(true);
    const stderrOutput = stripAnsi([...result.errors, ...result.stderrWrites].join("\n"));
    expect(stderrOutput.includes("Verification failed (no details).")).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] Write docs",
      "  - fix: Verification failed (no details).",
      "",
    ].join("\n"));
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
    expect(result.logs.some((line) => line.includes("All tasks completed (3 tasks total)"))).toBe(true);
    const content = fs.readFileSync(roadmapPath, "utf-8");
    expect(content).toBe("- [x] cli: echo one\n- [x] cli: echo two\n- [x] cli: echo three\n");
  });

  it("run --all batches composed-prefix parallel children and auto-completes the parent", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "parallel-batch-barrier-worker.mjs");

    fs.writeFileSync(
      roadmapPath,
      [
        "- [ ] profile=fast, parallel: setup release environments",
        "  - [ ] first setup task",
        "  - [ ] second setup task",
      ].join("\n") + "\n",
      "utf-8",
    );

    fs.writeFileSync(
      workerScriptPath,
      [
        "import fs from 'node:fs';",
        "",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        `const sourcePath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "",
        "if (prompt.includes('first setup task')) {",
        "  await new Promise((resolve) => setTimeout(resolve, 500));",
        "  process.exit(0);",
        "}",
        "",
        "if (prompt.includes('second setup task')) {",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (source.includes('  - [x] first setup task')) {",
        "    console.error('Second sibling started after first was already checked.');",
        "    process.exit(92);",
        "  }",
        "  process.exit(0);",
        "}",
        "",
        "console.error('Unexpected task prompt for parallel batching test');",
        "process.exit(91);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Task checked: first setup task"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: second setup task"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] profile=fast, parallel: setup release environments",
      "  - [x] first setup task",
      "  - [x] second setup task",
      "",
    ].join("\n"));
  });

  it("run --all executes runnable siblings in stable document order within each parallel batch", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const orderPath = path.join(workspace, "execution-order.log");
    const workerScriptPath = path.join(workspace, "parallel-order-worker.mjs");

    fs.writeFileSync(
      roadmapPath,
      [
        "- [ ] parallel: batch one",
        "  - [ ] batch-one task 1",
        "  - [ ] batch-one task 2",
        "  - [ ] batch-one task 3",
        "- [ ] parallel: batch two",
        "  - [ ] batch-two task 1",
        "  - [ ] batch-two task 2",
      ].join("\n") + "\n",
      "utf-8",
    );

    fs.writeFileSync(
      workerScriptPath,
      [
        "import fs from 'node:fs';",
        "",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        `const orderPath = ${JSON.stringify(orderPath.replace(/\\/g, "/"))};`,
        "",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        "",
        "const writeOrder = (label) => fs.appendFileSync(orderPath, `${label}\\n`, 'utf-8');",
        "",
        "if (selectedTask === 'batch-one task 1') {",
        "  writeOrder('batch-one task 1');",
        "  await new Promise((resolve) => setTimeout(resolve, 250));",
        "  process.exit(0);",
        "}",
        "",
        "if (selectedTask === 'batch-one task 2') {",
        "  writeOrder('batch-one task 2');",
        "  await new Promise((resolve) => setTimeout(resolve, 50));",
        "  process.exit(0);",
        "}",
        "",
        "if (selectedTask === 'batch-one task 3') {",
        "  writeOrder('batch-one task 3');",
        "  await new Promise((resolve) => setTimeout(resolve, 10));",
        "  process.exit(0);",
        "}",
        "",
        "if (selectedTask === 'batch-two task 1') {",
        "  writeOrder('batch-two task 1');",
        "  await new Promise((resolve) => setTimeout(resolve, 150));",
        "  process.exit(0);",
        "}",
        "",
        "if (selectedTask === 'batch-two task 2') {",
        "  writeOrder('batch-two task 2');",
        "  await new Promise((resolve) => setTimeout(resolve, 20));",
        "  process.exit(0);",
        "}",
        "",
        "console.error('Unexpected task prompt for parallel stable-order test');",
        "process.exit(91);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    const executionOrder = fs.readFileSync(orderPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(executionOrder).toEqual([
      "batch-one task 1",
      "batch-one task 2",
      "batch-one task 3",
      "batch-two task 1",
      "batch-two task 2",
    ]);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] parallel: batch one",
      "  - [x] batch-one task 1",
      "  - [x] batch-one task 2",
      "  - [x] batch-one task 3",
      "- [x] parallel: batch two",
      "  - [x] batch-two task 1",
      "  - [x] batch-two task 2",
      "",
    ].join("\n"));
  });

  it("run --all --commit creates one commit at the parallel parent sync point after children complete", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const roadmapPath = path.join(workspace, sourceName);
    const workerScriptPath = path.join(workspace, "parallel-commit-boundary-worker.mjs");

    fs.writeFileSync(
      roadmapPath,
      [
        "- [ ] parallel: setup release environments",
        "  - [ ] first setup task",
        "  - [ ] second setup task",
      ].join("\n") + "\n",
      "utf-8",
    );

    fs.writeFileSync(
      workerScriptPath,
      [
        "import fs from 'node:fs';",
        "",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        `const sourcePath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "",
        "if (prompt.includes('first setup task')) {",
        "  await new Promise((resolve) => setTimeout(resolve, 500));",
        "  process.exit(0);",
        "}",
        "",
        "if (prompt.includes('second setup task')) {",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (source.includes('  - [x] first setup task')) {",
        "    console.error('Second sibling started after first was already checked.');",
        "    process.exit(92);",
        "  }",
        "  process.exit(0);",
        "}",
        "",
        "console.error('Unexpected task prompt for parallel commit-boundary test');",
        "process.exit(91);",
        "",
      ].join("\n"),
      "utf-8",
    );

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

    const result = await runCli([
      "run",
      sourceName,
      "--all",
      "--no-verify",
      "--commit",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Committed:"))).toHaveLength(1);
    const firstChildCheckedLogIndex = result.logs.findIndex((line) => line.includes("Task checked: first setup task"));
    const secondChildCheckedLogIndex = result.logs.findIndex((line) => line.includes("Task checked: second setup task"));
    const commitLogIndex = result.logs.findIndex((line) => line.includes("Committed:"));
    expect(firstChildCheckedLogIndex).toBeGreaterThanOrEqual(0);
    expect(secondChildCheckedLogIndex).toBeGreaterThanOrEqual(0);
    expect(commitLogIndex).toBeGreaterThan(secondChildCheckedLogIndex);

    const commitDeltaCount = Number(execFileSync("git", ["rev-list", "--count", "HEAD~1..HEAD"], {
      cwd: workspace,
      encoding: "utf-8",
    }).trim());
    expect(commitDeltaCount).toBe(1);

    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] parallel: setup release environments",
      "  - [x] first setup task",
      "  - [x] second setup task",
      "",
    ].join("\n"));
  });

  it("run --all falls back to sequential execution for parallel groups in tui mode", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "parallel-tui-sequential-worker.mjs");

    fs.writeFileSync(
      roadmapPath,
      [
        "- [ ] parallel: setup release environments",
        "  - [ ] first setup task",
        "  - [ ] second setup task",
      ].join("\n") + "\n",
      "utf-8",
    );

    fs.writeFileSync(
      workerScriptPath,
      [
        "import fs from 'node:fs';",
        "",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        `const sourcePath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "",
        "if (prompt.includes('first setup task')) {",
        "  await new Promise((resolve) => setTimeout(resolve, 400));",
        "  process.exit(0);",
        "}",
        "",
        "if (prompt.includes('second setup task')) {",
        "  const source = fs.readFileSync(sourcePath, 'utf-8');",
        "  if (!source.includes('  - [x] first setup task')) {",
        "    console.error('Second sibling started before first was checked.');",
        "    process.exit(92);",
        "  }",
        "  process.exit(0);",
        "}",
        "",
        "console.error('Unexpected task prompt for TUI sequential fallback test');",
        "process.exit(91);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--mode",
      "tui",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Parallel batch selected in TUI mode; executing tasks sequentially."))).toBe(
      true,
    );
    expect(result.logs.some((line) => line.includes("Task checked: first setup task"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: second setup task"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] parallel: setup release environments",
      "  - [x] first setup task",
      "  - [x] second setup task",
      "",
    ].join("\n"));
  });

  it("run --all retries only previously failed children after partial parallel batch failure", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "parallel-partial-failure-worker.mjs");
    const firstAttemptsPath = path.join(workspace, "parallel-first-task.attempt");
    const secondAttemptsPath = path.join(workspace, "parallel-second-task.attempt");

    fs.writeFileSync(
      roadmapPath,
      [
        "- [ ] parallel: setup release environments",
        "  - [ ] first setup task",
        "  - [ ] second setup task",
      ].join("\n") + "\n",
      "utf-8",
    );

    fs.writeFileSync(
      workerScriptPath,
      [
        "import fs from 'node:fs';",
        "",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        `const firstAttemptsPath = ${JSON.stringify(firstAttemptsPath.replace(/\\/g, "/"))};`,
        `const secondAttemptsPath = ${JSON.stringify(secondAttemptsPath.replace(/\\/g, "/"))};`,
        "",
        "if (selectedTask === 'first setup task') {",
        "  const attempts = fs.existsSync(firstAttemptsPath) ? Number.parseInt(fs.readFileSync(firstAttemptsPath, 'utf-8'), 10) : 0;",
        "  const nextAttempt = Number.isFinite(attempts) ? attempts + 1 : 1;",
        "  fs.writeFileSync(firstAttemptsPath, String(nextAttempt), 'utf-8');",
        "  process.exit(0);",
        "}",
        "",
        "if (selectedTask === 'second setup task') {",
        "  const attempts = fs.existsSync(secondAttemptsPath) ? Number.parseInt(fs.readFileSync(secondAttemptsPath, 'utf-8'), 10) : 0;",
        "  const nextAttempt = Number.isFinite(attempts) ? attempts + 1 : 1;",
        "  fs.writeFileSync(secondAttemptsPath, String(nextAttempt), 'utf-8');",
        "  process.exit(nextAttempt === 1 ? 1 : 0);",
        "}",
        "",
        "console.error('Unexpected task prompt for parallel partial-failure retry test');",
        "process.exit(91);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const firstResult = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(firstResult.code).toBe(1);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [ ] parallel: setup release environments",
      "  - [x] first setup task",
      "  - [ ] second setup task",
      "",
    ].join("\n"));
    expect(fs.readFileSync(firstAttemptsPath, "utf-8")).toBe("1");
    expect(fs.readFileSync(secondAttemptsPath, "utf-8")).toBe("1");

    const secondResult = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(secondResult.code).toBe(0);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] parallel: setup release environments",
      "  - [x] first setup task",
      "  - [x] second setup task",
      "",
    ].join("\n"));
    expect(fs.readFileSync(firstAttemptsPath, "utf-8")).toBe("1");
    expect(fs.readFileSync(secondAttemptsPath, "utf-8")).toBe("2");
  });

  it("run --all keeps nested parallel parents unchecked after child failure until retry succeeds", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "nested-parallel-child-failure-worker.mjs");
    const firstChildAttemptsPath = path.join(workspace, "nested-parallel-first-child.attempt");
    const secondChildAttemptsPath = path.join(workspace, "nested-parallel-second-child.attempt");

    fs.writeFileSync(
      roadmapPath,
      [
        "- [ ] parallel: outer setup phase",
        "  - [ ] parallel: inner setup phase",
        "    - [ ] nested child one",
        "    - [ ] nested child two",
      ].join("\n") + "\n",
      "utf-8",
    );

    fs.writeFileSync(
      workerScriptPath,
      [
        "import fs from 'node:fs';",
        "",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        `const firstChildAttemptsPath = ${JSON.stringify(firstChildAttemptsPath.replace(/\\/g, "/"))};`,
        `const secondChildAttemptsPath = ${JSON.stringify(secondChildAttemptsPath.replace(/\\/g, "/"))};`,
        "",
        "if (selectedTask === 'nested child one') {",
        "  const attempts = fs.existsSync(firstChildAttemptsPath) ? Number.parseInt(fs.readFileSync(firstChildAttemptsPath, 'utf-8'), 10) : 0;",
        "  const nextAttempt = Number.isFinite(attempts) ? attempts + 1 : 1;",
        "  fs.writeFileSync(firstChildAttemptsPath, String(nextAttempt), 'utf-8');",
        "  process.exit(0);",
        "}",
        "",
        "if (selectedTask === 'nested child two') {",
        "  const attempts = fs.existsSync(secondChildAttemptsPath) ? Number.parseInt(fs.readFileSync(secondChildAttemptsPath, 'utf-8'), 10) : 0;",
        "  const nextAttempt = Number.isFinite(attempts) ? attempts + 1 : 1;",
        "  fs.writeFileSync(secondChildAttemptsPath, String(nextAttempt), 'utf-8');",
        "  process.exit(nextAttempt === 1 ? 1 : 0);",
        "}",
        "",
        "console.error('Unexpected task prompt for nested parallel child-failure retry test');",
        "process.exit(91);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const firstResult = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(firstResult.code).toBe(1);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [ ] parallel: outer setup phase",
      "  - [ ] parallel: inner setup phase",
      "    - [x] nested child one",
      "    - [ ] nested child two",
      "",
    ].join("\n"));
    expect(fs.readFileSync(firstChildAttemptsPath, "utf-8")).toBe("1");
    expect(fs.readFileSync(secondChildAttemptsPath, "utf-8")).toBe("1");

    const secondResult = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(secondResult.code).toBe(0);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] parallel: outer setup phase",
      "  - [x] parallel: inner setup phase",
      "    - [x] nested child one",
      "    - [x] nested child two",
      "",
    ].join("\n"));
    expect(fs.readFileSync(firstChildAttemptsPath, "utf-8")).toBe("1");
    expect(fs.readFileSync(secondChildAttemptsPath, "utf-8")).toBe("2");
  });

  it("run --all preserves checkbox state when parallel children complete concurrently in the same markdown file", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "parallel-shared-file-completion-worker.mjs");
    const releasePath = path.join(workspace, "parallel-shared-file-release.txt");
    const childCount = 8;
    const childTasks = Array.from({ length: childCount }, (_, index) => `shared-file child ${index + 1}`);

    fs.writeFileSync(
      roadmapPath,
      ["- [ ] parallel: stabilize shared checklist updates", ...childTasks.map((task) => `  - [ ] ${task}`)].join("\n") + "\n",
      "utf-8",
    );

    fs.writeFileSync(releasePath, String(Date.now() + 900), "utf-8");

    fs.writeFileSync(
      workerScriptPath,
      [
        "import fs from 'node:fs';",
        "",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        `const releasePath = ${JSON.stringify(releasePath.replace(/\\/g, "/"))};`,
        "",
        "if (!selectedTask.startsWith('shared-file child ')) {",
        "  console.error('Unexpected task prompt for shared-file concurrent completion test');",
        "  process.exit(91);",
        "}",
        "",
        "const releaseAt = Number.parseInt(fs.readFileSync(releasePath, 'utf-8'), 10);",
        "if (Number.isFinite(releaseAt)) {",
        "  const waitMs = releaseAt - Date.now();",
        "  if (waitMs > 0) {",
        "    await new Promise((resolve) => setTimeout(resolve, waitMs));",
        "  }",
        "}",
        "",
        "await new Promise((resolve) => setTimeout(resolve, 5));",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    const childCheckedLogs = result.logs.filter((line) => line.includes("Task checked: shared-file child "));
    expect(childCheckedLogs).toHaveLength(childCount);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [x] parallel: stabilize shared checklist updates",
      ...childTasks.map((task) => `  - [x] ${task}`),
      "",
    ].join("\n"));
  });

  it.each(["for", "each", "foreach"])(
    "run keeps %s alias lifecycle and metadata format equivalent",
    async (alias) => {
      const workspace = makeTempWorkspace();
      const roadmapPath = path.join(workspace, "roadmap.md");
      const workerScriptPath = path.join(workspace, `${alias}-loop-lifecycle-worker.cjs`);
      const lifecycleLogPath = path.join(workspace, `${alias}-loop-lifecycle.log`);

      fs.writeFileSync(
        roadmapPath,
        [
          `- [ ] ${alias}: Alpha, Beta`,
          "  - [ ] Do once",
          "",
        ].join("\n"),
        "utf-8",
      );

      fs.writeFileSync(
        workerScriptPath,
        [
          "const fs = require('node:fs');",
          "const promptPath = process.argv[process.argv.length - 1];",
          "const prompt = fs.readFileSync(promptPath, 'utf-8');",
          "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
          "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
          `const sourcePath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
          `const lifecycleLogPath = ${JSON.stringify(lifecycleLogPath.replace(/\\/g, "/"))};`,
          "const source = fs.readFileSync(sourcePath, 'utf-8');",
          "const currentMatch = source.match(/for-current\\s*:\\s*(.+)/i);",
          "const current = currentMatch ? currentMatch[1].trim() : 'none';",
          "if (selectedTask === 'Do once') {",
          "  fs.appendFileSync(lifecycleLogPath, `${selectedTask}|${current}\\n`, 'utf-8');",
          "}",
          "process.exit(0);",
          "",
        ].join("\n"),
        "utf-8",
      );

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const result = await runCli([
          "run",
          "roadmap.md",
          "--no-verify",
          "--worker",
          "node",
          workerScriptPath.replace(/\\/g, "/"),
        ], workspace);
        expect(result.code).toBe(0);

        const source = fs.readFileSync(roadmapPath, "utf-8");
        if (source.includes(`- [x] ${alias}: Alpha, Beta`)) {
          break;
        }
      }

      const lifecycle = fs.readFileSync(lifecycleLogPath, "utf-8").split("\n").filter(Boolean);
      expect(lifecycle).toContain("Do once|Alpha");
      expect(lifecycle.length).toBeGreaterThanOrEqual(1);

      const finalSource = fs.readFileSync(roadmapPath, "utf-8");
      expect(finalSource.includes(`- [x] ${alias}: Alpha, Beta`)).toBe(true);
      expect(finalSource).toContain("  - for-item: Alpha");
      expect(finalSource).toContain("  - for-item: Beta");
      expect(finalSource).toContain("  - for-current: Alpha");
      expect(finalSource).not.toContain("each-item:");
      expect(finalSource).not.toContain("foreach-item:");
    },
  );

  it("run resumes interrupted for-loop from persisted for-current and retries only the current-item child", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "for-loop-resume-worker.cjs");
    const lifecycleLogPath = path.join(workspace, "for-loop-resume.log");
    const failureMarkerPath = path.join(workspace, "for-loop-beta-failure.marker");

    fs.writeFileSync(roadmapPath, [
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Beta",
      "  - [x] Do this",
      "  - [ ] Do that",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        `const sourcePath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const lifecycleLogPath = ${JSON.stringify(lifecycleLogPath.replace(/\\/g, "/"))};`,
        `const failureMarkerPath = ${JSON.stringify(failureMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(sourcePath, 'utf-8');",
        "const currentMatch = source.match(/for-current\\s*:\\s*(.+)/i);",
        "const current = currentMatch ? currentMatch[1].trim() : 'none';",
        "if (selectedTask === 'Do this' || selectedTask === 'Do that') {",
        "  fs.appendFileSync(lifecycleLogPath, `${selectedTask}|${current}\\n`, 'utf-8');",
        "}",
        "if (selectedTask === 'Do that' && current === 'Beta' && !fs.existsSync(failureMarkerPath)) {",
        "  fs.writeFileSync(failureMarkerPath, '1', 'utf-8');",
        "  process.exit(1);",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const firstResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(firstResult.code).toBe(1);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Beta",
      "  - [x] Do this",
      "  - [ ] Do that",
      "",
    ].join("\n"));

    let resumed = false;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const retryResult = await runCli([
        "run",
        "roadmap.md",
        "--no-verify",
        "--worker",
        "node",
        workerScriptPath.replace(/\\/g, "/"),
      ], workspace);
      if (retryResult.code === 0) {
        resumed = true;
        break;
      }
    }
    expect(resumed).toBe(true);

    const lifecycle = fs.readFileSync(lifecycleLogPath, "utf-8").split("\n").filter(Boolean);
    expect(lifecycle.filter((line) => line === "Do that|Beta").length).toBeGreaterThanOrEqual(2);
  });

  it("run keeps for-current on loop-item verification failure and resumes deterministically on the same item", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "for-loop-verify-failure-resume-worker.cjs");
    const lifecycleLogPath = path.join(workspace, "for-loop-verify-failure-resume.log");
    const verifyFailureMarkerPath = path.join(workspace, "for-loop-beta-verify-failure.marker");

    fs.writeFileSync(roadmapPath, [
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Beta",
      "  - [x] Do this",
      "  - [ ] Do that",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        `const sourcePath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const lifecycleLogPath = ${JSON.stringify(lifecycleLogPath.replace(/\\/g, "/"))};`,
        `const verifyFailureMarkerPath = ${JSON.stringify(verifyFailureMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(sourcePath, 'utf-8');",
        "const currentMatch = source.match(/for-current\\s*:\\s*(.+)/i);",
        "const current = currentMatch ? currentMatch[1].trim() : 'none';",
        "const isVerifyPhase = prompt.includes('Verify whether the selected task is complete.');",
        "if (selectedTask === 'Do this' || selectedTask === 'Do that') {",
        "  const phase = isVerifyPhase ? 'verify' : 'execute';",
        "  fs.appendFileSync(lifecycleLogPath, `${phase}|${selectedTask}|${current}\\n`, 'utf-8');",
        "}",
        "if (isVerifyPhase && selectedTask === 'Do that' && current === 'Beta' && !fs.existsSync(verifyFailureMarkerPath)) {",
        "  fs.writeFileSync(verifyFailureMarkerPath, '1', 'utf-8');",
        "  console.log('NOT_OK: beta still failing verification');",
        "  process.exit(0);",
        "}",
        "if (isVerifyPhase) {",
        "  console.log('OK');",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const firstResult = await runCli([
      "run",
      "roadmap.md",
      "--no-repair",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(firstResult.code).toBe(2);
    const sourceAfterFailure = fs.readFileSync(roadmapPath, "utf-8");
    expect(sourceAfterFailure).toContain("- [ ] for: Alpha, Beta");
    expect(sourceAfterFailure).toContain("  - for-current: Beta");
    expect(sourceAfterFailure).not.toContain("for-current: Alpha");
    expect(sourceAfterFailure).toContain("  - [x] Do that");
    expect(sourceAfterFailure).toContain("beta still failing verification");

    const retryResult = await runCli([
      "run",
      "roadmap.md",
      "--no-repair",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(retryResult.code).toBe(0);
    const finalSource = fs.readFileSync(roadmapPath, "utf-8");
    expect(finalSource).toContain("- [x] for: Alpha, Beta");
    expect(finalSource).not.toContain("for-current:");

    const lifecycle = fs.readFileSync(lifecycleLogPath, "utf-8").split("\n").filter(Boolean);
    expect(lifecycle).toContain("execute|Do that|Beta");
    expect(lifecycle).toContain("verify|Do that|Beta");
    expect(lifecycle.some((line) => line.includes("|Alpha"))).toBe(false);
  });

  it("run trusts manual for-item metadata and preserves stale for-current during single-pass execution", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "for-loop-manual-metadata-worker.cjs");
    const lifecycleLogPath = path.join(workspace, "for-loop-manual-metadata.log");

    fs.writeFileSync(roadmapPath, [
      "- [ ] for: Payload Alpha, Payload Beta",
      "  - for-item: Manual One",
      "  - for-item: Manual Two",
      "  - for-current: Missing Cursor",
      "  - [ ] Do once",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        `const sourcePath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const lifecycleLogPath = ${JSON.stringify(lifecycleLogPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(sourcePath, 'utf-8');",
        "const currentMatch = source.match(/for-current\\s*:\\s*(.+)/i);",
        "const current = currentMatch ? currentMatch[1].trim() : 'none';",
        "if (selectedTask === 'Do once') {",
        "  fs.appendFileSync(lifecycleLogPath, `${selectedTask}|${current}\\n`, 'utf-8');",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(lifecycleLogPath, "utf-8").trim()).toBe("Do once|Missing Cursor");
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [ ] for: Payload Alpha, Payload Beta",
      "  - for-item: Manual One",
      "  - for-item: Manual Two",
      "  - for-current: Missing Cursor",
      "  - [x] Do once",
      "",
    ].join("\n"));
  });

  it("run fails fast for loop parents without checkbox children, including resume-style reruns", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "for-loop-no-children-worker.cjs");
    const workerProbePath = path.join(workspace, "for-loop-no-children.probe");

    fs.writeFileSync(roadmapPath, [
      "- [ ] for: Alpha, Beta",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const probePath = ${JSON.stringify(workerProbePath.replace(/\\/g, "/"))};`,
        "fs.appendFileSync(probePath, 'worker-invoked\\n', 'utf-8');",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const firstResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(firstResult.code).toBe(1);
    expect(firstResult.errors.some((line) => line.includes("For loop task requires nested checkbox child tasks."))).toBe(true);
    expect(fs.existsSync(workerProbePath)).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [ ] for: Alpha, Beta\n");

    fs.writeFileSync(roadmapPath, [
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Beta",
      "",
    ].join("\n"), "utf-8");

    const resumedResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(resumedResult.code).toBe(1);
    expect(resumedResult.errors.some((line) => line.includes("For loop task requires nested checkbox child tasks."))).toBe(true);
    expect(fs.existsSync(workerProbePath)).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe([
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Beta",
      "",
    ].join("\n"));
  });

  it("run fails fast when a loop has only metadata/plain sub-items and no checkbox children", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "for-loop-no-checkbox-children-worker.cjs");
    const workerProbePath = path.join(workspace, "for-loop-no-checkbox-children.probe");

    const source = [
      "- [ ] for: Alpha, Beta",
      "  - for-item: Alpha",
      "  - for-item: Beta",
      "  - for-current: Alpha",
      "  - note: metadata only",
      "",
    ].join("\n");

    fs.writeFileSync(roadmapPath, source, "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const probePath = ${JSON.stringify(workerProbePath.replace(/\\/g, "/"))};`,
        "fs.appendFileSync(probePath, 'worker-invoked\\n', 'utf-8');",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("For loop task requires nested checkbox child tasks."))).toBe(true);
    expect(fs.existsSync(workerProbePath)).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(source);
  });

  it("run loop --redo --all resets checked loop tasks and reruns loop children", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "loop-redo-marker.txt");
    const workerScriptPath = path.join(workspace, "loop-redo-worker.cjs");

    fs.writeFileSync(
      roadmapPath,
      [
        "- [x] for: Alpha",
        "  - for-item: Alpha",
        "  - for-current: Alpha",
        "  - [x] Do once",
        "",
      ].join("\n"),
      "utf-8",
    );

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        `const markerPath = ${JSON.stringify(markerPath.replace(/\\/g, "/"))};`,
        "if (selectedTask === 'Do once') {",
        "  fs.appendFileSync(markerPath, 'redo\\n', 'utf-8');",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--redo",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => /Reset 2 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(fs.readFileSync(markerPath, "utf-8")).toBe("redo\n");

    const finalSource = fs.readFileSync(roadmapPath, "utf-8");
    expect(finalSource).toContain("- [x] for: Alpha");
    expect(finalSource).toContain("  - [x] Do once");
  });

  it("run loop --reset-after leaves loop checkboxes unchecked after execution", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "loop-reset-after-marker.txt");
    const workerScriptPath = path.join(workspace, "loop-reset-after-worker.cjs");

    fs.writeFileSync(
      roadmapPath,
      [
        "- [ ] for: Alpha",
        "  - [ ] Do once",
        "",
      ].join("\n"),
      "utf-8",
    );

    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "const selectedTaskMatch = prompt.match(/## Selected task\\n\\n(.+)/);",
        "const selectedTask = selectedTaskMatch ? selectedTaskMatch[1].trim() : '';",
        `const markerPath = ${JSON.stringify(markerPath.replace(/\\/g, "/"))};`,
        "if (selectedTask === 'Do once') {",
        "  fs.appendFileSync(markerPath, 'reset-after\\n', 'utf-8');",
        "}",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--reset-after",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(markerPath, "utf-8")).toBe("reset-after\n");

    const finalSource = fs.readFileSync(roadmapPath, "utf-8");
    expect(finalSource).toContain("- [ ] for: Alpha");
    expect(finalSource).toContain("  - [ ] Do once");
    expect(finalSource).not.toContain("[x]");
  });

  it("run loop --redo --dry-run does not execute loop children or mutate markdown", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "loop-redo-dry-run-marker.txt");
    const workerScriptPath = path.join(workspace, "loop-redo-dry-run-worker.cjs");
    const initialMarkdown = [
      "- [ ] for: Alpha",
      "  - for-item: Alpha",
      "  - for-current: Alpha",
      "  - [x] Do once",
      "",
    ].join("\n");

    fs.writeFileSync(roadmapPath, initialMarkdown, "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const markerPath = ${JSON.stringify(markerPath.replace(/\\/g, "/"))};`,
        "fs.appendFileSync(markerPath, 'dry-run\\n', 'utf-8');",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--redo",
      "--all",
      "--dry-run",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Dry run — would reset checkboxes (pre-run) in:") && line.includes("roadmap.md"))).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(initialMarkdown);
  });

  it("run loop --print-prompt preserves source and does not execute worker", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "loop-print-prompt-marker.txt");
    const workerScriptPath = path.join(workspace, "loop-print-prompt-worker.cjs");
    const initialMarkdown = [
      "- [ ] for: Alpha",
      "  - for-item: Alpha",
      "  - for-current: Alpha",
      "  - [ ] Do once",
      "",
    ].join("\n");

    fs.writeFileSync(roadmapPath, initialMarkdown, "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const markerPath = ${JSON.stringify(markerPath.replace(/\\/g, "/"))};`,
        "fs.appendFileSync(markerPath, 'print-prompt\\n', 'utf-8');",
        "process.exit(0);",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--print-prompt",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Do once"))).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(initialMarkdown);
  });

  it("run --redo --all resets checked tasks before execution and runs all tasks", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "redo-all-worker.mjs");
    fs.writeFileSync(roadmapPath, "- [x] Draft release notes\n- [ ] Publish release\n", "utf-8");
    fs.writeFileSync(workerScriptPath, "process.exit(0);\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--redo",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => /Reset 1 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(2);
    expect(result.logs.some((line) => line.includes("All tasks completed (2 tasks total)"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] Draft release notes\n- [x] Publish release\n");
  });

  it("run --redo removes prior trace statistics before re-inserting updated fields", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const configDir = path.join(workspace, ".rundown");
    const configPath = path.join(configDir, "config.json");
    const workerScriptPath = path.join(workspace, "redo-trace-stats-worker.mjs");

    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(roadmapPath, "- [ ] Ship release\n", "utf-8");
    fs.writeFileSync(workerScriptPath, "process.exit(0);\n", "utf-8");

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        traceStatistics: {
          enabled: true,
          fields: ["total_time", "tokens_estimated"],
        },
      }, null, 2),
      "utf-8",
    );

    const firstResult = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--trace-stats",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(firstResult.code).toBe(0);
    const afterFirstRun = fs.readFileSync(roadmapPath, "utf-8");
    expect(afterFirstRun).toContain("- [x] Ship release");
    expect(afterFirstRun).toMatch(/\n\s+- total time: (?:<1s|\d+s)\n/);
    expect(afterFirstRun).toMatch(/\n\s+- tokens estimated: \d+\n/);
    expect(afterFirstRun).not.toMatch(/\n\s+- execution: (?:<1s|\d+s)\n/);

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        traceStatistics: {
          enabled: true,
          fields: ["total_time", "execution_time"],
        },
      }, null, 2),
      "utf-8",
    );

    const secondResult = await runCli([
      "run",
      "roadmap.md",
      "--redo",
      "--no-verify",
      "--trace-stats",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(secondResult.code).toBe(0);
    expect(secondResult.logs.some((line) => /Reset 1 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(
      true,
    );

    const afterSecondRun = fs.readFileSync(roadmapPath, "utf-8");
    expect(afterSecondRun).toContain("- [x] Ship release");
    expect(afterSecondRun).toMatch(/\n\s+- total time: (?:<1s|\d+s)\n/);
    expect(afterSecondRun).toMatch(/\n\s+- execution: (?:<1s|\d+s)\n/);
    expect(afterSecondRun).not.toContain("tokens estimated:");

    const totalTimeMatches = afterSecondRun.match(/\n\s+- total time: (?:<1s|\d+s)\n/g) ?? [];
    const executionMatches = afterSecondRun.match(/\n\s+- execution: (?:<1s|\d+s)\n/g) ?? [];
    expect(totalTimeMatches).toHaveLength(1);
    expect(executionMatches).toHaveLength(1);
  });

  it("run with glob source and --redo resets checked tasks in all resolved files", async () => {
    const workspace = makeTempWorkspace();
    const sourceGlob = "projects/*/roadmap.md";
    const alphaDir = path.join(workspace, "projects", "alpha");
    const betaDir = path.join(workspace, "projects", "beta");
    const alphaSourcePath = path.join(alphaDir, "roadmap.md");
    const betaSourcePath = path.join(betaDir, "roadmap.md");
    const workerScriptPath = path.join(workspace, "redo-multi-worker.mjs");

    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(alphaSourcePath, "- [x] Alpha done\n- [ ] Alpha next\n", "utf-8");
    fs.writeFileSync(betaSourcePath, "- [x] Beta done\n- [ ] Beta next\n", "utf-8");
    fs.writeFileSync(workerScriptPath, "process.exit(0);\n", "utf-8");

    const result = await runCli([
      "run",
      sourceGlob,
      "--redo",
      "--all",
      "--no-verify",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => /Reset 1 checkbox(?:es)? in /.test(line) && line.includes("projects/alpha/roadmap.md"))).toBe(true);
    expect(result.logs.some((line) => /Reset 1 checkbox(?:es)? in /.test(line) && line.includes("projects/beta/roadmap.md"))).toBe(true);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(4);
    expect(result.logs.some((line) => line.includes("All tasks completed (4 tasks total)"))).toBe(true);
    expect(fs.readFileSync(alphaSourcePath, "utf-8")).toBe("- [x] Alpha done\n- [x] Alpha next\n");
    expect(fs.readFileSync(betaSourcePath, "utf-8")).toBe("- [x] Beta done\n- [x] Beta next\n");
  });

  it("run --redo --dry-run leaves checkbox state unchanged", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const initialMarkdown = "- [x] cli: echo one\n- [ ] cli: echo two\n";
    fs.writeFileSync(roadmapPath, initialMarkdown, "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--redo",
      "--dry-run",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Dry run — would reset checkboxes (pre-run) in:") && line.includes("roadmap.md"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(initialMarkdown);
  });

  it("run --redo --only-verify exits with an error and does not mutate checkbox state", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const initialMarkdown = "- [x] cli: echo one\n- [ ] cli: echo two\n";
    fs.writeFileSync(roadmapPath, initialMarkdown, "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--redo",
      "--only-verify",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("cannot be combined with --only-verify"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(initialMarkdown);
  });

  it("run --reset-after leaves file with all checkboxes unchecked after run", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] Previously done\n- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--reset-after",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(2);
    expect(result.logs.some((line) => /Reset 3 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [ ] Previously done\n- [ ] cli: echo one\n- [ ] cli: echo two\n");
  });

  it("run --redo --reset-after resets before execution and leaves file unchecked after completion", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] cli: echo already done\n- [ ] cli: echo one\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--redo",
      "--reset-after",
      "--all",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(2);
    expect(result.logs.some((line) => /Reset 1 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(result.logs.some((line) => /Reset 2 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [ ] cli: echo already done\n- [ ] cli: echo one\n");
  });

  it("run --clean behaves like --redo --reset-after and leaves file unchecked after completion", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] cli: echo already done\n- [ ] cli: echo one\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--clean",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(2);
    expect(result.logs.some((line) => /Reset 1 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(result.logs.some((line) => /Reset 2 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [ ] cli: echo already done\n- [ ] cli: echo one\n");
  });

  it("run --redo composes with --keep-artifacts and executes all tasks", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] cli: echo first\n- [ ] cli: echo second\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--redo",
      "--keep-artifacts",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("--redo implies --all"))).toBe(true);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(2);
    expect(result.logs.some((line) => line.includes("Runtime artifacts saved at"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [x] cli: echo first\n- [x] cli: echo second\n");

    const savedRuns = readSavedRunMetadata(workspace)
      .filter((run) => run.commandName === "run");
    expect(savedRuns.length).toBeGreaterThan(0);
    expect(savedRuns.every((run) => run.status === "completed")).toBe(true);
  });

  it("run --reset-after composes with --keep-artifacts and leaves file clean", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [x] Previously done\n- [ ] cli: echo one\n- [ ] cli: echo two\n", "utf-8");

    const result = await runCli([
      "run",
      "roadmap.md",
      "--all",
      "--reset-after",
      "--keep-artifacts",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => /Reset 3 checkbox(?:es)? in /.test(line) && line.includes("roadmap.md"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Runtime artifacts saved at"))).toBe(true);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe("- [ ] Previously done\n- [ ] cli: echo one\n- [ ] cli: echo two\n");

    const savedRuns = readSavedRunMetadata(workspace)
      .filter((run) => run.commandName === "run");
    expect(savedRuns.length).toBeGreaterThan(0);
    expect(savedRuns.every((run) => run.status === "completed")).toBe(true);
  });

  it("all completes multiple inline CLI tasks sequentially", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(roadmapPath, "- [ ] cli: echo one\n- [ ] cli: echo two\n- [ ] cli: echo three\n", "utf-8");

    const result = await runCli([
      "all",
      "roadmap.md",
      "--no-verify",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(3);
    expect(result.logs.some((line) => line.includes("All tasks completed (3 tasks total)"))).toBe(true);
    const content = fs.readFileSync(roadmapPath, "utf-8");
    expect(content).toBe("- [x] cli: echo one\n- [x] cli: echo two\n- [x] cli: echo three\n");
  });

  it("all advances past repaired inline rundown research tasks for two documents", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    const researchListPath = path.join(migrationsDir, "Research.md");
    const docOnePath = path.join(migrationsDir, "doc-one.md");
    const docTwoPath = path.join(migrationsDir, "doc-two.md");
    const workerOnePath = path.join(migrationsDir, "research-worker-one.cjs");
    const workerTwoPath = path.join(migrationsDir, "research-worker-two.cjs");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      researchListPath,
      [
        `- [ ] cli: rundown research "doc-one.md" --worker "node ${path.basename(workerOnePath)}"`,
        `- [ ] cli: rundown research "doc-two.md" --worker "node ${path.basename(workerTwoPath)}"`,
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(docOnePath, "# Doc One\n\nSeed one.\n", "utf-8");
    fs.writeFileSync(docTwoPath, "# Doc Two\n\nSeed two.\n", "utf-8");

    fs.writeFileSync(workerOnePath, [
      "const fs = require('node:fs');",
      "const promptPath = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      `const repairedMarkerPath = ${JSON.stringify(path.join(migrationsDir, "doc-one.repaired").replace(/\\/g, "/"))};`,
      `const docPath = ${JSON.stringify(docOnePath.replace(/\\/g, "/"))};`,
      "if (prompt.includes('Repair the selected task')) {",
      "  fs.writeFileSync(repairedMarkerPath, '1', 'utf-8');",
      "  fs.writeFileSync(docPath, '# Doc One\\n\\nSeed one.\\n\\nExpanded by repair one.\\n', 'utf-8');",
      "  console.log('repair: doc one updated');",
      "  process.exit(0);",
      "}",
      "if (prompt.includes('Verify whether the selected task is complete.')) {",
      "  if (fs.existsSync(repairedMarkerPath)) {",
      "    console.log('OK');",
      "  } else {",
      "    console.log('NOT_OK: artifact contains worker chatter and selected task is still unchecked in `migrations/Research.md` line 1.');",
      "  }",
      "  process.exit(0);",
      "}",
      "console.log('worker chatter from initial research execution');",
    ].join("\n"), "utf-8");

    fs.writeFileSync(workerTwoPath, [
      "const fs = require('node:fs');",
      "const promptPath = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      `const repairedMarkerPath = ${JSON.stringify(path.join(migrationsDir, "doc-two.repaired").replace(/\\/g, "/"))};`,
      `const docPath = ${JSON.stringify(docTwoPath.replace(/\\/g, "/"))};`,
      "if (prompt.includes('Repair the selected task')) {",
      "  fs.writeFileSync(repairedMarkerPath, '1', 'utf-8');",
      "  fs.writeFileSync(docPath, '# Doc Two\\n\\nSeed two.\\n\\nExpanded by repair two.\\n', 'utf-8');",
      "  console.log('repair: doc two updated');",
      "  process.exit(0);",
      "}",
      "if (prompt.includes('Verify whether the selected task is complete.')) {",
      "  if (fs.existsSync(repairedMarkerPath)) {",
      "    console.log('OK');",
      "  } else {",
      "    console.log('NOT_OK: artifact contains worker chatter and selected task is still unchecked in `migrations/Research.md` line 2.');",
      "  }",
      "  process.exit(0);",
      "}",
      "console.log('worker chatter from initial research execution');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "all",
      "migrations/Research.md",
      "--repair-attempts",
      "1",
      "--",
      "node",
      "-e",
      [
        "const fs=require('node:fs');",
        "const p=process.argv[process.argv.length-1];",
        "const prompt=fs.readFileSync(p,'utf-8');",
        `const oneMarker=${JSON.stringify(path.join(migrationsDir, "doc-one.repaired").replace(/\\/g, "/"))};`,
        `const twoMarker=${JSON.stringify(path.join(migrationsDir, "doc-two.repaired").replace(/\\/g, "/"))};`,
        "const isDocOne=prompt.includes('doc-one.md');",
        "const isDocTwo=prompt.includes('doc-two.md');",
        "if(prompt.includes('Repair the selected task')){",
        "  if(isDocOne){fs.writeFileSync(oneMarker,'1','utf-8');console.log('run repair one');process.exit(0);}",
        "  if(isDocTwo){fs.writeFileSync(twoMarker,'1','utf-8');console.log('run repair two');process.exit(0);}",
        "  process.exit(0);",
        "}",
        "if(prompt.includes('Verify whether the selected task is complete.')){",
        "  if(isDocOne && fs.existsSync(oneMarker)){console.log('OK');process.exit(0);}",
        "  if(isDocTwo && fs.existsSync(twoMarker)){console.log('OK');process.exit(0);}",
        "  const line=isDocOne?1:isDocTwo?2:1;",
        "  console.log('NOT_OK: artifact contains worker chatter and selected task is still unchecked in `migrations/Research.md` line '+line+'.');",
        "  process.exit(0);",
        "}",
        "if(prompt.includes('Executing inline CLI:')||prompt.includes('cli: rundown research')){process.exit(0);}",
        "process.exit(0);",
      ].join(""),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(2);
    expect(result.logs.some((line) => line.includes("Task checked: cli: rundown research \"doc-one.md\""))).toBe(true);
    expect(result.logs.some((line) => line.includes("Task checked: cli: rundown research \"doc-two.md\""))).toBe(true);
    expect(fs.readFileSync(researchListPath, "utf-8")).toContain("- [x] cli: rundown research \"doc-one.md\"");
    expect(fs.readFileSync(researchListPath, "utf-8")).toContain("- [x] cli: rundown research \"doc-two.md\"");
    expect(result.logs.some((line) => line.includes("Repair succeeded after 1 attempt(s)."))).toBe(true);
    expect(result.logs.some((line) => line.includes("[1/2]") && line.includes("doc-one.md"))).toBe(true);
    expect(result.logs.some((line) => line.includes("[2/2]") && line.includes("doc-two.md"))).toBe(true);
  });

  it("run --all stops on failure and preserves failure exit code", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(
      roadmapPath,
      "- [ ] cli: echo ok\n- [ ] cli: node -e \"console.error('run-all-inline-cli-failed'); process.exit(1)\"\n- [ ] cli: echo unreachable\n",
      "utf-8",
    );

    const result = await runCli([
      "run",
      "roadmap.md",
      "--no-verify",
      "--all",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedFailureOutput = stripAnsi([
      ...result.errors,
      ...result.stderrWrites,
      ...result.stdoutWrites,
    ].join("\n"));
    expect(combinedFailureOutput.includes("run-all-inline-cli-failed")).toBe(true);
    expect(result.logs.filter((line) => line.includes("Task checked:")).length).toBe(1);
    const content = fs.readFileSync(roadmapPath, "utf-8");
    expect(content).toContain("- [x] cli: echo ok\n");
    expect(content).toContain("- [ ] cli: node -e \"console.error('run-all-inline-cli-failed'); process.exit(1)\"\n");
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

  it("run keeps --on-fail hook output visible with hidden agent output by default", async () => {
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

  it("root invocation falls back to static help in non-interactive terminals", async () => {
    const workspace = makeTempWorkspace();

    const result = await withTerminalTty(false, () => runCli([], workspace));

    expect(result.code).toBe(0);
    const compactHelpOutput = [...result.logs, ...result.stdoutWrites].join("\n").replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("Usage: rundown");
    expect(compactHelpOutput).toContain("Find the next unchecked TODO and execute it");

    expectGlobalOutputLogInvocationEntries(workspace, {
      command: "rundown",
      argv: [],
      cwd: workspace,
    });
  });

  it("root invocation launches live help session in interactive terminals when a help worker is configured", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), JSON.stringify({
      workers: {
        tui: ["node", "-e", "process.exit(0)"],
      },
    }, null, 2), "utf-8");

    const spawnMock = vi.fn().mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = vi.fn();
      process.nextTick(() => {
        child.emit("close", 0);
      });
      return child;
    });

    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await withTerminalTty(true, () => runCli([], workspace));

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, options] = spawnMock.mock.calls[0] as [string, string[], { stdio?: string }];
    expect(cmd).toBe("node");
    expect(options.stdio).toBe("inherit");
    expect(args.some((arg) => arg.endsWith(".md"))).toBe(true);
    expect(result.stdoutWrites.join("\n").includes("Usage: rundown")).toBe(false);
  });

  it("root invocation honors --config-dir for help worker config and help template discovery", async () => {
    const workspace = makeTempWorkspace();
    const customConfigDir = path.join(workspace, "custom-config");
    const workspaceConfigDir = path.join(workspace, ".rundown");
    const workerScriptPath = path.join(workspace, "capture-help-prompt.cjs");
    const promptCapturePath = path.join(workspace, "captured-help-prompt.txt");

    fs.mkdirSync(customConfigDir, { recursive: true });
    fs.writeFileSync(path.join(customConfigDir, "config.json"), JSON.stringify({
      workers: {
        tui: ["node", workerScriptPath.replace(/\\/g, "/")],
      },
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(customConfigDir, "help.md"), [
      "# Custom Help Template",
      "",
      "marker: CONFIG_DIR_OVERRIDE_MARKER",
      "cwd={{workingDirectory}}",
    ].join("\n"), "utf-8");

    fs.mkdirSync(workspaceConfigDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceConfigDir, "config.json"), JSON.stringify({
      workers: {
        tui: ["node", "-e", "process.exit(12)"],
      },
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(workspaceConfigDir, "help.md"), "marker: WORKSPACE_CONFIG_MARKER\n", "utf-8");

    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      "const promptPath = process.argv[process.argv.length - 1];",
      `const capturePath = ${JSON.stringify(promptCapturePath.replace(/\\/g, "/"))};`,
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      "fs.writeFileSync(capturePath, prompt, 'utf-8');",
      "process.exit(0);",
      "",
    ].join("\n"), "utf-8");

    const result = await withTerminalTty(true, () => runCli([
      "--config-dir",
      customConfigDir,
    ], workspace));

    expect(result.code).toBe(0);
    expect(fs.existsSync(promptCapturePath)).toBe(true);
    const capturedPrompt = fs.readFileSync(promptCapturePath, "utf-8");
    expect(capturedPrompt).toContain("CONFIG_DIR_OVERRIDE_MARKER");
    expect(capturedPrompt).not.toContain("WORKSPACE_CONFIG_MARKER");
    expect(result.stdoutWrites.join("\n").includes("Usage: rundown")).toBe(false);
  });

  it("root interactive help expands rundown --help --everything in help templates", async () => {
    const workspace = makeTempWorkspace();
    const customConfigDir = path.join(workspace, "custom-config");
    const workerScriptPath = path.join(workspace, "capture-help-prompt-from-cli-block.cjs");
    const promptCapturePath = path.join(workspace, "captured-help-prompt-from-cli-block.txt");

    fs.mkdirSync(customConfigDir, { recursive: true });
    fs.writeFileSync(path.join(customConfigDir, "config.json"), JSON.stringify({
      workers: {
        tui: ["node", workerScriptPath.replace(/\\/g, "/")],
      },
    }, null, 2), "utf-8");
    fs.writeFileSync(path.join(customConfigDir, "help.md"), [
      "# Help Template",
      "",
      "before-cli-help-output",
      "```cli",
      "rundown --help --everything",
      "```",
      "after-cli-help-output",
      "",
    ].join("\n"), "utf-8");

    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      "const promptPath = process.argv[process.argv.length - 1];",
      `const capturePath = ${JSON.stringify(promptCapturePath.replace(/\\/g, "/"))};`,
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      "fs.writeFileSync(capturePath, prompt, 'utf-8');",
      "process.exit(0);",
      "",
    ].join("\n"), "utf-8");

    const result = await withTerminalTty(true, () => runCli([
      "--config-dir",
      customConfigDir,
    ], workspace));

    expect(result.code).toBe(0);
    expect(fs.existsSync(promptCapturePath)).toBe(true);
    const capturedPrompt = fs.readFileSync(promptCapturePath, "utf-8");
    expect(capturedPrompt).toContain("before-cli-help-output");
    expect(capturedPrompt).toContain("<command>rundown --help --everything</command>");
    expect(capturedPrompt).toContain("Usage: rundown [options] [command]");
    expect(capturedPrompt).toContain("Commands:\n");
    expect(capturedPrompt).toContain("Options:\n");
    expect(capturedPrompt).toContain("after-cli-help-output");
    expect(capturedPrompt).not.toContain("```cli");
    expect(result.stdoutWrites.join("\n").includes("Usage: rundown")).toBe(false);
  });

  it("root invocation falls back to static help when no interactive worker is configured", async () => {
    const workspace = makeTempWorkspace();
    const spawnMock = createWaitModeSpawnMock({ exitCode: 0 });
    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await withTerminalTty(true, () => runCli([], workspace));

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    const compactHelpOutput = [...result.logs, ...result.stdoutWrites].join("\n").replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("Usage: rundown");
  });

  it("root invocation does not fail when .rundown exists without config.json", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });

    const spawnMock = createWaitModeSpawnMock({ exitCode: 0 });
    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await withTerminalTty(true, () => runCli([], workspace));

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    const compactHelpOutput = [...result.logs, ...result.stdoutWrites].join("\n").replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("Usage: rundown");
  });

  it("root --help remains static and non-interactive", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), JSON.stringify({
      workers: {
        tui: ["node", "-e", "process.exit(0)"],
      },
    }, null, 2), "utf-8");

    const spawnMock = createWaitModeSpawnMock({ exitCode: 0 });
    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await withTerminalTty(true, () => runCli(["--help"], workspace));

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).not.toHaveBeenCalled();
    const compactHelpOutput = [...result.logs, ...result.stdoutWrites].join("\n").replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("Usage: rundown");

    expectGlobalOutputLogInvocationEntries(workspace, {
      command: "rundown",
      argv: ["--help"],
      cwd: workspace,
    });
  });

  it("invalid command keeps Commander root-argument error semantics", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "config.json"), JSON.stringify({
      workers: {
        tui: ["node", "-e", "process.exit(0)"],
      },
    }, null, 2), "utf-8");

    const spawnMock = createWaitModeSpawnMock({ exitCode: 0 });
    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await withTerminalTty(true, () => runCli(["not-a-real-command"], workspace));

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(1);
    expect(spawnMock).not.toHaveBeenCalled();
    const combinedOutput = [
      ...result.errors,
      ...result.logs,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n").toLowerCase();
    expect(combinedOutput).toContain("error: too many arguments. expected 0 arguments but got 1.");
  });

  it("all --help works and includes --all option", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["all", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--all");
  });


  it("plan --help shows --force-unlock, scan-count, and deep defaults", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["plan", "roadmap.md", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("--force-unlock");
    expect(compactHelpOutput).toContain("--scan-count <n>");
    expect(compactHelpOutput).toContain("Max clean-session TODO coverage scans (omit for convergence-driven unlimited mode)");
    expect(compactHelpOutput).toContain("--deep <n>");
    expect(compactHelpOutput).toContain("Additional nested planning depth passes after top-level scans (default: 0)");
  });

  it("explore --help shows variadic argument and plan-phase options", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["explore", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("explore [options] [markdown-file...]");
    expect(compactHelpOutput).toContain("--scan-count <n>");
    expect(compactHelpOutput).toContain("--deep <n>");
    expect(compactHelpOutput).toContain("--max-items <n>");
  });

  it("init --help explains --config-dir creation target", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["init", "--help"], workspace);

    expect(result.code).toBe(0);
    const helpOutput = result.stdoutWrites.join("\n");
    const compactHelpOutput = helpOutput.replace(/\s+/g, " ");
    expect(compactHelpOutput).toContain("Create a .rundown/ directory with default templates (plan, execute, verify, repair, trace), scaffold tools/, and initialize vars.json/config.json as empty JSON objects. Use --config-dir to control where it is created.");
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

  it("unlock returns 3 when no lockfile exists", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(sourcePath, "- [ ] Write docs\n", "utf-8");

    const result = await runCli(["unlock", "roadmap.md"], workspace);

    expect(result.code).toBe(3);
    expect(result.logs.some((line) => line.includes("No source lock found"))).toBe(true);
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

  it("plan expands --worker 'claude -p $bootstrap' with bootstrap text", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    fs.writeFileSync(sourcePath, "# Roadmap\n\n## Scope\nDeliver API workflow.\n", "utf-8");

    const spawnMock = createWaitModeSpawnMock({
      stdout: "- [ ] Add release checklist\n",
      exitCode: 0,
    });
    vi.doMock("cross-spawn", () => ({
      default: spawnMock,
    }));

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "1",
      "--keep-artifacts",
      "--worker",
      "claude -p $bootstrap",
    ], workspace);

    vi.doUnmock("cross-spawn");

    expect(result.code).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("claude");
    expect(args[0]).toBe("-p");
    const bootstrapText = args[1] ?? "";
    const bootstrapPrefix = "Read the task prompt file at ";
    const bootstrapSuffix = " and follow the instructions.";
    expect(bootstrapText.startsWith(bootstrapPrefix)).toBe(true);
    expect(bootstrapText.endsWith(bootstrapSuffix)).toBe(true);
    const relativePromptPath = bootstrapText.slice(
      bootstrapPrefix.length,
      bootstrapText.length - bootstrapSuffix.length,
    );
    const promptPath = path.join(workspace, ...relativePromptPath.split("/"));
    expect(fs.existsSync(promptPath)).toBe(true);
    const promptSource = fs.readFileSync(promptPath, "utf-8");
    expect(promptSource).not.toContain("Deliver API workflow");
    expect(promptSource).toContain("Edit the source file directly at: roadmap.md");
    expect(result.errors.some((line) => line.includes("Planner made no file edits"))).toBe(true);
  });

  it("plan --print-prompt expands cli blocks in plan templates", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "# Roadmap\n\nBreak down migration.\n", "utf-8");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "plan.md"),
      [
        "CUSTOM PLAN TEMPLATE",
        "```cli",
        "echo plan-cli-block-output",
        "```",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("CUSTOM PLAN TEMPLATE")).toBe(true);
    expect(combinedOutput.includes("<command>echo plan-cli-block-output</command>")).toBe(true);
    expect(combinedOutput.includes("plan-cli-block-output")).toBe(true);
  });

  it("plan --print-prompt exposes workspace context vars in non-linked and linked invocations", async () => {
    const readWorkspaceContextValue = (output: string, key: string): string => {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = output.match(new RegExp(`${escapedKey}=([^\\r\\n]*)`));
      return match?.[1] ?? "";
    };

    const nonLinkedWorkspace = makeTempWorkspace();
    fs.writeFileSync(path.join(nonLinkedWorkspace, "roadmap.md"), "# Roadmap\n\nCapture context.\n", "utf-8");
    fs.mkdirSync(path.join(nonLinkedWorkspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(nonLinkedWorkspace, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(nonLinkedWorkspace, ".rundown", "plan.md"), [
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
      "",
    ].join("\n"), "utf-8");

    const nonLinkedResult = await runCli([
      "plan",
      "roadmap.md",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], nonLinkedWorkspace);

    const nonLinkedOutput = [
      ...nonLinkedResult.logs,
      ...nonLinkedResult.errors,
      ...nonLinkedResult.stdoutWrites,
      ...nonLinkedResult.stderrWrites,
    ].join("\n");
    expect(nonLinkedResult.code).toBe(0);
    expect(readWorkspaceContextValue(nonLinkedOutput, "invocationDir")).toBe(path.resolve(nonLinkedWorkspace));
    expect(readWorkspaceContextValue(nonLinkedOutput, "workspaceDir")).toBe(path.resolve(nonLinkedWorkspace));
    expect(readWorkspaceContextValue(nonLinkedOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(nonLinkedOutput, "isLinkedWorkspace")).toBe("false");

    const linkedSandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(linkedSandbox, "source-workspace");
    const linkedInvocationDir = path.join(linkedSandbox, "linked-invocation");
    const workspaceLinkPath = path.join(linkedInvocationDir, ".rundown", "workspace.link");
    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      workspaceLinkPath,
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(path.join(sourceWorkspace, "roadmap.md"), "# Roadmap\n\nCapture context.\n", "utf-8");
    fs.mkdirSync(path.join(sourceWorkspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspace, ".rundown", "plan.md"), [
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
      "",
    ].join("\n"), "utf-8");

    const linkedResult = await runCli([
      "plan",
      path.join(sourceWorkspace, "roadmap.md"),
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], linkedInvocationDir);

    const linkedOutput = [
      ...linkedResult.logs,
      ...linkedResult.errors,
      ...linkedResult.stdoutWrites,
      ...linkedResult.stderrWrites,
    ].join("\n");
    expect(linkedResult.code).toBe(0);
    const linkedInvocationValue = readWorkspaceContextValue(linkedOutput, "invocationDir");
    const linkedWorkspaceValue = readWorkspaceContextValue(linkedOutput, "workspaceDir");
    const linkedWorkspaceLinkValue = readWorkspaceContextValue(linkedOutput, "workspaceLinkPath");
    expect(linkedInvocationValue).toBe(path.resolve(linkedInvocationDir));
    expect(linkedWorkspaceValue).toBe(path.resolve(sourceWorkspace));
    expect(linkedWorkspaceLinkValue).toBe(path.resolve(workspaceLinkPath));
    expect(linkedInvocationValue).not.toBe(linkedWorkspaceValue);
    expect(readWorkspaceContextValue(linkedOutput, "isLinkedWorkspace")).toBe("true");

    const brokenLinkSandbox = makeTempWorkspace();
    const brokenLinkInvocationDir = path.join(brokenLinkSandbox, "broken-linked-invocation");
    fs.mkdirSync(path.join(brokenLinkInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(brokenLinkInvocationDir, ".rundown", "workspace.link"), "../missing-workspace", "utf-8");
    fs.writeFileSync(path.join(brokenLinkInvocationDir, "roadmap.md"), "# Roadmap\n\nCapture context.\n", "utf-8");
    fs.writeFileSync(path.join(brokenLinkInvocationDir, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(brokenLinkInvocationDir, ".rundown", "plan.md"), [
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
      "",
    ].join("\n"), "utf-8");

    const brokenLinkResult = await runCli([
      "plan",
      "roadmap.md",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], brokenLinkInvocationDir);

    const brokenLinkOutput = [
      ...brokenLinkResult.logs,
      ...brokenLinkResult.errors,
      ...brokenLinkResult.stdoutWrites,
      ...brokenLinkResult.stderrWrites,
    ].join("\n");
    expect(brokenLinkResult.code).toBe(0);
    expect(readWorkspaceContextValue(brokenLinkOutput, "invocationDir")).toBe(path.resolve(brokenLinkInvocationDir));
    expect(readWorkspaceContextValue(brokenLinkOutput, "workspaceDir")).toBe(path.resolve(brokenLinkInvocationDir));
    expect(readWorkspaceContextValue(brokenLinkOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(brokenLinkOutput, "isLinkedWorkspace")).toBe("false");

    const staleLinkSandbox = makeTempWorkspace();
    const staleLinkInvocationDir = path.join(staleLinkSandbox, "stale-linked-invocation");
    const staleLinkTargetFile = path.join(staleLinkSandbox, "stale-workspace.txt");
    fs.mkdirSync(path.join(staleLinkInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(staleLinkTargetFile, "stale", "utf-8");
    fs.writeFileSync(
      path.join(staleLinkInvocationDir, ".rundown", "workspace.link"),
      path.relative(staleLinkInvocationDir, staleLinkTargetFile).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(path.join(staleLinkInvocationDir, "roadmap.md"), "# Roadmap\n\nCapture context.\n", "utf-8");
    fs.writeFileSync(path.join(staleLinkInvocationDir, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(staleLinkInvocationDir, ".rundown", "plan.md"), [
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
      "",
    ].join("\n"), "utf-8");

    const staleLinkResult = await runCli([
      "plan",
      "roadmap.md",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], staleLinkInvocationDir);

    const staleLinkOutput = [
      ...staleLinkResult.logs,
      ...staleLinkResult.errors,
      ...staleLinkResult.stdoutWrites,
      ...staleLinkResult.stderrWrites,
    ].join("\n");
    expect(staleLinkResult.code).toBe(0);
    expect(readWorkspaceContextValue(staleLinkOutput, "invocationDir")).toBe(path.resolve(staleLinkInvocationDir));
    expect(readWorkspaceContextValue(staleLinkOutput, "workspaceDir")).toBe(path.resolve(staleLinkInvocationDir));
    expect(readWorkspaceContextValue(staleLinkOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(staleLinkOutput, "isLinkedWorkspace")).toBe("false");
  });

  it("plan hides planner stderr by default", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-default-hidden-stderr.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add release checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
        "}",
        "console.error('planner diagnostic hidden by default');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "1",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.stderrWrites.some((line) => line.includes("planner diagnostic hidden by default"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Plan operation summary: 1 success, 0 failures."))).toBe(true);
  });

  it("plan keeps sub-agent diagnostics hidden by default unless explicitly enabled", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-subagent-diagnostics.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add release checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
        "}",
        "const { spawnSync } = require('node:child_process');",
        "const subAgent = spawnSync(",
        "  process.execPath,",
        "  [",
        "    '-e',",
        "    \"console.error('sub-agent diagnostic from nested worker');\"",
        "  ],",
        "  { encoding: 'utf-8' },",
        ");",
        "if (subAgent.error) {",
        "  throw subAgent.error;",
        "}",
        "if (subAgent.status !== 0) {",
        "  process.exit(subAgent.status ?? 1);",
        "}",
        "if (subAgent.stderr) {",
        "  process.stderr.write(subAgent.stderr);",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const hiddenByDefault = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "1",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );

    const explicitlyShown = await runCli([
      "plan",
      "roadmap.md",
      "--show-agent-output",
      "--scan-count",
      "1",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(hiddenByDefault.code).toBe(0);
    expect(hiddenByDefault.stderrWrites.some((line) => line.includes("sub-agent diagnostic from nested worker"))).toBe(false);
    expect(hiddenByDefault.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);

    expect(explicitlyShown.code).toBe(0);
    expect(explicitlyShown.stderrWrites.some((line) => line.includes("sub-agent diagnostic from nested worker"))).toBe(true);
    expect(explicitlyShown.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("plan keeps default-hidden planner stderr in both TTY and non-TTY sessions", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-hidden-tty-parity.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add release checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
        "}",
        "console.error('planner diagnostic hidden across tty states');",
      ].join("\n"),
      "utf-8",
    );

    const runPlanWithTty = async (isTTY: boolean) => {
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        get: () => isTTY,
      });
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        get: () => isTTY,
      });

      try {
        return await runCli([
          "plan",
          "roadmap.md",
          "--scan-count",
          "1",
          "--worker",
          "node",
          workerScriptPath.replace(/\\/g, "/"),
        ], workspace);
      } finally {
        if (stdoutDescriptor) {
          Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        } else {
          Reflect.deleteProperty(process.stdout, "isTTY");
        }

        if (stderrDescriptor) {
          Object.defineProperty(process.stderr, "isTTY", stderrDescriptor);
        } else {
          Reflect.deleteProperty(process.stderr, "isTTY");
        }
      }
    };

    const ttyResult = await runPlanWithTty(true);
    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    const nonTtyResult = await runPlanWithTty(false);

    expect(ttyResult.code).toBe(0);
    expect(nonTtyResult.code).toBe(0);
    expect(ttyResult.stderrWrites.some((line) => line.includes("planner diagnostic hidden across tty states"))).toBe(false);
    expect(nonTtyResult.stderrWrites.some((line) => line.includes("planner diagnostic hidden across tty states"))).toBe(false);
    expect(ttyResult.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
    expect(nonTtyResult.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("plan shows planner stderr when --show-agent-output is set", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-show-stderr.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add release checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
        "}",
        "console.error('planner diagnostic visible with flag');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--show-agent-output",
      "--scan-count",
      "1",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.stderrWrites.some((line) => line.includes("planner diagnostic visible with flag"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("plan shows planner stderr with --show-agent-output in both TTY and non-TTY sessions", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-show-tty-parity.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add release checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
        "}",
        "console.error('planner diagnostic visible across tty states');",
      ].join("\n"),
      "utf-8",
    );

    const runPlanWithTty = async (isTTY: boolean) => {
      const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");

      Object.defineProperty(process.stdout, "isTTY", {
        configurable: true,
        get: () => isTTY,
      });
      Object.defineProperty(process.stderr, "isTTY", {
        configurable: true,
        get: () => isTTY,
      });

      try {
        return await runCli([
          "plan",
          "roadmap.md",
          "--show-agent-output",
          "--scan-count",
          "1",
          "--worker",
          "node",
          workerScriptPath.replace(/\\/g, "/"),
        ], workspace);
      } finally {
        if (stdoutDescriptor) {
          Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
        } else {
          Reflect.deleteProperty(process.stdout, "isTTY");
        }

        if (stderrDescriptor) {
          Object.defineProperty(process.stderr, "isTTY", stderrDescriptor);
        } else {
          Reflect.deleteProperty(process.stderr, "isTTY");
        }
      }
    };

    const ttyResult = await runPlanWithTty(true);
    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    const nonTtyResult = await runPlanWithTty(false);

    expect(ttyResult.code).toBe(0);
    expect(nonTtyResult.code).toBe(0);
    expect(ttyResult.stderrWrites.some((line) => line.includes("planner diagnostic visible across tty states"))).toBe(true);
    expect(nonTtyResult.stderrWrites.some((line) => line.includes("planner diagnostic visible across tty states"))).toBe(true);
    expect(ttyResult.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
    expect(nonTtyResult.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("plan keeps explicit --no-show-agent-output over prior --show-agent-output", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-explicit-hide-stderr.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add release checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
        "}",
        "console.error('planner diagnostic hidden by explicit disable');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--show-agent-output",
      "--no-show-agent-output",
      "--scan-count",
      "1",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.stderrWrites.some((line) => line.includes("planner diagnostic hidden by explicit disable"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
  });

  it("plan keeps agent output hidden by default when worker comes from config defaults", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-config-default-hidden-stderr.cjs");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nDeliver API workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "if (!source.includes('- [ ] Add release checklist')) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
        "}",
        "console.error('planner diagnostic hidden via config defaults');",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", workerScriptPath.replace(/\\/g, "/")],
        },
      }, null, 2),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "1",
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.stderrWrites.some((line) => line.includes("planner diagnostic hidden via config defaults"))).toBe(false);
    expect(result.logs.some((line) => line.includes("Inserted 1 TODO item"))).toBe(true);
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
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (source.includes('- [ ] Add release checklist')) {",
        "  process.exit(0);",
        "}",
        "fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Add release checklist\\n', 'utf-8');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "3",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("No existing TODO items found in document"))).toBe(true);
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
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (source.includes('- [ ] Add CI checks')) {",
        "  process.exit(0);",
        "}",
        "fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Add CI checks\\n', 'utf-8');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "4",
      "--verbose",
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

  it("plan defaults to unlimited scans when --scan-count is omitted", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-default-scan-count.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-default");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\n- [ ] Existing task\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (current === 1) {",
        "  if (!source.includes('- [ ] Add API checklist')) {",
        "    fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Add API checklist\\n', 'utf-8');",
        "  }",
        "  process.exit(0);",
        "}",
        "if (current === 2) {",
        "  if (!source.includes('- [ ] Add rollback checklist')) {",
        "    fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Add rollback checklist\\n', 'utf-8');",
        "  }",
        "  process.exit(0);",
        "}",
        "process.exit(0);",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-01"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-02"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Plan stop reason: converged-diminishing."))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Existing task");
    expect(updated).toContain("- [ ] Add API checklist");
    expect(updated).toContain("- [ ] Add rollback checklist");
  });

  it("plan --scan-count enforces an exact bounded scan cap", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-bounded-cap.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-bounded-cap");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nShip release workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "fs.writeFileSync(roadmapPath, source.trimEnd() + `\\n- [ ] Scan ${current} task\\n`, 'utf-8');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "2",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-01-of-02"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-02-of-02"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Plan stop reason: converged-diminishing."))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Scan 1 task");
    expect(updated).toContain("- [ ] Scan 2 task");
    expect(updated).not.toContain("- [ ] Scan 3 task");
  });

  it("plan respects both --scan-count and --max-items when scan-count is reached first", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-scan-cap-before-max-items.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-scan-cap-before-max-items");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nShip release workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "fs.writeFileSync(roadmapPath, source.trimEnd() + `\\n- [ ] Scan ${current} task\\n`, 'utf-8');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "2",
      "--max-items",
      "5",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Plan stop reason: converged-diminishing."))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Scan 1 task");
    expect(updated).toContain("- [ ] Scan 2 task");
    expect(updated).not.toContain("- [ ] Scan 3 task");
  });

  it("plan respects both --scan-count and --max-items when max-items is reached first", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-max-items-before-scan-cap.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-max-items-before-scan-cap");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nShip release workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "fs.writeFileSync(roadmapPath, source.trimEnd() + `\\n- [ ] Scan ${current} task\\n`, 'utf-8');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "5",
      "--max-items",
      "2",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Plan stop reason: converged-diminishing."))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Scan 1 task");
    expect(updated).toContain("- [ ] Scan 2 task");
    expect(updated).not.toContain("- [ ] Scan 3 task");
  });

  it("plan --max-items stops scanning once the item cap is reached", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-max-items-cap.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-max-items");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nShip release workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (current === 1) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Item one\\n- [ ] Item two\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
        "if (current === 2) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Should not be added\\n', 'utf-8');",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "5",
      "--max-items",
      "1",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Plan stop reason: max-items-reached."))).toBe(true);
    expect(result.logs.some((line) => line.includes("max-items cap reached"))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("1");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Item one");
    expect(updated).toContain("- [ ] Item two");
    expect(updated).not.toContain("- [ ] Should not be added");
  });

  it("plan without --max-items does not enforce an item cap", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-without-max-items.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-without-max-items");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nShip release workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (current === 1) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Item one\\n- [ ] Item two\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
        "if (current === 2) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Added on second scan\\n', 'utf-8');",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "2",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Item one");
    expect(updated).toContain("- [ ] Item two");
    expect(updated).toContain("- [ ] Added on second scan");
  });

  it("plan --max-items 0 exits before invoking worker", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-max-items-zero.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-max-items-zero");

    const initialSource = "# Roadmap\n\n## Scope\nShip release workflow.\n";
    fs.writeFileSync(roadmapPath, initialSource, "utf-8");
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "fs.writeFileSync(markerPath, 'worker-ran', 'utf-8');",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "3",
      "--max-items",
      "0",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Plan stop reason: max-items-reached."))).toBe(true);
    expect(fs.existsSync(scanMarkerPath)).toBe(false);
    expect(fs.readFileSync(roadmapPath, "utf-8")).toBe(initialSource);
  });

  it("plan --max-items persists max-items convergence in artifact and trace metadata", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-max-items-metadata.cjs");
    const scanMarkerPath = path.join(workspace, ".plan-scan-count-max-items-metadata");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n## Scope\nShip release workflow.\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (current === 1) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Item one\\n- [ ] Item two\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "5",
      "--max-items",
      "1",
      "--keep-artifacts",
      "--trace",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Plan stop reason: max-items-reached."))).toBe(true);

    const latestRun = findSavedRunByCommand(workspace, "plan");
    expect(latestRun).not.toBeNull();
    expect(latestRun?.extra).toEqual(expect.objectContaining({
      planConvergenceReason: "max-items-reached",
      planConvergenceOutcome: "max-items-reached",
      planConverged: false,
      planMaxItemsReached: true,
      planScanCapReached: false,
      planEmergencyCapReached: false,
    }));

    const tracePath = path.join(workspace, ".rundown", "runs", latestRun!.runId, "trace.jsonl");
    expect(fs.existsSync(tracePath)).toBe(true);
    const traceEvents = fs.readFileSync(tracePath, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as {
        event_type?: string;
        payload?: Record<string, unknown>;
      });
    const runCompletedEvent = traceEvents.find((event) => event.event_type === "run.completed");
    expect(runCompletedEvent?.payload).toEqual(expect.objectContaining({
      plan_convergence_outcome: "max-items-reached",
      plan_converged: false,
      plan_max_items_reached: true,
      plan_scan_cap_reached: false,
      plan_emergency_cap_reached: false,
    }));
  });

  it("plan --deep 2 produces a two-level task hierarchy", async () => {
    const workspace = makeTempWorkspace();
    const roadmapPath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "plan-worker-deep-two-level.cjs");

    fs.writeFileSync(
      roadmapPath,
      "# Roadmap\n\n- [ ] Build release flow\n",
      "utf-8",
    );
    fs.writeFileSync(
      workerScriptPath,
      [
        "const fs = require('node:fs');",
        "const promptPath = process.argv[process.argv.length - 1];",
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        "const prompt = fs.readFileSync(promptPath, 'utf-8');",
        "if (prompt.includes('Parent task: Build release flow')) {",
        "  const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "  if (!source.includes('  - [ ] Define release steps')) {",
        "    const updated = source.replace('- [ ] Build release flow\\n', '- [ ] Build release flow\\n  - [ ] Define release steps\\n  - [ ] Validate rollout\\n');",
        "    fs.writeFileSync(roadmapPath, updated, 'utf-8');",
        "  }",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli([
      "plan",
      "roadmap.md",
      "--scan-count",
      "1",
      "--deep",
      "2",
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Running deep pass 1 of 2"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Running deep pass 2 of 2"))).toBe(true);
    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Build release flow\n  - [ ] Define release steps\n  - [ ] Validate rollout\n");
    expect(updated).not.toContain("    - [ ]");
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
        `const roadmapPath = ${JSON.stringify(roadmapPath.replace(/\\/g, "/"))};`,
        `const markerPath = ${JSON.stringify(scanMarkerPath.replace(/\\/g, "/"))};`,
        "const source = fs.readFileSync(roadmapPath, 'utf-8');",
        "const previous = fs.existsSync(markerPath) ? Number(fs.readFileSync(markerPath, 'utf-8')) : 0;",
        "const current = Number.isFinite(previous) ? previous + 1 : 1;",
        "fs.writeFileSync(markerPath, String(current));",
        "if (current === 2 && !source.includes('- [ ] Create API schema')) {",
        "  console.error('scan 2 did not receive markdown updates from scan 1');",
        "  process.exit(22);",
        "}",
        "if (current === 3 && !source.includes('- [ ] Implement API handler')) {",
        "  console.error('scan 3 did not receive markdown updates from scan 2');",
        "  process.exit(23);",
        "}",
        "if (current === 1) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n\\n- [ ] Create API schema\\n', 'utf-8');",
        "  process.exit(0);",
        "}",
        "if (current === 2) {",
        "  fs.writeFileSync(roadmapPath, source.trimEnd() + '\\n- [ ] Implement API handler\\n', 'utf-8');",
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
      "--verbose",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-01-of-04"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Planning plan-scan-02-of-04"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Plan stop reason: converged-diminishing."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Inserted 2 TODO items"))).toBe(true);
    expect(fs.readFileSync(scanMarkerPath, "utf-8").trim()).toBe("2");

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toContain("- [ ] Create API schema");
    expect(updated).toContain("- [ ] Implement API handler");
    expect(updated.indexOf("- [ ] Create API schema")).toBeLessThan(updated.indexOf("- [ ] Implement API handler"));
  });

  it("plan ignores non-TODO worker stdout when no file edits are applied", async () => {
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

    expect(result.code).toBe(0);
    expect(result.errors.some((line) => line.includes("Planner made no file edits. No TODO items added."))).toBe(true);

    const updated = fs.readFileSync(roadmapPath, "utf-8");
    expect(updated).toBe("# Roadmap\n\n## Scope\n- [ ] Existing task\n");
  });

  it("research --print-prompt renders custom templates with vars and expanded cli blocks", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "roadmap.md"), "# Roadmap\n\nInitial sketch.\n", "utf-8");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "research.md"), [
      "CUSTOM RESEARCH TEMPLATE",
      "File={{file}}",
      "Branch={{branch}}",
      "Env={{env}}",
      "```cli",
      "echo research-cli-block-output",
      "```",
      "Source={{source}}",
      "",
    ].join("\n"), "utf-8");
    fs.writeFileSync(path.join(workspace, "custom-vars.json"), JSON.stringify({ branch: "main" }, null, 2), "utf-8");

    const result = await runCli([
      "research",
      "roadmap.md",
      "--print-prompt",
      "--vars-file",
      "custom-vars.json",
      "--var",
      "env=prod",
      "--worker",
      "opencode",
      "run",
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("CUSTOM RESEARCH TEMPLATE")).toBe(true);
    expect(combinedOutput.includes("File=roadmap.md")).toBe(true);
    expect(combinedOutput.includes("Branch=main")).toBe(true);
    expect(combinedOutput.includes("Env=prod")).toBe(true);
    expect(combinedOutput.includes("<command>echo research-cli-block-output</command>")).toBe(true);
    expect(combinedOutput.includes("research-cli-block-output")).toBe(true);
    expect(combinedOutput.includes("Source=# Roadmap")).toBe(true);
  });

  it("research --print-prompt exposes workspace context vars in non-linked and linked invocations", async () => {
    const readWorkspaceContextValue = (output: string, key: string): string => {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = output.match(new RegExp(`${escapedKey}=([^\\r\\n]*)`));
      return match?.[1] ?? "";
    };

    const nonLinkedWorkspace = makeTempWorkspace();
    fs.writeFileSync(path.join(nonLinkedWorkspace, "roadmap.md"), "# Roadmap\n\nCapture context.\n", "utf-8");
    fs.mkdirSync(path.join(nonLinkedWorkspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(nonLinkedWorkspace, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(nonLinkedWorkspace, ".rundown", "research.md"), [
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
      "",
    ].join("\n"), "utf-8");

    const nonLinkedResult = await runCli([
      "research",
      "roadmap.md",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], nonLinkedWorkspace);

    const nonLinkedOutput = [
      ...nonLinkedResult.logs,
      ...nonLinkedResult.errors,
      ...nonLinkedResult.stdoutWrites,
      ...nonLinkedResult.stderrWrites,
    ].join("\n");
    expect(nonLinkedResult.code).toBe(0);
    expect(readWorkspaceContextValue(nonLinkedOutput, "invocationDir")).toBe(path.resolve(nonLinkedWorkspace));
    expect(readWorkspaceContextValue(nonLinkedOutput, "workspaceDir")).toBe(path.resolve(nonLinkedWorkspace));
    expect(readWorkspaceContextValue(nonLinkedOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(nonLinkedOutput, "isLinkedWorkspace")).toBe("false");

    const linkedSandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(linkedSandbox, "source-workspace");
    const linkedInvocationDir = path.join(linkedSandbox, "linked-invocation");
    const workspaceLinkPath = path.join(linkedInvocationDir, ".rundown", "workspace.link");
    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      workspaceLinkPath,
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(path.join(sourceWorkspace, "roadmap.md"), "# Roadmap\n\nCapture context.\n", "utf-8");
    fs.mkdirSync(path.join(sourceWorkspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspace, ".rundown", "research.md"), [
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
      "",
    ].join("\n"), "utf-8");

    const linkedResult = await runCli([
      "research",
      path.join(sourceWorkspace, "roadmap.md"),
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], linkedInvocationDir);

    const linkedOutput = [
      ...linkedResult.logs,
      ...linkedResult.errors,
      ...linkedResult.stdoutWrites,
      ...linkedResult.stderrWrites,
    ].join("\n");
    expect(linkedResult.code).toBe(0);
    const linkedInvocationValue = readWorkspaceContextValue(linkedOutput, "invocationDir");
    const linkedWorkspaceValue = readWorkspaceContextValue(linkedOutput, "workspaceDir");
    const linkedWorkspaceLinkValue = readWorkspaceContextValue(linkedOutput, "workspaceLinkPath");
    expect(linkedInvocationValue).toBe(path.resolve(linkedInvocationDir));
    expect(linkedWorkspaceValue).toBe(path.resolve(sourceWorkspace));
    expect(linkedWorkspaceLinkValue).toBe(path.resolve(workspaceLinkPath));
    expect(linkedInvocationValue).not.toBe(linkedWorkspaceValue);
    expect(readWorkspaceContextValue(linkedOutput, "isLinkedWorkspace")).toBe("true");

    const brokenLinkSandbox = makeTempWorkspace();
    const brokenLinkInvocationDir = path.join(brokenLinkSandbox, "broken-linked-invocation");
    fs.mkdirSync(path.join(brokenLinkInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(brokenLinkInvocationDir, ".rundown", "workspace.link"), "../missing-workspace", "utf-8");
    fs.writeFileSync(path.join(brokenLinkInvocationDir, "roadmap.md"), "# Roadmap\n\nCapture context.\n", "utf-8");
    fs.writeFileSync(path.join(brokenLinkInvocationDir, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(brokenLinkInvocationDir, ".rundown", "research.md"), [
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
      "",
    ].join("\n"), "utf-8");

    const brokenLinkResult = await runCli([
      "research",
      "roadmap.md",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], brokenLinkInvocationDir);

    const brokenLinkOutput = [
      ...brokenLinkResult.logs,
      ...brokenLinkResult.errors,
      ...brokenLinkResult.stdoutWrites,
      ...brokenLinkResult.stderrWrites,
    ].join("\n");
    expect(brokenLinkResult.code).toBe(0);
    expect(readWorkspaceContextValue(brokenLinkOutput, "invocationDir")).toBe(path.resolve(brokenLinkInvocationDir));
    expect(readWorkspaceContextValue(brokenLinkOutput, "workspaceDir")).toBe(path.resolve(brokenLinkInvocationDir));
    expect(readWorkspaceContextValue(brokenLinkOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(brokenLinkOutput, "isLinkedWorkspace")).toBe("false");

    const staleLinkSandbox = makeTempWorkspace();
    const staleLinkInvocationDir = path.join(staleLinkSandbox, "stale-linked-invocation");
    const staleLinkTargetFile = path.join(staleLinkSandbox, "stale-workspace.txt");
    fs.mkdirSync(path.join(staleLinkInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(staleLinkTargetFile, "stale", "utf-8");
    fs.writeFileSync(
      path.join(staleLinkInvocationDir, ".rundown", "workspace.link"),
      path.relative(staleLinkInvocationDir, staleLinkTargetFile).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(path.join(staleLinkInvocationDir, "roadmap.md"), "# Roadmap\n\nCapture context.\n", "utf-8");
    fs.writeFileSync(path.join(staleLinkInvocationDir, ".rundown", "config.json"), "{}\n", "utf-8");
    fs.writeFileSync(path.join(staleLinkInvocationDir, ".rundown", "research.md"), [
      "invocationDir={{invocationDir}}",
      "workspaceDir={{workspaceDir}}",
      "workspaceLinkPath={{workspaceLinkPath}}",
      "isLinkedWorkspace={{isLinkedWorkspace}}",
      "",
    ].join("\n"), "utf-8");

    const staleLinkResult = await runCli([
      "research",
      "roadmap.md",
      "--print-prompt",
      "--worker",
      "opencode",
      "run",
    ], staleLinkInvocationDir);

    const staleLinkOutput = [
      ...staleLinkResult.logs,
      ...staleLinkResult.errors,
      ...staleLinkResult.stdoutWrites,
      ...staleLinkResult.stderrWrites,
    ].join("\n");
    expect(staleLinkResult.code).toBe(0);
    expect(readWorkspaceContextValue(staleLinkOutput, "invocationDir")).toBe(path.resolve(staleLinkInvocationDir));
    expect(readWorkspaceContextValue(staleLinkOutput, "workspaceDir")).toBe(path.resolve(staleLinkInvocationDir));
    expect(readWorkspaceContextValue(staleLinkOutput, "workspaceLinkPath")).toBe("");
    expect(readWorkspaceContextValue(staleLinkOutput, "isLinkedWorkspace")).toBe("false");
  });

  it("research updates markdown and persists artifacts", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "research-worker-file-pattern.cjs");
    const capturePath = path.join(workspace, "research-file-pattern-capture.json");

    fs.writeFileSync(sourcePath, "# Roadmap\n\nInitial sketch.\n", "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      "const promptPath = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(promptPath, 'utf-8');",
      `fs.writeFileSync(${JSON.stringify(capturePath.replace(/\\/g, "/"))}, JSON.stringify({`,
      "  promptPath,",
      "  promptPathExists: fs.existsSync(promptPath),",
      "  promptContainsSource: prompt.includes('Initial sketch.'),",
      "}, null, 2));",
      "console.log('# Roadmap\\n\\nInitial sketch.\\n\\n## Context\\n\\nExpanded context.');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "research",
      "roadmap.md",
      "--keep-artifacts",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Research worker completed."))).toBe(true);
    expect(result.logs.some((line) => line.includes("Research turn summary: 1 success, 0 failures."))).toBe(true);
    const updated = fs.readFileSync(sourcePath, "utf-8");
    expect(updated).toContain("## Context");

    const capture = JSON.parse(fs.readFileSync(capturePath, "utf-8")) as {
      promptPath: string;
      promptPathExists: boolean;
      promptContainsSource: boolean;
    };
    expect(capture.promptPathExists).toBe(true);
    expect(capture.promptContainsSource).toBe(true);
    expect(capture.promptPath).toContain("prompt.md");

    const researchRun = readSavedRunMetadata(workspace)
      .find((run) => run.commandName === "research");
    expect(researchRun).toBeDefined();
    expect(researchRun?.status).toBe("completed");
    const runDir = path.join(workspace, ".rundown", "runs", researchRun!.runId);
    expect(fs.existsSync(path.join(runDir, "01-research", "prompt.md"))).toBe(true);
    expect(fs.existsSync(path.join(runDir, "01-research", "stdout.log"))).toBe(true);
  });

  it("research worker without placeholders receives prompt file as trailing argument", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "research-worker-implicit-file-pattern.cjs");
    const capturePath = path.join(workspace, "research-implicit-file-pattern-capture.json");

    fs.writeFileSync(sourcePath, "# Roadmap\n\nThin note.\n", "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      "const lastArg = process.argv[process.argv.length - 1];",
      "const prompt = fs.readFileSync(lastArg, 'utf-8');",
      `fs.writeFileSync(${JSON.stringify(capturePath.replace(/\\/g, "/"))}, JSON.stringify({`,
      "  argLooksLikeFilePath: fs.existsSync(lastArg),",
      "  promptContainsPhaseText: prompt.includes('Research and enrich the source document with implementation context.'),",
      "  promptContainsSource: prompt.includes('Thin note.'),",
      "}, null, 2));",
      "console.log('# Roadmap\\n\\nImplicit file pattern output.');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "research",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(sourcePath, "utf-8")).toContain("Implicit file pattern output.");
    const capture = JSON.parse(fs.readFileSync(capturePath, "utf-8")) as {
      argLooksLikeFilePath: boolean;
      promptContainsPhaseText: boolean;
      promptContainsSource: boolean;
    };
    expect(capture.argLooksLikeFilePath).toBe(true);
    expect(capture.promptContainsPhaseText).toBe(true);
    expect(capture.promptContainsSource).toBe(true);
  });

  it("research holds the source lock during execution and releases it after completion", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`).replace(/\\/g, "/");
    const markerPath = path.join(workspace, "research-lock-seen.txt");
    const workerScriptPath = path.join(workspace, "research-worker-lock-check.cjs");

    fs.writeFileSync(sourcePath, "# Roadmap\n\nLock lifecycle check.\n", "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      `const lockPath = ${JSON.stringify(lockPath)};`,
      `const markerPath = ${JSON.stringify(markerPath.replace(/\\/g, "/"))};`,
      "fs.writeFileSync(markerPath, String(fs.existsSync(lockPath)));",
      "console.log('# Roadmap\\n\\nLock lifecycle check.\\n\\nExpanded.');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "research",
      sourceName,
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(markerPath, "utf-8").trim()).toBe("true");
    expect(fs.existsSync(path.join(workspace, ".rundown", `${sourceName}.lock`))).toBe(false);
  });

  it("research returns 1 when the source markdown is locked by another active process", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "roadmap.md";
    const sourcePath = path.join(workspace, sourceName);
    const lockPath = path.join(workspace, ".rundown", `${sourceName}.lock`);
    fs.writeFileSync(sourcePath, "# Roadmap\n\nStill locked.\n", "utf-8");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({
      pid: process.pid,
      command: "run",
      startedAt: "2026-01-01T00:00:00.000Z",
      file: sourcePath,
    }), "utf-8");

    const result = await runCli([
      "research",
      sourceName,
      "--worker",
      "opencode",
      "run",
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Source file is locked by another rundown process"))).toBe(true);
    expect(result.errors.some((line) => line.includes("--force-unlock"))).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe("# Roadmap\n\nStill locked.\n");
    expect(fs.existsSync(lockPath)).toBe(true);
  });

  it("research rejects checkbox-state mutation output and restores original source", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "research-worker-checkbox-violation.cjs");
    const original = "# Roadmap\n\n- [x] Keep this checked\n";

    fs.writeFileSync(sourcePath, original, "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "console.log('# Roadmap\\n\\n- [ ] Keep this checked');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "research",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Research changed checkbox state in"))).toBe(true);
    expect(result.errors.some((line) => line.includes("Research update rejected due to constraint violation."))).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(original);
  });

  it("research strips new unchecked TODO output and keeps cleaned source", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "research-worker-todo-violation.cjs");
    const original = "# Roadmap\n\nThin note.\n";

    fs.writeFileSync(sourcePath, original, "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "console.log('# Roadmap\\n\\nThin note.\\n\\n- [ ] New task from research');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "research",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.errors.some((line) => line.includes("Research introduced new unchecked TODO items in"))).toBe(true);
    expect(result.errors.some((line) => line.includes("Removed 1 introduced item: - [ ] New task from research; continuing with cleaned output."))).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe("# Roadmap\n\nThin note.\n\n");
  });

  it("research removes only real introduced TODO items and preserves fenced TODO lines", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const workerScriptPath = path.join(workspace, "research-worker-mixed-todo-output.cjs");
    const original = "# Roadmap\n\nThin note.\n";

    fs.writeFileSync(sourcePath, original, "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "console.log('# Roadmap\\n\\nThin note.\\n\\n- [ ] Real task to remove\\n\\n```md\\n- [ ] Example task in fenced block\\n```');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "research",
      "roadmap.md",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.errors.some((line) => line.includes("Research introduced new unchecked TODO items in"))).toBe(true);
    expect(result.errors.some((line) => line.includes("Removed 1 introduced item: - [ ] Real task to remove; continuing with cleaned output."))).toBe(true);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe([
      "# Roadmap",
      "",
      "Thin note.",
      "",
      "",
      "```md",
      "- [ ] Example task in fenced block",
      "```",
      "",
    ].join("\n"));
  });

  it("research --dry-run does not execute worker and does not modify source", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "research-dry-run-worker-executed.txt");
    const workerScriptPath = path.join(workspace, "research-worker-dry-run-guard.cjs");
    const original = "# Roadmap\n\nInitial sketch.\n";

    fs.writeFileSync(sourcePath, original, "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(markerPath.replace(/\\/g, "/"))}, 'executed');`,
      "console.log('# Roadmap\\n\\nMutated by worker.');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "research",
      "roadmap.md",
      "--dry-run",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Dry run - would research:"))).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(original);
  });

  it("research --print-prompt does not execute worker and does not modify source", async () => {
    const workspace = makeTempWorkspace();
    const sourcePath = path.join(workspace, "roadmap.md");
    const markerPath = path.join(workspace, "research-print-prompt-worker-executed.txt");
    const workerScriptPath = path.join(workspace, "research-worker-print-prompt-guard.cjs");
    const original = "# Roadmap\n\nInitial sketch.\n";

    fs.writeFileSync(sourcePath, original, "utf-8");
    fs.writeFileSync(workerScriptPath, [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(markerPath.replace(/\\/g, "/"))}, 'executed');`,
      "console.log('# Roadmap\\n\\nMutated by worker.');",
    ].join("\n"), "utf-8");

    const result = await runCli([
      "research",
      "roadmap.md",
      "--print-prompt",
      "--worker",
      "node",
      workerScriptPath.replace(/\\/g, "/"),
    ], workspace);

    const combinedOutput = [
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n");

    expect(result.code).toBe(0);
    expect(combinedOutput.includes("Research and enrich the source document with implementation context.")).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(fs.readFileSync(sourcePath, "utf-8")).toBe(original);
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

  it("log prints compact run history and exits 0", async () => {
    const workspace = makeTempWorkspace();
    writeSavedRun(workspace, {
      runId: "run-20260317T000000000Z-log-basic",
      status: "completed",
      extra: {
        commitSha: "1234567890abcdef1234567890abcdef12345678",
      },
    });

    const result = await runCli(["log"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("run-20260317T000"))).toBe(true);
    expect(result.logs.some((line) => line.includes("command=run"))).toBe(true);
    expect(result.logs.some((line) => line.includes("sha=1234567890ab"))).toBe(true);
    expect(result.logs.some((line) => line.includes("revertable=yes"))).toBe(true);
  });

  it("log exits 3 with an informational message when no runs exist", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["log"], workspace);

    expect(result.code).toBe(3);
    expect(result.logs.some((line) => line.includes("No matching completed runs found."))).toBe(true);
  });

  it("log exits 1 for invalid --limit values", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["log", "--limit", "0"], workspace);

    expect(result.code).toBe(1);
    expect(result.errors.some((line) => line.includes("Invalid --limit value: 0"))).toBe(true);
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

  it("artifacts exits 3 when no saved runs exist", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["artifacts"], workspace);

    expect(result.code).toBe(3);
    expect(result.logs.some((line) => line.includes("No saved runtime artifacts found."))).toBe(true);
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

  it("artifacts --clean exits 3 when no saved runs exist", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["artifacts", "--clean"], workspace);

    expect(result.code).toBe(3);
    expect(result.logs.some((line) => line.includes("No saved runtime artifacts found."))).toBe(true);
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

  it("artifacts --open exits 3 when the target run is missing", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["artifacts", "--open", "missing-run"], workspace);

    expect(result.code).toBe(3);
    expect(result.errors.some((line) => line.includes("No saved runtime artifact run found for: missing-run."))).toBe(true);
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

  it("list exits with 3 when source has no tasks", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "notes.md"), "# Notes\nNo tasks here.\n", "utf-8");

    const result = await runCli(["list", "notes.md"], workspace);

    expect(result.code).toBe(3);
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

  it("list does not initialize or clean up call CLI cache artifacts", async () => {
    const workspace = makeTempWorkspace();
    const sourceName = "notes.md";
    const sourcePath = path.join(workspace, sourceName);
    const cacheDir = path.join(workspace, ".rundown", "cache", "cli-blocks");
    const cacheMarkerPath = path.join(cacheDir, "cache-marker.txt");
    fs.writeFileSync(sourcePath, "- [ ] Parent\n", "utf-8");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cacheMarkerPath, "keep-me\n", "utf-8");

    const result = await runCli(["list", sourceName], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Parent"))).toBe(true);
    expect(fs.existsSync(cacheDir)).toBe(true);
    expect(fs.readFileSync(cacheMarkerPath, "utf-8")).toBe("keep-me\n");
  });

  it("list keeps blocked-task label semantics", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(path.join(workspace, "notes.md"), "- [ ] Parent\n  - [ ] Child\n", "utf-8");

    const result = await runCli(["list", "notes.md"], workspace);

    expect(result.code).toBe(0);
    expect(result.logs.some((line) => line.includes("Parent") && line.includes("blocked"))).toBe(true);
    expect(result.logs.some((line) => line.includes("Child"))).toBe(true);
  });

  it("list shows nested checkbox children as an indented hierarchy", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(
      path.join(workspace, "notes.md"),
      [
        "- [ ] Parent",
        "  - [ ] Child one",
        "    - [ ] Grandchild",
        "  - [ ] Child two",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli(["list", "notes.md"], workspace);

    expect(result.code).toBe(0);
    const parentHierarchyLine = result.logs.find((line) => {
      return line.includes("Parent")
        && line.includes("Child one")
        && line.includes("Grandchild")
        && line.includes("Child two");
    });
    expect(parentHierarchyLine).toBeDefined();
    expect(parentHierarchyLine).toContain("\n  ");
    expect(parentHierarchyLine).toContain("\n    ");
    expect(parentHierarchyLine).toContain("Child one");
    expect(parentHierarchyLine).toContain("Grandchild");
    expect(parentHierarchyLine).toContain("Child two");
  });

  it("list shows non-checkable sub-items as indented details", async () => {
    const workspace = makeTempWorkspace();
    fs.writeFileSync(
      path.join(workspace, "notes.md"),
      [
        "- [ ] Parent",
        "  - Parent detail",
        "    - Nested detail",
        "",
      ].join("\n"),
      "utf-8",
    );

    const result = await runCli(["list", "notes.md"], workspace);

    expect(result.code).toBe(0);
    const parentDetailsLine = result.logs.find((line) => {
      return line.includes("Parent")
        && line.includes("Parent detail")
        && line.includes("Nested detail");
    });
    expect(parentDetailsLine).toBeDefined();
    const hierarchyOutput = stripAnsi(parentDetailsLine ?? "");
    expect(hierarchyOutput).toContain("\n  ");
    expect(hierarchyOutput).toContain("\n    ");
    expect(hierarchyOutput).toContain(":2 - Parent detail");
    expect(hierarchyOutput).toContain(":3 - Nested detail");
  });

  it("init creates .rundown defaults and exits with 0", async () => {
    const workspace = makeTempWorkspace();

    const result = await runCli(["init"], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, ".rundown", "execute.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "discuss-finished.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "verify.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "repair.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "plan.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "research.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "trace.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "undo.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "test-verify.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "migrate.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "migrate-context.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "migrate-snapshot.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "migrate-backlog.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "migrate-review.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "migrate-ux.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "tools"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "vars.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".rundown", "config.json"))).toBe(true);
    expect(fs.readFileSync(path.join(workspace, ".rundown", "config.json"), "utf-8")).toBe("{}\n");
    expect(fs.readFileSync(path.join(workspace, ".rundown", "vars.json"), "utf-8")).toBe("{}\n");
    expect(result.logs.some((line) => line.includes("Initialized .rundown/ with default templates."))).toBe(true);
  });

  it("init --config-dir creates defaults at the explicit target directory", async () => {
    const workspace = makeTempWorkspace();
    const customConfigDir = path.join(workspace, "custom");

    const result = await runCli(["init", "--config-dir", "./custom"], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(customConfigDir, "execute.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "discuss-finished.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "verify.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "repair.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "plan.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "research.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "trace.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "undo.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "test-verify.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "migrate.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "migrate-context.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "migrate-snapshot.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "migrate-backlog.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "migrate-review.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "migrate-ux.md"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "tools"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "vars.json"))).toBe(true);
    expect(fs.existsSync(path.join(customConfigDir, "config.json"))).toBe(true);
    expect(fs.readFileSync(path.join(customConfigDir, "config.json"), "utf-8")).toBe("{}\n");
    expect(fs.readFileSync(path.join(customConfigDir, "vars.json"), "utf-8")).toBe("{}\n");
    expect(fs.existsSync(path.join(workspace, ".rundown"))).toBe(false);
  });

  it("init keeps existing files and warns when defaults already exist", async () => {
    const workspace = makeTempWorkspace();

    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "execute.md"), "custom execute", "utf-8");

    const result = await runCli(["init"], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(workspace, ".rundown", "execute.md"), "utf-8")).toBe("custom execute");
    expect(result.errors.some((line) => line.includes(".rundown/execute.md already exists, skipping."))).toBe(true);
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
    taskLine?: number;
    taskIndex?: number;
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
    source: "roadmap.md",
    task: {
      text: options.taskText ?? "Write docs",
      file: "roadmap.md",
      line: options.taskLine ?? 1,
      index: options.taskIndex ?? 0,
      source: "roadmap.md",
    },
    keepArtifacts: true,
    startedAt: options.startedAt ?? "2026-03-17T00:00:00.000Z",
    completedAt: "2026-03-17T00:01:00.000Z",
    status: options.status,
    extra: options.extra,
  }, null, 2), "utf-8");
}

function setupUndoDirtyWorkspace(
  workspace: string,
  options: {
    runId: string;
    taskText: string;
  },
): void {
  const roadmapPath = path.join(workspace, "roadmap.md");
  fs.writeFileSync(roadmapPath, `- [x] ${options.taskText}\n`, "utf-8");

  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

  fs.writeFileSync(roadmapPath, `- [x] ${options.taskText}\n\nDirty change\n`, "utf-8");

  writeSavedRun(workspace, {
    runId: options.runId,
    status: "completed",
    taskText: options.taskText,
  });
}

function setupUndoLastRunsWorkspace(workspace: string): void {
  const roadmapPath = path.join(workspace, "roadmap.md");
  fs.writeFileSync(roadmapPath, [
    "- [x] Oldest task",
    "- [x] Middle task",
    "- [x] Newest task",
    "",
  ].join("\n"), "utf-8");

  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });

  writeSavedRun(workspace, {
    runId: "run-20260411T160000000Z-oldest",
    startedAt: "2026-04-11T16:00:00.000Z",
    status: "completed",
    taskText: "Oldest task",
    taskLine: 1,
    taskIndex: 0,
  });
  writeSavedRun(workspace, {
    runId: "run-20260411T160100000Z-middle",
    startedAt: "2026-04-11T16:01:00.000Z",
    status: "completed",
    taskText: "Middle task",
    taskLine: 2,
    taskIndex: 1,
  });
  writeSavedRun(workspace, {
    runId: "run-20260411T160200000Z-newest",
    startedAt: "2026-04-11T16:02:00.000Z",
    status: "completed",
    taskText: "Newest task",
    taskLine: 3,
    taskIndex: 2,
  });
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

function listFilesRecursively(rootDir: string): string[] {
  const directories: string[] = [rootDir];
  const files: string[] = [];

  while (directories.length > 0) {
    const currentDir = directories.pop();
    if (!currentDir) {
      continue;
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

function readGlobalOutputLogEntries(workspace: string): Array<{
  command: string;
  level: string;
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
      level?: unknown;
      kind?: unknown;
      stream?: unknown;
      message?: unknown;
    })
    .map((entry) => ({
      command: typeof entry.command === "string" ? entry.command : "",
      level: typeof entry.level === "string" ? entry.level : "",
      kind: typeof entry.kind === "string" ? entry.kind : "",
      stream: typeof entry.stream === "string" ? entry.stream : "",
      message: typeof entry.message === "string" ? entry.message : "",
    }));
}

function readRawGlobalOutputLogEntries(workspace: string): Record<string, unknown>[] {
  const outputLogPath = path.join(workspace, ".rundown", "logs", "output.jsonl");
  if (!fs.existsSync(outputLogPath)) {
    return [];
  }

  return fs.readFileSync(outputLogPath, "utf-8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function expectGlobalOutputLogInvocationEntries(
  workspace: string,
  expected: {
    command: string;
    argv: string[];
    cwd: string;
  },
): void {
  const entries = readRawGlobalOutputLogEntries(workspace);
  expect(entries.length).toBeGreaterThan(0);

  const sessionIds = new Set<string>();
  const pids = new Set<number>();

  for (const entry of entries) {
    expect(Object.keys(entry).sort()).toEqual(GLOBAL_OUTPUT_LOG_EXPECTED_KEYS);

    expect(typeof entry.ts).toBe("string");
    expect(Number.isNaN(Date.parse(String(entry.ts)))).toBe(false);
    expect(["info", "warn", "error"]).toContain(entry.level);
    expect(["stdout", "stderr"]).toContain(entry.stream);
    expect(typeof entry.kind).toBe("string");
    expect(typeof entry.message).toBe("string");

    expect(entry.command).toBe(expected.command);
    expect(entry.argv).toEqual(expected.argv);
    expect(entry.cwd).toBe(expected.cwd);

    expect(typeof entry.pid).toBe("number");
    expect(Number.isInteger(entry.pid)).toBe(true);
    pids.add(entry.pid as number);

    expect(typeof entry.version).toBe("string");
    expect(String(entry.version).length).toBeGreaterThan(0);

    expect(typeof entry.session_id).toBe("string");
    expect(String(entry.session_id).length).toBeGreaterThan(0);
    sessionIds.add(entry.session_id as string);
  }

  expect(pids.size).toBe(1);
  expect([...pids][0]).toBe(process.pid);
  expect(sessionIds.size).toBe(1);
}

function expectCommandGroupEventsToBePaired(
  workspace: string,
  commandName: string,
  options: { expectedPairs?: number; minPairs?: number },
): void {
  const entries = readGlobalOutputLogEntries(workspace)
    .filter((entry) => entry.command === commandName);
  const groupStarts = entries.filter((entry) => entry.kind === "group-start");
  const groupEnds = entries.filter((entry) => entry.kind === "group-end");

  if (options.expectedPairs !== undefined) {
    expect(groupStarts.length).toBe(options.expectedPairs);
    expect(groupEnds.length).toBe(options.expectedPairs);
  }

  if (options.minPairs !== undefined) {
    expect(groupStarts.length).toBeGreaterThanOrEqual(options.minPairs);
    expect(groupEnds.length).toBeGreaterThanOrEqual(options.minPairs);
  }

  expect(groupStarts.length).toBe(groupEnds.length);
  expect(groupStarts.length).toBeGreaterThan(0);
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
