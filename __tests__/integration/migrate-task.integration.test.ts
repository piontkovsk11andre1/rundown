import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPredictionBaseline, type PredictionInputs } from "../../src/domain/prediction-reconciliation.js";
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
const MIGRATE_TASK_FILE_PATH = path.resolve(process.cwd(), "src/application/migrate-task.ts");
const DOCS_TASK_FILE_PATH = path.resolve(process.cwd(), "src/application/docs-task.ts");
const cliSource = fs.existsSync(CLI_FILE_PATH)
  ? fs.readFileSync(CLI_FILE_PATH, "utf-8")
  : "";
const hasMigrateCommand = fs.existsSync(CLI_FILE_PATH)
  && cliSource.includes('.command("migrate")');
const hasMigrateTaskUseCase = fs.existsSync(MIGRATE_TASK_FILE_PATH);
const hasDocsTaskUseCase = fs.existsSync(DOCS_TASK_FILE_PATH);
const migrateActionHelpText = /Migration action:[^\n"]*/.exec(cliSource)?.[0] ?? "";
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
const hasDocsDiffCommand = cliSource.includes('.command("docs")') && cliSource.includes('.command("diff")');
const describeIfUserSessionMigrateAvailable = hasMigrateCommand
  && hasMigrateTaskUseCase
  && hasMigrateUserSessionAction
  && hasMigrateConfirmOption
  ? describe
  : describe.skip;
const describeIfDocsDiffAvailable = hasDocsTaskUseCase && hasDocsDiffCommand ? describe : describe.skip;

describeIfMigrateAvailable("migrate-task integration", () => {
  it("uses configured workspace migrations directory when --dir is omitted", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".rundown", "migrate.md"), "{{design}}", "utf-8");
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

    fs.mkdirSync(path.join(workspace, "changesets"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "changesets", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "changesets", formatSatelliteFilename(1, "context")), "# Context\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "changesets", formatSatelliteFilename(1, "backlog")), "# Backlog\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nSeed design context.\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--",
      "node",
      "-e",
      buildTemplateVarsAssertionWorkerScript(),
    ], workspace);

    expect([0, 3]).toContain(result.code);
    expect(fs.existsSync(path.join(workspace, "changesets", formatMigrationFilename(2, "template-vars-checked")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "template-vars-checked")))).toBe(false);
  });

  it("generates migrations from canonical design context and exposes design revision sources", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "design", "current"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "design", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "design", "current", "Target.md"), "# Current design\n\nManaged canonical design source.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "current", "api.md"), "Canonical API details.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "rev.1", "Target.md"), "# Revision\n\nCanonical revision text.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "context")), "# Context\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "backlog")), "# Backlog\n", "utf-8");
    fs.writeFileSync(
      path.join(workspace, ".rundown", "migrate.md"),
      [
        "DESIGN_DIR={{workspaceDesignDir}}",
        "SPECS_DIR={{workspaceSpecsDir}}",
        "MIGRATIONS_DIR={{workspaceMigrationsDir}}",
        "DESIGN_PATH={{workspaceDesignPath}}",
        "SPECS_PATH={{workspaceSpecsPath}}",
        "MIGRATIONS_PATH={{workspaceMigrationsPath}}",
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

    expect([0, 3]).toContain(result.code);

    const capturedPrompt = fs.readFileSync(path.join(workspace, ".template-vars-prompt.txt"), "utf-8");
    expect(capturedPrompt).toContain("Managed canonical design source.");
    expect(capturedPrompt).toContain("DESIGN_DIR=design");
    expect(capturedPrompt).toContain("SPECS_DIR=specs");
    expect(capturedPrompt).toContain("MIGRATIONS_DIR=migrations");
    expect(capturedPrompt).toMatch(/DESIGN_PATH=.*[\\/]design/);
    expect(capturedPrompt).toMatch(/SPECS_PATH=.*[\\/]specs/);
    expect(capturedPrompt).toMatch(/MIGRATIONS_PATH=.*[\\/]migrations/);
    expect(capturedPrompt).toContain("Canonical API details.");
    expect(capturedPrompt).not.toContain("Canonical revision text.");
    expect(capturedPrompt).toContain("HAS_MANAGED=true");
    expect(capturedPrompt).toContain("SOURCES=- ");
    expect(capturedPrompt).toMatch(/design[\\/]current/);
    expect(capturedPrompt).toMatch(/design[\\/]rev\.1/);
    expect(capturedPrompt).toContain("DIFF=Compared rev.1 -> current:");
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "template-vars-checked")))).toBe(true);
  });

  it("generates migrations from managed docs context without requiring root Design.md", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "docs", "current"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Current design\n\nManaged docs design source.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "api.md"), "Current API details.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "# Revision\n\nLegacy revision text.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "context")), "# Context\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "backlog")), "# Backlog\n", "utf-8");
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
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "template-vars-checked")))).toBe(true);
  });

  it("exposes revision-aware migrate template aliases without breaking legacy fields", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);

    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "# Design\n\nVersion one.\n", "utf-8");
    fs.writeFileSync(
      path.join(workspace, "docs", "rev.1.meta.json"),
      JSON.stringify({
        revision: "rev.1",
        index: 1,
        createdAt: "2026-01-02T03:04:05.000Z",
        label: "initial",
      }, null, 2) + "\n",
      "utf-8",
    );
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
        "CURRENT_CREATED_AT={{currentRevisionCreatedAt}}",
        "CURRENT_LABEL={{currentRevisionLabel}}",
        "CURRENT_METADATA_PATH={{currentRevisionMetadataPath}}",
        "PREVIOUS_CREATED_AT={{previousRevisionCreatedAt}}",
        "PREVIOUS_LABEL={{previousRevisionLabel}}",
        "PREVIOUS_METADATA_PATH={{previousRevisionMetadataPath}}",
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
    expect(capturedPrompt).toContain("CURRENT_CREATED_AT=");
    expect(capturedPrompt).toContain("CURRENT_LABEL=");
    expect(capturedPrompt).toContain("CURRENT_METADATA_PATH=");
    expect(capturedPrompt).toContain("PREVIOUS_CREATED_AT=2026-01-02T03:04:05.000Z");
    expect(capturedPrompt).toContain("PREVIOUS_LABEL=initial");
    expect(capturedPrompt).toContain("PREVIOUS_METADATA_PATH=");
    expect(capturedPrompt).toMatch(/PREVIOUS_METADATA_PATH=.*docs[\\/]rev\.1\.meta\.json/);
    expect(capturedPrompt).toContain("LEGACY_SUMMARY=Compared rev.1 -> current: 0 added 1 modified 0 removed");
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "template-vars-checked")))).toBe(true);
  });

  it("includes deterministic revision-aware diff preview inputs", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);

    fs.mkdirSync(path.join(workspace, "docs", "rev.1", "notes"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "current", "notes"), { recursive: true });

    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "zeta.md"), "Removed in current.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "notes", "changes.md"), "Unchanged notes.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "# Design\n\nOld body.\n", "utf-8");

    fs.writeFileSync(path.join(workspace, "docs", "current", "alpha.md"), "Added in current.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "notes", "changes.md"), "Unchanged notes.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Design\n\nNew body.\n", "utf-8");

    fs.writeFileSync(
      path.join(workspace, ".rundown", "migrate.md"),
      [
        "SUMMARY={{revisionDiffSummary}}",
        "HAS_COMPARISON={{designRevisionDiffHasComparison}}",
        "FROM={{designRevisionFromRevision}}",
        "TO={{designRevisionToTarget}}",
        "FILES={{designRevisionDiffFiles}}",
        "REV_SOURCES={{revisionDiffSourceReferences}}",
        "REV_SOURCES_JSON={{revisionDiffSourceReferencesJson}}",
        "DESIGN_SOURCES_JSON={{designContextSourceReferencesJson}}",
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
    expect(capturedPrompt).toContain("SUMMARY=Compared rev.1 -> current: 1 added 1 modified 1 removed");
    expect(capturedPrompt).toContain("HAS_COMPARISON=true");
    expect(capturedPrompt).toContain("FROM=rev.1");
    expect(capturedPrompt).toContain("TO=current");

    const filesIndex = capturedPrompt.indexOf("- added: alpha.md");
    const modifiedIndex = capturedPrompt.indexOf("- modified: Design.md");
    const removedIndex = capturedPrompt.indexOf("- removed: zeta.md");
    expect(filesIndex).toBeGreaterThanOrEqual(0);
    expect(modifiedIndex).toBeGreaterThan(filesIndex);
    expect(removedIndex).toBeGreaterThan(modifiedIndex);

    const revisionSources = readJsonLine(capturedPrompt, "REV_SOURCES_JSON=").map(normalizePathForAssertion);
    expect(revisionSources).toStrictEqual([
      normalizePathForAssertion(path.join(workspace, "docs", "rev.1")),
      normalizePathForAssertion(path.join(workspace, "docs", "current")),
    ]);

    const designSources = readJsonLine(capturedPrompt, "DESIGN_SOURCES_JSON=").map(normalizePathForAssertion);
    expect(designSources).toStrictEqual([
      normalizePathForAssertion(path.join(workspace, "docs", "current")),
      normalizePathForAssertion(path.join(workspace, "docs", "rev.1")),
    ]);

    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "template-vars-checked")))).toBe(true);
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
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "template-vars-checked")))).toBe(true);
  });

  it("renders previous revision as nothing when current has no predecessor revision", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.rmSync(path.join(workspace, "Design.md"), { force: true });
    fs.mkdirSync(path.join(workspace, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Design\n\nCurrent-only baseline.\n", "utf-8");

    fs.writeFileSync(
      path.join(workspace, ".rundown", "migrate.md"),
      [
        "PREVIOUS={{previousRevisionId}}",
        "FROM={{designRevisionFromRevision}}",
        "TO={{designRevisionToTarget}}",
        "SUMMARY={{revisionDiffSummary}}",
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
    expect(capturedPrompt).toContain("PREVIOUS=nothing");
    expect(capturedPrompt).toContain("FROM=nothing");
    expect(capturedPrompt).toContain("TO=current");
    expect(capturedPrompt).toContain("SUMMARY=Compared nothing -> current: 1 added 0 modified 0 removed");
  });

  it("emits low-context guidance when docs/current exists but has no files", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.rmSync(path.join(workspace, "Design.md"), { force: true });
    fs.mkdirSync(path.join(workspace, "docs", "current"), { recursive: true });

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
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "template-vars-checked")))).toBe(true);

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Design draft is empty: docs/current/ has no files.");
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
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "first-ranked-proposal")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "second-ranked-proposal")))).toBe(false);
  });

  it("uses commands.migrate-slug for migration naming while keeping commands.migrate for execution", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectWithSatelliteTemplates(workspace);
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", "-e", buildMigrateExecutionWorkerScript()],
        },
        commands: {
          "migrate-slug": ["node", "-e", buildMigrateSlugOnlyWorkerScript("dedicated-slug-worker")],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "dedicated-slug-worker")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "from-migrate-execution-worker")))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "migrations", formatSatelliteFilename(2, "context")), "utf-8")).toContain("from-migrate-execution-worker");
  });

  it("falls back to migrate worker for slug generation when commands.migrate-slug is not configured", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectWithSatelliteTemplates(workspace);
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", "-e", buildMigrateExecutionWorkerScript()],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "from-migrate-execution-worker")))).toBe(true);
  });

  it("keeps dedicated slug generation deterministic across repeated migrate runs", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectWithSatelliteTemplates(workspace);
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", "-e", buildMigrateExecutionWorkerScript()],
        },
        commands: {
          "migrate-slug": ["node", "-e", buildMigrateSlugOnlyWorkerScript("stable-dedicated-slug")],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const firstRun = await runCli([
      "migrate",
      "--dir",
      "migrations",
    ], workspace);
    const secondRun = await runCli([
      "migrate",
      "--dir",
      "migrations",
    ], workspace);

    expect(firstRun.code).toBe(0);
    expect(secondRun.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "stable-dedicated-slug")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "stable-dedicated-slug")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "from-migrate-execution-worker")))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "from-migrate-execution-worker")))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "migrations", formatSatelliteFilename(3, "context")), "utf-8")).toContain("from-migrate-execution-worker");
  });

  it("uses commands.migrate-slug during migrate up prediction reconciliation", async () => {
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
          relativePath: `migrations/${formatMigrationFilename(1, "initialize")}`,
          migrationNumber: 1,
          kind: "migration",
          content: "# 0001 initialize\n\n- [x] bootstrap\n",
        },
        {
          relativePath: `migrations/${formatMigrationFilename(2, "feature-a")}`,
          migrationNumber: 2,
          kind: "migration",
          content: "# 0002 feature-a\n\n- [ ] implement feature a\n",
        },
        {
          relativePath: `migrations/${formatSatelliteFilename(2, "snapshot")}`,
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot 0002 old\n",
        },
        {
          relativePath: `migrations/${formatMigrationFilename(3, "feature-b")}`,
          migrationNumber: 3,
          kind: "migration",
          content: "# 0003 feature-b\n\n- [ ] implement feature b\n",
        },
        {
          relativePath: `migrations/${formatSatelliteFilename(3, "snapshot")}`,
          migrationNumber: 3,
          kind: "snapshot",
          content: "# Snapshot 0003 old\n",
        },
      ],
    });

    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 0001 initialize\n\n- [x] bootstrap\n- [x] hotfix added mid-run\n",
      "utf-8",
    );

    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", "-e", buildMigrateUpExecutionOnlyWorkerScript()],
        },
        commands: {
          "migrate-slug": ["node", "-e", buildMigrateUpSlugReconciliationWorkerScript()],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "up",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "slug-worker-reconciled-a")))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "slug-worker-reconciled-b")))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "utf-8")).toContain("slug-worker-reconciled-a");
    expect(fs.readFileSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")), "utf-8")).toContain("slug-worker-reconciled-b");
  });

  it("falls back to migrate worker for migrate up reconciliation when migrate-slug is not configured", async () => {
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
          relativePath: `migrations/${formatMigrationFilename(1, "initialize")}`,
          migrationNumber: 1,
          kind: "migration",
          content: "# 0001 initialize\n\n- [x] bootstrap\n",
        },
        {
          relativePath: `migrations/${formatMigrationFilename(2, "feature-a")}`,
          migrationNumber: 2,
          kind: "migration",
          content: "# 0002 feature-a\n\n- [ ] implement feature a\n",
        },
        {
          relativePath: `migrations/${formatSatelliteFilename(2, "snapshot")}`,
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot 0002 old\n",
        },
        {
          relativePath: `migrations/${formatMigrationFilename(3, "feature-b")}`,
          migrationNumber: 3,
          kind: "migration",
          content: "# 0003 feature-b\n\n- [ ] implement feature b\n",
        },
        {
          relativePath: `migrations/${formatSatelliteFilename(3, "snapshot")}`,
          migrationNumber: 3,
          kind: "snapshot",
          content: "# Snapshot 0003 old\n",
        },
      ],
    });

    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 0001 initialize\n\n- [x] bootstrap\n- [x] hotfix added mid-run\n",
      "utf-8",
    );

    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", "-e", buildMigrateUpReconciliationWorkerScript()],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "up",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a-reconciled")))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b-reconciled")))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "utf-8")).toContain("feature-a-reconciled");
    expect(fs.readFileSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")), "utf-8")).toContain("feature-b-reconciled");
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
          relativePath: `migrations/${formatMigrationFilename(1, "initialize")}`,
          migrationNumber: 1,
          kind: "migration",
          content: "# 0001 initialize\n\n- [x] bootstrap\n",
        },
        {
          relativePath: `migrations/${formatMigrationFilename(2, "feature-a")}`,
          migrationNumber: 2,
          kind: "migration",
          content: "# 0002 feature-a\n\n- [ ] implement feature a\n",
        },
        {
          relativePath: `migrations/${formatSatelliteFilename(2, "snapshot")}`,
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot 0002 old\n",
        },
        {
          relativePath: `migrations/${formatMigrationFilename(3, "feature-b")}`,
          migrationNumber: 3,
          kind: "migration",
          content: "# 0003 feature-b\n\n- [ ] implement feature b\n",
        },
        {
          relativePath: `migrations/${formatSatelliteFilename(3, "snapshot")}`,
          migrationNumber: 3,
          kind: "snapshot",
          content: "# Snapshot 0003 old\n",
        },
      ],
    });

    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
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

    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a-reconciled")))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b-reconciled")))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "utf-8")).toContain("feature-a-reconciled");
    expect(fs.readFileSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")), "utf-8")).toContain("feature-b-reconciled");
    expect(fs.readFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "utf-8")).toContain("hotfix added mid-run");

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
    expect(fs.existsSync(path.join(sourceWorkspace, "migrations", formatSatelliteFilename(1, "snapshot")))).toBe(true);
    expect(fs.existsSync(path.join(linkedInvocationDir, "migrations", formatSatelliteFilename(1, "snapshot")))).toBe(false);
    expect(fs.existsSync(path.join(sourceWorkspace, ".workspace-cwd-marker"))).toBe(true);
    expect(fs.existsSync(path.join(linkedInvocationDir, ".workspace-cwd-marker"))).toBe(false);
  });

  it("uses configured directories from effective source workspace through chained links", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(sandbox, "source-workspace");
    const intermediateWorkspace = path.join(sandbox, "intermediate-workspace");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(intermediateWorkspace, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldPredictionProjectWithSatelliteTemplates(sourceWorkspace);

    fs.writeFileSync(
      path.join(sourceWorkspace, ".rundown", "config.json"),
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

    fs.mkdirSync(path.join(sourceWorkspace, "changesets"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, "changesets", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");

    fs.mkdirSync(path.join(intermediateWorkspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(intermediateWorkspace, ".rundown", "workspace.link"),
      path.relative(intermediateWorkspace, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );

    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      path.relative(linkedInvocationDir, intermediateWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "snapshot",
      "--",
      "node",
      "-e",
      [
        "console.log('# Snapshot');",
        "console.log('');",
        "console.log('effective-source-workspace-ok');",
        "process.exit(0);",
      ].join("\n"),
    ], linkedInvocationDir);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(sourceWorkspace, "changesets", formatSatelliteFilename(1, "snapshot")))).toBe(true);
    expect(fs.existsSync(path.join(sourceWorkspace, "migrations", formatSatelliteFilename(1, "snapshot")))).toBe(false);
    expect(fs.existsSync(path.join(intermediateWorkspace, "changesets", formatSatelliteFilename(1, "snapshot")))).toBe(false);
    expect(fs.existsSync(path.join(linkedInvocationDir, "changesets", formatSatelliteFilename(1, "snapshot")))).toBe(false);
  });

  it("supports multi-record workspace links with explicit --workspace selection", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspaceA = path.join(sandbox, "source-workspace-a");
    const sourceWorkspaceB = path.join(sandbox, "source-workspace-b");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspaceA, { recursive: true });
    fs.mkdirSync(sourceWorkspaceB, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldPredictionProjectWithSatelliteTemplates(sourceWorkspaceA);
    scaffoldPredictionProjectWithSatelliteTemplates(sourceWorkspaceB);

    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: 1,
        records: [
          { id: "alpha", workspacePath: path.relative(linkedInvocationDir, sourceWorkspaceA).replace(/\\/g, "/") },
          { id: "beta", workspacePath: path.relative(linkedInvocationDir, sourceWorkspaceB).replace(/\\/g, "/") },
        ],
      }),
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "snapshot",
      "--workspace",
      path.relative(linkedInvocationDir, sourceWorkspaceA),
      "--",
      "node",
      "-e",
      [
        "console.log('# Snapshot');",
        "console.log('');",
        "console.log('multi-record-selection-ok');",
        "process.exit(0);",
      ].join("\n"),
    ], linkedInvocationDir);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(sourceWorkspaceA, "migrations", formatSatelliteFilename(1, "snapshot")))).toBe(true);
    expect(fs.existsSync(path.join(sourceWorkspaceB, "migrations", formatSatelliteFilename(1, "snapshot")))).toBe(false);
    expect(fs.existsSync(path.join(linkedInvocationDir, "migrations", formatSatelliteFilename(1, "snapshot")))).toBe(false);
  });

  it("fails with candidate guidance when multi-record workspace links are ambiguous", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspaceA = path.join(sandbox, "source-workspace-a");
    const sourceWorkspaceB = path.join(sandbox, "source-workspace-b");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspaceA, { recursive: true });
    fs.mkdirSync(sourceWorkspaceB, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldPredictionProjectWithSatelliteTemplates(sourceWorkspaceA);
    scaffoldPredictionProjectWithSatelliteTemplates(sourceWorkspaceB);

    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: 1,
        records: [
          { id: "alpha", workspacePath: path.relative(linkedInvocationDir, sourceWorkspaceA).replace(/\\/g, "/") },
          { id: "beta", workspacePath: path.relative(linkedInvocationDir, sourceWorkspaceB).replace(/\\/g, "/") },
        ],
      }),
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "snapshot",
    ], linkedInvocationDir);

    expect(result.code).toBe(1);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Workspace selection is ambiguous");
    expect(combinedOutput).toContain("Candidates:");
    expect(combinedOutput).toContain("alpha:");
    expect(combinedOutput).toContain("beta:");
    expect(combinedOutput).toContain("Re-run the command with --workspace <dir>");
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

      const targetFile = path.join(workspace, "migrations", formatSatelliteFilename(1, action));
      expect(fs.existsSync(targetFile)).toBe(true);
      expect(fs.readFileSync(targetFile, "utf-8")).toContain(`generated-${action}-2`);

      const satelliteFiles = fs.readdirSync(path.join(workspace, "migrations"))
        .filter((entry) => /^\d+\.\d+\s+.+\.md$/.test(entry))
        .filter((entry) => entry === formatSatelliteFilename(1, action));

      expect(satelliteFiles).toStrictEqual([formatSatelliteFilename(1, action)]);
    });
  }

  it("migrate context removes the previous context satellite before writing the new one", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectWithSatelliteTemplates(workspace);
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "next")), "# 0002 next\n\n- [ ] step\n", "utf-8");

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

    const previousContext = path.join(workspace, "migrations", formatSatelliteFilename(1, "context"));
    const newContext = path.join(workspace, "migrations", formatSatelliteFilename(2, "context"));
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

    const migrationPath = path.join(workspace, "migrations", formatMigrationFilename(1, "initialize"));
    const backlogPath = path.join(workspace, "migrations", formatSatelliteFilename(1, "backlog"));

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

describeIfMigrateAvailable("migrate revision-action removals", () => {
  it("does not advertise removed revision actions in migrate help text", () => {
    expect(migrateActionHelpText).toContain("Migration action:");
    expect(migrateActionHelpText).not.toMatch(/\bsave\b/);
    expect(migrateActionHelpText).not.toMatch(/\bdiff\b/);
    expect(migrateActionHelpText).not.toMatch(/\bpreview\b/);
  });

  it("rejects removed revision actions via migrate routing", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);

    const saveResult = await runCli(["migrate", "save", "--dir", "migrations"], workspace);
    const diffResult = await runCli(["migrate", "diff", "--dir", "migrations"], workspace);
    const previewResult = await runCli(["migrate", "preview", "--dir", "migrations"], workspace);

    expect(saveResult.code).toBe(1);
    expect(diffResult.code).toBe(1);
    expect(previewResult.code).toBe(1);

    const saveOutput = stripAnsi([...saveResult.logs, ...saveResult.errors, ...saveResult.stdoutWrites, ...saveResult.stderrWrites].join("\n"));
    const diffOutput = stripAnsi([...diffResult.logs, ...diffResult.errors, ...diffResult.stdoutWrites, ...diffResult.stderrWrites].join("\n"));
    const previewOutput = stripAnsi([...previewResult.logs, ...previewResult.errors, ...previewResult.stdoutWrites, ...previewResult.stderrWrites].join("\n"));

    expect(saveOutput).toContain("Invalid migrate action: save");
    expect(diffOutput).toContain("Invalid migrate action: diff");
    expect(previewOutput).toContain("Invalid migrate action: preview");
  });
});

describeIfDocsDiffAvailable("design revision command integration", () => {
  it("uses configured workspace migrations directory for design commands when --dir is omitted", async () => {
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

    fs.mkdirSync(path.join(workspace, "changesets"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "changesets", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");
    fs.mkdirSync(path.join(workspace, "design-docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "design-docs", "current", "Target.md"), "# Design\n\nconfigured docs\n", "utf-8");

    const result = await runCli([
      "design",
      "release",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "design-docs", "rev.1", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "design", "rev.1", "Target.md"))).toBe(false);
  });

  it("resolves design release paths against linked workspace roots", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(sandbox, "source-workspace");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldPredictionProject(sourceWorkspace);
    fs.mkdirSync(path.join(sourceWorkspace, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, "docs", "current", "Design.md"), "# Design\n\nlinked release\n", "utf-8");

    const linkedConfigDir = path.join(linkedInvocationDir, ".rundown");
    fs.mkdirSync(linkedConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(linkedConfigDir, "workspace.link"),
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );

    const result = await runCli([
      "design",
      "release",
      "--dir",
      "migrations",
    ], linkedInvocationDir);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(sourceWorkspace, "docs", "rev.1", "Design.md"))).toBe(true);
    expect(fs.existsSync(path.join(linkedInvocationDir, "docs", "rev.1", "Design.md"))).toBe(false);
  });

  it("supports design release with explicit --workspace for multi-record workspace links", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspaceA = path.join(sandbox, "source-workspace-a");
    const sourceWorkspaceB = path.join(sandbox, "source-workspace-b");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspaceA, { recursive: true });
    fs.mkdirSync(sourceWorkspaceB, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldPredictionProject(sourceWorkspaceA);
    scaffoldPredictionProject(sourceWorkspaceB);
    fs.mkdirSync(path.join(sourceWorkspaceA, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspaceA, "docs", "current", "Design.md"), "# Design\n\nselected source\n", "utf-8");
    fs.mkdirSync(path.join(sourceWorkspaceB, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspaceB, "docs", "current", "Design.md"), "# Design\n\nunselected source\n", "utf-8");

    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: 1,
        records: [
          { id: "alpha", workspacePath: path.relative(linkedInvocationDir, sourceWorkspaceA).replace(/\\/g, "/") },
          { id: "beta", workspacePath: path.relative(linkedInvocationDir, sourceWorkspaceB).replace(/\\/g, "/") },
        ],
      }),
      "utf-8",
    );

    const result = await runCli([
      "design",
      "release",
      "--workspace",
      path.relative(linkedInvocationDir, sourceWorkspaceA),
      "--dir",
      "migrations",
    ], linkedInvocationDir);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(sourceWorkspaceA, "docs", "rev.1", "Design.md"))).toBe(true);
    expect(fs.existsSync(path.join(sourceWorkspaceB, "docs", "rev.1", "Design.md"))).toBe(false);
    expect(fs.existsSync(path.join(linkedInvocationDir, "docs", "rev.1", "Design.md"))).toBe(false);
  });

  it("fails design diff with actionable ambiguity guidance when --workspace is omitted", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspaceA = path.join(sandbox, "source-workspace-a");
    const sourceWorkspaceB = path.join(sandbox, "source-workspace-b");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(path.join(sourceWorkspaceA, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspaceB, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspaceA, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspaceA, "docs", "current"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspaceB, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspaceB, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspaceA, "docs", "rev.1", "Design.md"), "old-a\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspaceA, "docs", "current", "Design.md"), "new-a\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspaceB, "docs", "rev.1", "Design.md"), "old-b\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspaceB, "docs", "current", "Design.md"), "new-b\n", "utf-8");

    fs.mkdirSync(path.join(linkedInvocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(linkedInvocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: 1,
        records: [
          { id: "alpha", workspacePath: path.relative(linkedInvocationDir, sourceWorkspaceA).replace(/\\/g, "/") },
          { id: "beta", workspacePath: path.relative(linkedInvocationDir, sourceWorkspaceB).replace(/\\/g, "/") },
        ],
      }),
      "utf-8",
    );

    const result = await runCli([
      "design",
      "diff",
      "preview",
      "--dir",
      "migrations",
    ], linkedInvocationDir);

    expect(result.code).toBe(1);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Workspace selection is ambiguous");
    expect(combinedOutput).toContain("Candidates:");
    expect(combinedOutput).toContain("alpha:");
    expect(combinedOutput).toContain("beta:");
    expect(combinedOutput).toContain("Re-run the command with --workspace <dir>");
  });

  it("rejects docs subcommands because docs command is removed", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);

    const result = await runCli([
      "docs",
      "release",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput.toLowerCase()).toContain("unknown command");
  });

  it("resolves design diff against linked workspace roots", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(sandbox, "source-workspace");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(path.join(sourceWorkspace, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspace, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspace, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, "docs", "rev.1", "Design.md"), "old\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspace, "docs", "current", "Design.md"), "new\n", "utf-8");

    const linkedConfigDir = path.join(linkedInvocationDir, ".rundown");
    fs.mkdirSync(linkedConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(linkedConfigDir, "workspace.link"),
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );

    const result = await runCli([
      "design",
      "diff",
      "preview",
      "--dir",
      "migrations",
    ], linkedInvocationDir);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Compared rev.1 -> current:");
    expect(combinedOutput).toMatch(/docs[\\/]rev\.1/);
    expect(combinedOutput).toMatch(/docs[\\/]current/);
  });

  it("design diff previews revision changes without requiring a worker command", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.mkdirSync(path.join(workspace, "docs", "rev.1", "notes"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "current", "notes"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "# Design\n\nOld version.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "removed.md"), "Removed\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Design\n\nNew version.\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "added.md"), "Added\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "notes", "x.md"), "same\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "notes", "x.md"), "same\n", "utf-8");

    const result = await runCli([
      "design",
      "diff",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Design revision diff:");
    expect(combinedOutput).toContain("Compared rev.1 -> current:");
    expect(combinedOutput).toContain("- added: added.md");
    expect(combinedOutput).toContain("- modified: Design.md");
    expect(combinedOutput).toContain("- removed: removed.md");
    expect(combinedOutput).not.toContain("No worker command available");
  });

  it("design diff preview includes revision sources plus file-level change summary", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "old\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "new\n", "utf-8");

    const result = await runCli([
      "design",
      "diff",
      "preview",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Design revision diff preview:");
    expect(combinedOutput).toContain("Sources:");
    expect(combinedOutput).toMatch(/docs[\\/]rev\.1/);
    expect(combinedOutput).toMatch(/docs[\\/]current/);
    expect(combinedOutput).toContain("Changes:");
    expect(combinedOutput).toContain("- modified: Design.md");
  });

  it("design diff bootstraps docs/current from legacy Design.md when needed", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "old\n", "utf-8");
    fs.rmSync(path.join(workspace, "docs", "current"), { recursive: true, force: true });
    fs.writeFileSync(path.join(workspace, "Design.md"), "new\n", "utf-8");

    const result = await runCli([
      "design",
      "diff",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "docs", "current", "Design.md"), "utf-8")).toBe("new\n");
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Bootstrapped docs/current/ from legacy Design.md");
    expect(combinedOutput).toContain("Compared rev.1 -> current:");
  });

  it("design diff preview fails clearly when docs/current and legacy Design.md are both missing", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.rmSync(path.join(workspace, "docs"), { recursive: true, force: true });
    fs.rmSync(path.join(workspace, "Design.md"), { force: true });

    const result = await runCli([
      "design",
      "diff",
      "preview",
      "--dir",
      "migrations",
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

});

const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_PATTERN, "");
}

function normalizePathForAssertion(value: string): string {
  return value.replace(/\\/g, "/");
}

function readJsonLine(prompt: string, key: string): string[] {
  const line = prompt
    .split(/\r?\n/)
    .find((entry) => entry.startsWith(key));
  if (!line) {
    return [];
  }

  return JSON.parse(line.slice(key.length)) as string[];
}

function scaffoldPredictionProject(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nSeed design context.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "context")), "# Context\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "backlog")), "# Backlog\n", "utf-8");
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
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n\n- [x] bootstrap\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "context")), "# Context 0001\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "backlog")), "# Backlog 0001\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "snapshot")), "# Snapshot 0001\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "# 0002 feature-a\n\n- [ ] implement feature a\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(2, "snapshot")), "# Snapshot 0002 old\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")), "# 0003 feature-b\n\n- [ ] implement feature b\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(3, "snapshot")), "# Snapshot 0003 old\n", "utf-8");
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

function buildMigrateExecutionWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "if(prompt.includes('updating migration context incrementally')){",
    "  console.log('# Context');",
    "  console.log('');",
    "  console.log('from-migrate-execution-worker');",
    "  process.exit(0);",
    "}",
    "console.log('1. from-migrate-execution-worker');",
    "process.exit(0);",
  ].join("\n");
}

function buildMigrateSlugOnlyWorkerScript(slugName: string): string {
  return [
    "const fs=require('node:fs');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    `const slugName=${JSON.stringify(slugName)};`,
    "if(prompt.includes('Re-resolve the remaining pending migration prediction sequence.')){",
    "  console.log(JSON.stringify({migrations:[",
    "    {number:2,name:slugName,migration:'# 0002 '+slugName+'\\n',snapshot:'# Snapshot 0002\\n'}",
    "  ]}));",
    "  process.exit(0);",
    "}",
    "console.log(`1. ${slugName}`);",
    "process.exit(0);",
  ].join("\n");
}

function buildMigrateUpExecutionOnlyWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "if(prompt.includes('Re-resolve the remaining pending migration prediction sequence.')){",
    "  console.log('not-json-reconciliation-output');",
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

function buildMigrateUpSlugReconciliationWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "if(prompt.includes('Re-resolve the remaining pending migration prediction sequence.')){",
    "  console.log(JSON.stringify({migrations:[",
    "    {number:2,name:'slug-worker-reconciled-a',migration:'# 0002 slug-worker-reconciled-a\\n\\n- [ ] implement feature a reconciled\\n',snapshot:'# Snapshot 0002 reconciled\\n'},",
    "    {number:3,name:'slug-worker-reconciled-b',migration:'# 0003 slug-worker-reconciled-b\\n\\n- [ ] implement feature b reconciled\\n',snapshot:'# Snapshot 0003 reconciled\\n'}",
    "  ]}));",
    "  process.exit(0);",
    "}",
    "console.log('slug-worker');",
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
  const isolatedTempRoot = path.join(path.parse(os.tmpdir()).root, "rundown-test-tmp");
  fs.mkdirSync(isolatedTempRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(isolatedTempRoot, "rundown-migrate-int-"));
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

  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-migrate-home-"));
  tempDirs.push(isolatedHome);
  const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(isolatedHome);

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
    homedirSpy.mockRestore();
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
