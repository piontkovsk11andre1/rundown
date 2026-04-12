import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPredictionBaseline, type PredictionInputs } from "../../src/domain/prediction-reconciliation.js";

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
const cliSource = fs.existsSync(CLI_FILE_PATH)
  ? fs.readFileSync(CLI_FILE_PATH, "utf-8")
  : "";
const hasMigrateCommand = fs.existsSync(CLI_FILE_PATH)
  && cliSource.includes('.command("migrate")');
const hasMigrateTaskUseCase = fs.existsSync(MIGRATE_TASK_FILE_PATH);
const describeIfMigrateAvailable = hasMigrateCommand && hasMigrateTaskUseCase ? describe : describe.skip;
const SATELLITE_ACTIONS = ["context", "snapshot", "backlog", "review", "user-experience"] as const;
const hasMigrateSatelliteActions = SATELLITE_ACTIONS.every((action) => cliSource.includes(action));
const describeIfSatelliteMigrateAvailable = hasMigrateCommand
  && hasMigrateTaskUseCase
  && hasMigrateSatelliteActions
  ? describe
  : describe.skip;
const hasMigrateUserSessionAction = cliSource.includes("user-session");
const hasMigrateConfirmOption = cliSource.includes("--confirm");
const describeIfUserSessionMigrateAvailable = hasMigrateCommand
  && hasMigrateTaskUseCase
  && hasMigrateUserSessionAction
  && hasMigrateConfirmOption
  ? describe
  : describe.skip;

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

  it("reconciles pending predictions before migrate up after a manual mid-run TODO change", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectForReconciliation(workspace);

    writePredictionBaselineSnapshot(workspace, {
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: false },
        { number: 3, name: "feature-b", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0001-initialize.md",
          migrationNumber: 1,
          kind: "migration",
          content: "# 0001 initialize\n\n- [x] bootstrap\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "# 0002 feature-a\n\n- [ ] implement feature a\n",
        },
        {
          relativePath: "migrations/0002--snapshot.md",
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot 0002 old\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "# 0003 feature-b\n\n- [ ] implement feature b\n",
        },
        {
          relativePath: "migrations/0003--snapshot.md",
          migrationNumber: 3,
          kind: "snapshot",
          content: "# Snapshot 0003 old\n",
        },
      ],
    });

    fs.writeFileSync(
      path.join(workspace, "migrations", "0001-initialize.md"),
      "# 0001 initialize\n\n- [x] bootstrap\n- [x] hotfix added mid-run\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "up",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildMigrateUpReconciliationWorkerScript(),
    ], workspace);

    expect(result.code).toBe(0);

    expect(fs.existsSync(path.join(workspace, "migrations", "0002-feature-a.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", "0003-feature-b.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", "0002-feature-a-reconciled.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", "0003-feature-b-reconciled.md"))).toBe(true);
    expect(fs.readFileSync(path.join(workspace, "migrations", "0001-initialize.md"), "utf-8")).toContain("hotfix added mid-run");

    const markerPath = path.join(workspace, ".migrate-up-reconcile.seq");
    expect(fs.existsSync(markerPath)).toBe(true);
    const marker = Number.parseInt(fs.readFileSync(markerPath, "utf-8"), 10);
    expect(marker).toBeGreaterThanOrEqual(3);
  });
});

describeIfSatelliteMigrateAvailable("migrate satellite regeneration integration", () => {
  for (const action of SATELLITE_ACTIONS) {
    it(`rerunning migrate ${action} overwrites the same satellite file`, async () => {
      const workspace = makeTempWorkspace();
      scaffoldPredictionProjectWithSatelliteTemplates(workspace);

      const firstRunResult = await runCli([
        "migrate",
        action,
        "--dir",
        "migrations",
        "--",
        "node",
        "-e",
        buildSequencedWorkerScript(action),
      ], workspace);

      expect(firstRunResult.code).toBe(0);

      const secondRunResult = await runCli([
        "migrate",
        action,
        "--dir",
        "migrations",
        "--",
        "node",
        "-e",
        buildSequencedWorkerScript(action),
      ], workspace);

      expect(secondRunResult.code).toBe(0);

      const targetFile = path.join(workspace, "migrations", `0001--${action}.md`);
      expect(fs.existsSync(targetFile)).toBe(true);
      expect(fs.readFileSync(targetFile, "utf-8")).toContain(`generated-${action}-2`);

      const satelliteFiles = fs.readdirSync(path.join(workspace, "migrations"))
        .filter((entry) => /^\d{4}--.+\.md$/.test(entry))
        .filter((entry) => entry.endsWith(`--${action}.md`));

      expect(satelliteFiles).toStrictEqual([`0001--${action}.md`]);
    });
  }

  it("migrate context removes the previous context satellite before writing the new one", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectWithSatelliteTemplates(workspace);
    fs.writeFileSync(path.join(workspace, "migrations", "0002-next.md"), "# 0002 next\n\n- [ ] step\n", "utf-8");

    const result = await runCli([
      "migrate",
      "context",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildSequencedWorkerScript("context"),
    ], workspace);

    expect(result.code).toBe(0);

    const previousContext = path.join(workspace, "migrations", "0001--context.md");
    const newContext = path.join(workspace, "migrations", "0002--context.md");
    expect(fs.existsSync(previousContext)).toBe(false);
    expect(fs.existsSync(newContext)).toBe(true);
    expect(fs.readFileSync(newContext, "utf-8")).toContain("generated-context-1");
  });
});

describeIfUserSessionMigrateAvailable("migrate user-session integration", () => {
  it("triggers backlog rebuild after session and applies --confirm write gates in non-interactive mode", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectWithSatelliteTemplates(workspace);

    const result = await withTerminalTty(false, async () => runCli([
      "migrate",
      "user-session",
      "--confirm",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildUserSessionBacklogWorkerScript(),
    ], workspace));

    expect(result.code).toBe(0);

    const migrationPath = path.join(workspace, "migrations", "0001-initialize.md");
    const backlogPath = path.join(workspace, "migrations", "0001--backlog.md");

    expect(fs.readFileSync(migrationPath, "utf-8")).toContain("session-summary-2");
    expect(fs.readFileSync(backlogPath, "utf-8")).toContain("session-backlog-3");

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("session-summary-2");
    expect(combinedOutput).toContain("session-backlog-3");
  });
});

const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function scaffoldPredictionProject(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nSeed design context.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", "0001-initialize.md"), "# 0001 initialize\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--context.md"), "# Context\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--backlog.md"), "# Backlog\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".rundown", "migrate.md"), "{{design}}\n{{latestContext}}\n{{migrationHistory}}\n", "utf-8");
}

function scaffoldPredictionProjectWithSatelliteTemplates(workspace: string): void {
  scaffoldPredictionProject(workspace);

  fs.writeFileSync(path.join(workspace, ".rundown", "migrate-context.md"), "{{latestMigration}}\n", "utf-8");
  fs.writeFileSync(path.join(workspace, ".rundown", "migrate-snapshot.md"), "{{migrationHistory}}\n", "utf-8");
  fs.writeFileSync(path.join(workspace, ".rundown", "migrate-backlog.md"), "{{design}}\n", "utf-8");
  fs.writeFileSync(path.join(workspace, ".rundown", "migrate-review.md"), "{{latestContext}}\n", "utf-8");
  fs.writeFileSync(path.join(workspace, ".rundown", "migrate-ux.md"), "{{latestMigration}}\n", "utf-8");
}

function scaffoldPredictionProjectForReconciliation(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nReconciliation test project.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", "0001-initialize.md"), "# 0001 initialize\n\n- [x] bootstrap\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--context.md"), "# Context 0001\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--backlog.md"), "# Backlog 0001\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0001--snapshot.md"), "# Snapshot 0001\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0002-feature-a.md"), "# 0002 feature-a\n\n- [ ] implement feature a\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0002--snapshot.md"), "# Snapshot 0002 old\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0003-feature-b.md"), "# 0003 feature-b\n\n- [ ] implement feature b\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "0003--snapshot.md"), "# Snapshot 0003 old\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
}

function writePredictionBaselineSnapshot(workspace: string, inputs: PredictionInputs): void {
  const baseline = createPredictionBaseline(inputs);
  const baselineDir = path.join(workspace, "migrations", ".rundown");
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.writeFileSync(path.join(baselineDir, "prediction-baseline.json"), JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}

function buildSequencedWorkerScript(action: string): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    `const action=${JSON.stringify(action)};`,
    "const markerPath=path.join(process.cwd(),`.satellite-${action}.seq`);",
    "let sequence=1;",
    "if(fs.existsSync(markerPath)){",
    "  sequence=Number.parseInt(fs.readFileSync(markerPath,'utf-8'),10)+1;",
    "}",
    "fs.writeFileSync(markerPath,String(sequence));",
    "console.log(`# ${action}`);",
    "console.log('');",
    "console.log(`generated-${action}-${sequence}`);",
    "process.exit(0);",
  ].join("\n");
}

function buildUserSessionBacklogWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const markerPath=path.join(process.cwd(),'.user-session.seq');",
    "let sequence=1;",
    "if(fs.existsSync(markerPath)){",
    "  sequence=Number.parseInt(fs.readFileSync(markerPath,'utf-8'),10)+1;",
    "}",
    "fs.writeFileSync(markerPath,String(sequence));",
    "if(sequence===1){",
    "  console.log('# Session Discussion');",
    "  console.log('');",
    "  console.log('session-discussion-1');",
    "  process.exit(0);",
    "}",
    "if(sequence===2){",
    "  console.log('# Session Summary');",
    "  console.log('');",
    "  console.log('session-summary-2');",
    "  process.exit(0);",
    "}",
    "console.log('# Backlog');",
    "console.log('');",
    "console.log('session-backlog-3');",
    "process.exit(0);",
  ].join("\n");
}

function buildMigrateUpReconciliationWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const markerPath=path.join(process.cwd(),'.migrate-up-reconcile.seq');",
    "let sequence=1;",
    "if(fs.existsSync(markerPath)){",
    "  sequence=Number.parseInt(fs.readFileSync(markerPath,'utf-8'),10)+1;",
    "}",
    "fs.writeFileSync(markerPath,String(sequence));",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "if(prompt.includes('Re-resolve the remaining pending migration prediction sequence.')){",
    "  console.log(JSON.stringify({migrations:[",
    "    {number:2,name:'feature-a-reconciled',migration:'# 0002 feature-a-reconciled\\n\\n- [ ] implement feature a reconciled\\n',snapshot:'# Snapshot 0002 reconciled\\n'},",
    "    {number:3,name:'feature-b-reconciled',migration:'# 0003 feature-b-reconciled\\n\\n- [ ] implement feature b reconciled\\n',snapshot:'# Snapshot 0003 reconciled\\n'}",
    "  ]}));",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
    "process.exit(0);",
  ].join("\n");
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
