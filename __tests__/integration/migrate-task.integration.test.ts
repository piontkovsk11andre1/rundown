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
const hasMigrateSaveAction = cliSource.includes("save");
const hasMigrateConfirmOption = cliSource.includes("--confirm");
const describeIfUserSessionMigrateAvailable = hasMigrateCommand
  && hasMigrateTaskUseCase
  && hasMigrateUserSessionAction
  && hasMigrateConfirmOption
  ? describe
  : describe.skip;
const describeIfSaveMigrateAvailable = hasMigrateCommand
  && hasMigrateTaskUseCase
  && hasMigrateSaveAction
  ? describe
  : describe.skip;

describeIfMigrateAvailable("migrate-task integration", () => {
  it("generates migrations from managed docs context without requiring root Design.md", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "docs", "current"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Current design\n\nManaged docs design source.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "api.md"), "Current API details.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "# Revision\n\nLegacy revision text.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", "0001-initialize.md"), "# 0001 initialize\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", "0001--context.md"), "# Context\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", "0001--backlog.md"), "# Backlog\n", "utf-8");
    fs.writeFileSync(
      path.join(workspace, ".rundown", "migrate.md"),
      [
        "DESIGN={{design}}",
        "HAS_MANAGED={{designContextHasManagedDocs}}",
        "SOURCES={{designContextSourceReferences}}",
        "DIFF={{revisionDiffSummary}}",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildTemplateVarsAssertionWorkerScript(),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "Design.md"))).toBe(false);

    const capturedPrompt = fs.readFileSync(path.join(workspace, ".template-vars-prompt.txt"), "utf-8");
    expect(capturedPrompt).toContain("Managed docs design source.");
    expect(capturedPrompt).toContain("Current API details.");
    expect(capturedPrompt).not.toContain("Legacy revision text.");
    expect(capturedPrompt).toContain("HAS_MANAGED=true");
    expect(capturedPrompt).toContain("SOURCES=- ");
    expect(capturedPrompt).toMatch(/docs[\\/]current/);
    expect(capturedPrompt).toMatch(/docs[\\/]rev\.1/);
    expect(capturedPrompt).toContain("DIFF=Compared rev.1 -> current:");
    expect(fs.existsSync(path.join(workspace, "migrations", "0002-template-vars-checked.md"))).toBe(true);
  });

  it("exposes revision-aware migrate template aliases without breaking legacy fields", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);

    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "# Design\n\nVersion one.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Design\n\nVersion two.\n", "utf-8");

    fs.writeFileSync(
      path.join(workspace, ".rundown", "migrate.md"),
      [
        "CURRENT={{currentRevisionId}}",
        "PREVIOUS={{previousRevisionId}}",
        "SUMMARY={{revisionDiffSummary}}",
        "SOURCES={{revisionDiffSourceReferences}}",
        "SOURCES_JSON={{revisionDiffSourceReferencesJson}}",
        "DESIGN_SOURCES={{designContextSourceReferences}}",
        "DESIGN_SOURCES_JSON={{designContextSourceReferencesJson}}",
        "HAS_MANAGED_DOCS={{designContextHasManagedDocs}}",
        "LEGACY_SUMMARY={{designRevisionDiffSummary}}",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildTemplateVarsAssertionWorkerScript(),
    ], workspace);

    expect(result.code).toBe(0);
    const capturedPrompt = fs.readFileSync(path.join(workspace, ".template-vars-prompt.txt"), "utf-8");
    expect(capturedPrompt).toContain("CURRENT=current");
    expect(capturedPrompt).toContain("PREVIOUS=rev.1");
    expect(capturedPrompt).toContain("SUMMARY=Compared rev.1 -> current: 0 added 1 modified 0 removed");
    expect(capturedPrompt).toContain("SOURCES=- ");
    expect(capturedPrompt).toContain("SOURCES_JSON=[");
    expect(capturedPrompt).toContain("DESIGN_SOURCES=- ");
    expect(capturedPrompt).toMatch(/docs[\\/]current/);
    expect(capturedPrompt).toMatch(/docs[\\/]rev\.1/);
    expect(capturedPrompt).toContain("DESIGN_SOURCES_JSON=[");
    expect(capturedPrompt).toContain("HAS_MANAGED_DOCS=true");
    expect(capturedPrompt).toContain("LEGACY_SUMMARY=Compared rev.1 -> current: 0 added 1 modified 0 removed");
    expect(fs.existsSync(path.join(workspace, "migrations", "0002-template-vars-checked.md"))).toBe(true);
  });

  it("falls back to root Design.md when managed docs directories are absent", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nLegacy single-file design source.\n", "utf-8");

    fs.writeFileSync(
      path.join(workspace, ".rundown", "migrate.md"),
      [
        "DESIGN={{design}}",
        "HAS_MANAGED={{designContextHasManagedDocs}}",
        "SOURCES={{designContextSourceReferences}}",
      ].join("\n") + "\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildTemplateVarsAssertionWorkerScript(),
    ], workspace);

    expect(result.code).toBe(0);

    const capturedPrompt = fs.readFileSync(path.join(workspace, ".template-vars-prompt.txt"), "utf-8");
    expect(capturedPrompt).toContain("Legacy single-file design source.");
    expect(capturedPrompt).toContain("HAS_MANAGED=false");
    expect(capturedPrompt).toContain("SOURCES=- ");
    expect(capturedPrompt).toMatch(/Design\.md/);
    expect(capturedPrompt).not.toMatch(/docs[\\/]current/);
    expect(fs.existsSync(path.join(workspace, "migrations", "0002-template-vars-checked.md"))).toBe(true);
  });

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
  it("resolves migrate paths and worker runtime against linked workspace roots", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(sandbox, "source-workspace");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldPredictionProjectWithSatelliteTemplates(sourceWorkspace);

    const linkedConfigDir = path.join(linkedInvocationDir, ".rundown");
    fs.mkdirSync(linkedConfigDir, { recursive: true });
    const relativeWorkspaceTarget = path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/");
    fs.writeFileSync(path.join(linkedConfigDir, "workspace.link"), relativeWorkspaceTarget, "utf-8");

    const result = await runCli([
      "migrate",
      "snapshot",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      [
        "const fs=require('node:fs');",
        "const path=require('node:path');",
        "fs.writeFileSync(path.join(process.cwd(),'.workspace-cwd-marker'),'ok','utf-8');",
        "console.log('# Snapshot');",
        "console.log('');",
        "console.log('linked-workspace-resolution-ok');",
        "process.exit(0);",
      ].join("\n"),
    ], linkedInvocationDir);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(sourceWorkspace, "migrations", "0001--snapshot.md"))).toBe(true);
    expect(fs.existsSync(path.join(linkedInvocationDir, "migrations", "0001--snapshot.md"))).toBe(false);
    expect(fs.existsSync(path.join(sourceWorkspace, ".workspace-cwd-marker"))).toBe(true);
    expect(fs.existsSync(path.join(linkedInvocationDir, ".workspace-cwd-marker"))).toBe(false);
  });

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

describeIfSaveMigrateAvailable("migrate save integration", () => {
  it("snapshots docs/current into the next monotonic docs/rev.N directory", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.mkdirSync(path.join(workspace, "docs", "current", "notes"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "rev.3"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Current design\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "notes", "api.md"), "API details\n", "utf-8");

    const result = await runCli([
      "migrate",
      "save",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      "process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "docs", "rev.4", "Design.md"), "utf-8")).toBe("# Current design\n");
    expect(fs.readFileSync(path.join(workspace, "docs", "rev.4", "notes", "api.md"), "utf-8")).toBe("API details\n");
  });

  it("fails with a clear message when docs/current is missing", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.rmSync(path.join(workspace, "docs"), { recursive: true, force: true });

    const result = await runCli([
      "migrate",
      "save",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      "process.exit(0);",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Design working directory is missing:");
    expect(combinedOutput).toContain("docs/current");
  });

  it("reports a no-op when docs/current is unchanged from latest revision", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.mkdirSync(path.join(workspace, "docs", "current", "notes"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "rev.2", "notes"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Current design\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "notes", "api.md"), "API details\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.2", "Design.md"), "# Current design\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.2", "notes", "api.md"), "API details\n", "utf-8");

    const result = await runCli([
      "migrate",
      "save",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      "process.exit(0);",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "docs", "rev.3"))).toBe(false);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("No design changes detected in docs/current/");
    expect(combinedOutput).toContain("rev.2");
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

function buildTemplateVarsAssertionWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "const capturedPath=path.join(process.cwd(),'.template-vars-prompt.txt');",
    "if(!fs.existsSync(capturedPath)){",
    "  fs.writeFileSync(capturedPath,prompt,'utf-8');",
    "}",
    "if(prompt.includes('updating migration context incrementally')){",
    "  console.log('# Context');",
    "  process.exit(0);",
    "}",
    "console.log('1. template-vars-checked');",
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
