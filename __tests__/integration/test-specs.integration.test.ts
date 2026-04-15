import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMigrationFilename, formatSatelliteFilename } from "../../src/domain/migration-parser.js";

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
  it("rundown test resolves linked workspace and configured specs directory", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(sandbox, "source-workspace");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });

    fs.mkdirSync(path.join(sourceWorkspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(sourceWorkspace, ".rundown", "config.json"),
      JSON.stringify({
        workspace: {
          directories: {
            design: "design-docs",
            specs: "quality/specs",
            migrations: "changesets",
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(sourceWorkspace, ".rundown", "test-verify.md"), "{{assertion}}", "utf-8");

    fs.mkdirSync(path.join(sourceWorkspace, "changesets"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, "changesets", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspace, "changesets", formatSatelliteFilename(1, "context")), "# Context\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspace, "changesets", formatSatelliteFilename(1, "snapshot")), "# Snapshot\n", "utf-8");

    fs.mkdirSync(path.join(sourceWorkspace, "quality", "specs"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, "quality", "specs", "linked.md"), "linked assertion", "utf-8");

    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );

    const result = await runCli([
      "test",
      "--",
      "node",
      "-e",
      "console.log('OK');process.exit(0);",
    ], linkedInvocationDir);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("PASS linked.md");
  });

  it("rundown test uses configured workspace specs directory when --dir is omitted", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workspace: {
          directories: {
            design: "design-docs",
            specs: "quality-specs",
            migrations: "changesets",
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );
    fs.writeFileSync(path.join(workspace, ".rundown", "test-verify.md"), "{{assertion}}", "utf-8");

    fs.mkdirSync(path.join(workspace, "quality-specs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "quality-specs", "configured-dir.md"), "configured assertion", "utf-8");

    const result = await runCli([
      "test",
      "--",
      "node",
      "-e",
      "console.log('OK');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("PASS configured-dir.md");
  });

  it("rundown test reports pass/fail summary and returns failure when any spec fails", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace);
    fs.mkdirSync(path.join(workspace, "specs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "specs", "pass.md"), "assertion pass", "utf-8");
    fs.writeFileSync(path.join(workspace, "specs", "fail.md"), "assertion fail", "utf-8");

    const result = await runCli([
      "test",
      "--future",
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

  it("rundown test resolves design from design/current and ignores revision archives without root Design.md", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace, { template: "{{design}}" });
    fs.rmSync(path.join(workspace, "Design.md"), { force: true });
    fs.mkdirSync(path.join(workspace, "design", "current"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "design", "rev.1"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "design", "current", "Target.md"), "# Current design\n\nPrimary current design.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "current", "a-notes.md"), "Current notes A.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "current", "z-notes.md"), "Current notes Z.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "rev.1", "Target.md"), "# Revision design\n\nArchived revision content.\n", "utf-8");
    fs.mkdirSync(path.join(workspace, "specs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "specs", "design-source.md"), "assert design source", "utf-8");

    const result = await runCli([
      "test",
      "--future",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      [
        "const fs=require('node:fs');",
        "const p=process.argv[process.argv.length-1];",
        "const prompt=fs.readFileSync(p,'utf-8');",
        "const hasCurrent=prompt.includes('Primary current design.')&&prompt.includes('Current notes A.')&&prompt.includes('Current notes Z.');",
        "const hasRevision=prompt.includes('Archived revision content.');",
        "const aIndex=prompt.indexOf('### a-notes.md');",
        "const zIndex=prompt.indexOf('### z-notes.md');",
        "const ordered=aIndex>=0&&zIndex>=0&&aIndex<zIndex;",
        "if(hasCurrent&&!hasRevision&&ordered){console.log('OK');process.exit(0);}",
        "console.log('NOT_OK: expected design/current context in deterministic order without revision archive content');process.exit(0);",
      ].join(""),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "Design.md"))).toBe(false);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("PASS design-source.md");
  });

  it("rundown test falls back to root Design.md when docs/current is absent", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace, { template: "{{design}}" });
    fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nLegacy fallback design source.\n", "utf-8");
    fs.mkdirSync(path.join(workspace, "specs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "specs", "legacy-design-source.md"), "assert legacy design source", "utf-8");

    const result = await runCli([
      "test",
      "--future",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      [
        "const fs=require('node:fs');",
        "const p=process.argv[process.argv.length-1];",
        "const prompt=fs.readFileSync(p,'utf-8');",
        "const hasLegacy=prompt.includes('Legacy fallback design source.');",
        "const hasManaged=prompt.includes('### design/current/Target.md')||prompt.includes('design/current');",
        "if(hasLegacy&&!hasManaged){console.log('OK');process.exit(0);}",
        "console.log('NOT_OK: expected root Design.md fallback without managed design context');process.exit(0);",
      ].join(""),
    ], workspace);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("PASS legacy-design-source.md");
  });

  it("rundown test warns clearly when design/current exists but draft is empty", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace, { template: "{{assertion}}" });
    fs.rmSync(path.join(workspace, "Design.md"), { force: true });
    fs.mkdirSync(path.join(workspace, "design", "current"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "specs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "specs", "empty-draft.md"), "assert empty draft guidance", "utf-8");

    const result = await runCli([
      "test",
      "--future",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      "console.log('OK');process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Design draft is empty: design/current/ has no files.");
    expect(combinedOutput).toContain("PASS empty-draft.md");
  });

  it("rundown test template receives canonical design source references and managed flag", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace, {
      template: "HAS_MANAGED={{designContextHasManagedDocs}}\nSOURCES={{designContextSourceReferences}}\nSOURCES_JSON={{designContextSourceReferencesJson}}",
    });
    fs.rmSync(path.join(workspace, "Design.md"), { force: true });
    fs.mkdirSync(path.join(workspace, "design", "current"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "design", "rev.1"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "design", "current", "Target.md"), "# Current design\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "rev.1", "Target.md"), "# Snapshot\n", "utf-8");
    fs.mkdirSync(path.join(workspace, "specs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "specs", "design-sources.md"), "assert design source refs", "utf-8");

    const result = await runCli([
      "test",
      "--future",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      [
        "const fs=require('node:fs');",
        "const p=process.argv[process.argv.length-1];",
        "const prompt=fs.readFileSync(p,'utf-8');",
        "const hasManaged=prompt.includes('HAS_MANAGED=true');",
        "const hasCurrent=/design[\\\\/]current/.test(prompt);",
        "const hasRevision=/design[\\\\/]rev\\.1/.test(prompt);",
        "if(hasManaged&&hasCurrent&&hasRevision){console.log('OK');process.exit(0);}",
        "console.log('NOT_OK: expected canonical design source references in test prompt');process.exit(0);",
      ].join(""),
    ], workspace);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("PASS design-sources.md");
  });

  it("rundown test --future <n> uses previous snapshot plus migrations up to target", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictedState(workspace, {
      template: "MODE={{testMode}}\nTARGET={{futureTarget}}\nSNAP={{latestSnapshot}}\nHISTORY={{migrationHistory}}",
    });
    fs.mkdirSync(path.join(workspace, "specs"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "specs", "future-target.md"), "assert targeted future", "utf-8");

    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "add-feature")), "# 0002 add feature\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "snapshot")), "SNAP-1\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(2, "snapshot")), "SNAP-2\n", "utf-8");

    const result = await runCli([
      "test",
      "--future",
      "2",
      "--dir",
      "specs",
      "--",
      "node",
      "-e",
      [
        "const fs=require('node:fs');",
        "const p=process.argv[process.argv.length-1];",
        "const prompt=fs.readFileSync(p,'utf-8');",
        "const hasMode=prompt.includes('MODE=future');",
        "const hasTarget=prompt.includes('TARGET=2');",
        "const hasSnapshotOne=prompt.includes('SNAP-1');",
        "const hasSnapshotTwo=prompt.includes('SNAP-2');",
        "const hasMigrationOne=prompt.includes('1. Initialize.md');",
        "const hasMigrationTwo=prompt.includes('2. Add Feature.md');",
        "if(hasMode&&hasTarget&&hasSnapshotOne&&!hasSnapshotTwo&&!hasMigrationOne&&hasMigrationTwo){console.log('OK');process.exit(0);}",
        "console.log('NOT_OK: expected previous snapshot with migrations up to target');process.exit(0);",
      ].join(""),
    ], workspace);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("PASS future-target.md");
  });
});

function scaffoldPredictedState(workspace: string, options?: { template?: string }): void {
  const template = options?.template ?? "{{assertion}}";
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nSeed design context.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "context")), "# Context\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "snapshot")), "# Snapshot\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".rundown", "test-verify.md"), template, "utf-8");
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
