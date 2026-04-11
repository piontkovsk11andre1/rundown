import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

const CLI_FILE_PATH = path.resolve(process.cwd(), "src/presentation/cli.ts");
const TEST_SPECS_FILE_PATH = path.resolve(process.cwd(), "src/application/test-specs.ts");
const hasTestCommand = fs.existsSync(CLI_FILE_PATH)
  && fs.readFileSync(CLI_FILE_PATH, "utf-8").includes('.command("test")');
const hasTestSpecsUseCase = fs.existsSync(TEST_SPECS_FILE_PATH);
const describeIfTestSpecsAvailable = hasTestCommand && hasTestSpecsUseCase ? describe : describe.skip;

describeIfTestSpecsAvailable("test-specs integration", () => {
  it("rundown test reports pass/fail summary and returns failure when any spec fails", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace);
    fs.mkdirSync(path.join(workspace, "specs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "specs", "pass.md"), "assertion pass", "utf-8");
    fs.writeFileSync(path.join(workspace, "specs", "fail.md"), "assertion fail", "utf-8");

    const result = await runCli([
      "test",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      "const fs=require('node:fs');const p=process.argv[process.argv.length-1];const prompt=fs.readFileSync(p,'utf-8');if(prompt.includes('assertion fail')){console.log('NOT_OK: assertion does not hold');process.exit(0);}console.log('OK');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));

    expect(combinedOutput).toContain("pass.md");
    expect(combinedOutput).toContain("fail.md");
    expect(combinedOutput).toMatch(/passed/i);
    expect(combinedOutput).toMatch(/failed/i);
  });

  it("rundown test new --run creates a spec file and verifies it immediately", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace);

    const result = await runCli([
      "test",
      "new",
      "User can upload files",
      "--run",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      "console.log('OK');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    const createdSpecPath = path.join(workspace, "specs", "user-can-upload-files.md");
    expect(fs.existsSync(createdSpecPath)).toBe(true);
    expect(fs.readFileSync(createdSpecPath, "utf-8")).toContain("User can upload files");

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("user-can-upload-files.md");
    expect(combinedOutput).toMatch(/ok|pass/i);
  });

  it("rundown test new writes a slugged spec in specs/", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace);

    const result = await runCli([
      "test",
      "new",
      "User can export reports",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      "console.log('OK');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    const createdSpecPath = path.join(workspace, "specs", "user-can-export-reports.md");
    expect(fs.existsSync(createdSpecPath)).toBe(true);
    expect(fs.readFileSync(createdSpecPath, "utf-8")).toContain("User can export reports");

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("user-can-export-reports.md");
  });

  it("rundown test new without prompt fails without writing a spec", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace);

    const result = await runCli([
      "test",
      "new",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      "console.log('OK');process.exit(0);",
    ], workspace);

    expect(result.code).not.toBe(0);
    expect(fs.existsSync(path.join(workspace, "specs"))).toBe(false);

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Missing assertion text for `test new`.");
  });
});

function scaffoldPredictedState(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nSeed design context.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", "0001-initialize.md"), "# 0001 initialize\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--context.md"), "# Context\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--snapshot.md"), "# Snapshot\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".rundown", "test-verify.md"), "{{assertion}}", "utf-8");
}

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-test-specs-int-"));
  tempDirs.push(dir);
  return dir;
}

const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

async function runCli(args: string[], cwd: string): Promise<{
  code: number;
  logs: string[];
  errors: string[];
  stdoutWrites: string[];
  stderrWrites: string[];
}> {
  const previousCwd = process.cwd();
  const previousDisableAutoParse = process.env.RUNDOWN_DISABLE_AUTO_PARSE;
  const previousTestMode = process.env.RUNDOWN_TEST_MODE;

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

    if (previousDisableAutoParse === undefined) {
      delete process.env.RUNDOWN_DISABLE_AUTO_PARSE;
    } else {
      process.env.RUNDOWN_DISABLE_AUTO_PARSE = previousDisableAutoParse;
    }

    if (previousTestMode === undefined) {
      delete process.env.RUNDOWN_TEST_MODE;
    } else {
      process.env.RUNDOWN_TEST_MODE = previousTestMode;
    }
  }
}
