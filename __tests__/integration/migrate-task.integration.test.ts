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
const MIGRATE_TASK_FILE_PATH = path.resolve(process.cwd(), "src/application/migrate-task.ts");
const hasMigrateCommand = fs.existsSync(CLI_FILE_PATH)
  && fs.readFileSync(CLI_FILE_PATH, "utf-8").includes('.command("migrate")');
const hasMigrateTaskUseCase = fs.existsSync(MIGRATE_TASK_FILE_PATH);
const describeIfMigrateAvailable = hasMigrateCommand && hasMigrateTaskUseCase ? describe : describe.skip;

describeIfMigrateAvailable("migrate-task integration", () => {
  it("falls back to the first ranked proposal in non-interactive mode", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);

    const workerScript = [
      "const fs=require('node:fs');",
      "const promptPath=process.argv[process.argv.length-1];",
      "const prompt=fs.readFileSync(promptPath,'utf-8');",
      "if(prompt.includes('Research and enrich the source document with implementation context.')){",
      "  const sourceMatch=prompt.match(/## Source file\\s+`([^`]+)`/m);",
      "  const sourcePath=sourceMatch?sourceMatch[1]:'';",
      "  if(sourcePath&&fs.existsSync(sourcePath)){",
      "    console.log(fs.readFileSync(sourcePath,'utf-8'));",
      "  }else{",
      "    console.log('');",
      "  }",
      "  process.exit(0);",
      "}",
      "if(prompt.includes('Edit the source Markdown file directly to improve plan coverage.')){",
      "  process.exit(0);",
      "}",
      "console.log('1. first-ranked-proposal');",
      "console.log('2. second-ranked-proposal');",
      "process.exit(0);",
    ].join("\n");

    const result = await withTerminalTty(false, async () => runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace));

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", "0002-first-ranked-proposal.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", "0002-second-ranked-proposal.md"))).toBe(false);
  });
});

function scaffoldPredictionProject(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nSeed design context.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", "0001-initialize.md"), "# 0001 initialize\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--context.md"), "# Context\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--backlog.md"), "# Backlog\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".rundown", "migrate.md"), "{{design}}\n{{latestContext}}\n{{migrationHistory}}\n", "utf-8");
}

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-migrate-int-"));
  tempDirs.push(dir);
  return dir;
}

async function withTerminalTty<T>(isTTY: boolean, callback: () => Promise<T>): Promise<T> {
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  const stderrDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    get: () => isTTY,
  });
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    get: () => isTTY,
  });
  Object.defineProperty(process.stdin, "isTTY", {
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

    if (stdinDescriptor) {
      Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
    } else {
      Reflect.deleteProperty(process.stdin, "isTTY");
    }
  }
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

    errors.push(String(error));
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
