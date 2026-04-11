import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
const START_TASK_FILE_PATH = path.resolve(process.cwd(), "src/application/start-project.ts");
const cliSource = fs.existsSync(CLI_FILE_PATH)
  ? fs.readFileSync(CLI_FILE_PATH, "utf-8")
  : "";
const hasStartCommand = fs.existsSync(CLI_FILE_PATH)
  && cliSource.includes('.command("start")');
const hasStartTaskUseCase = fs.existsSync(START_TASK_FILE_PATH);
const describeIfStartAvailable = hasStartCommand && hasStartTaskUseCase ? describe : describe.skip;

describeIfStartAvailable("start-project integration", () => {
  it("does not create nested .git when scaffolding inside an existing repository", async () => {
    const workspace = makeTempWorkspace();
    const projectDirName = "prediction-project";
    const projectDir = path.join(workspace, projectDirName);

    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@rundown.dev"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "rundown test"], { cwd: workspace, stdio: "ignore" });

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
      "console.log('ok');",
      "process.exit(0);",
    ].join("\n");

    const result = await runCli([
      "start",
      "Test prediction project",
      "--dir",
      projectDirName,
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, ".git"))).toBe(false);

    expect(fs.existsSync(path.join(projectDir, "Design.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "AGENTS.md"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "specs"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "migrations"))).toBe(true);
    expect(fs.existsSync(path.join(projectDir, "migrations", "0001-initialize.md"))).toBe(true);
  });
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-start-int-"));
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
      && "code" in error
      && typeof (error as { code?: unknown }).code === "number"
      && "message" in error
      && typeof (error as { message?: unknown }).message === "string"
      && (error as { message: string }).message.startsWith("CLI exited with code ")
    ) {
      return {
        code: (error as { code: number }).code,
        logs,
        errors,
        stdoutWrites,
        stderrWrites,
      };
    }

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
