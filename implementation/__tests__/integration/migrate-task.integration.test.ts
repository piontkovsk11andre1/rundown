import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatMigrationFilename } from "../../src/domain/migration-parser.js";

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
const hasDocsDiffCommand = cliSource.includes('.command("docs")') && cliSource.includes('.command("diff")');
const describeIfDocsDiffAvailable = hasDocsTaskUseCase && hasDocsDiffCommand ? describe : describe.skip;

describeIfMigrateAvailable("migrate-task integration", () => {
  it("uses configured workspace migrations directory when --dir is omitted", async () => {
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
        commands: {
          research: ["node", "-e", buildMigrateExecutionWorkerScript()],
          plan: ["node", "-e", buildMigrateExecutionWorkerScript()],
        },
      }, null, 2) + "\n",
      "utf-8",
    );
    scaffoldReleasedDesignRevisions(workspace, "design-docs");
    fs.mkdirSync(path.join(workspace, "changesets"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "changesets", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] done\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript([
        "configured-dir-migration",
        "configured-dir-migration",
        "DONE",
      ]),
    ], workspace);

    const debugOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(result.code, debugOutput).toBe(0);
    expect(fs.existsSync(path.join(workspace, "changesets", formatMigrationFilename(2, "configured-dir-migration")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "configured-dir-migration")))).toBe(false);
  });

  it("runs the planning loop until DONE and creates proposed migrations", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--show-agent-output",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript([
        "first-loop-change\nsecond-loop-change",
        "first-loop-change\nsecond-loop-change",
        "DONE",
      ]),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "first-loop-change")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "second-loop-change")))).toBe(true);
  });

  it("keeps sibling thread history isolated and numbering independent in CLI migrate runs", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "docs");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(99, "root-only-seed")),
      "# 99. Root Only Seed\n\n- [x] root lane history should be ignored in thread mode\n",
      "utf-8",
    );

    const billingThreadDir = path.join(workspace, "migrations", "threads", "billing");
    const opsThreadDir = path.join(workspace, "migrations", "threads", "ops");
    fs.mkdirSync(billingThreadDir, { recursive: true });
    fs.mkdirSync(opsThreadDir, { recursive: true });
    fs.writeFileSync(
      path.join(billingThreadDir, formatMigrationFilename(4, "billing-seed")),
      "# 4. Billing Seed\n\n- [x] billing history\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(opsThreadDir, formatMigrationFilename(1, "ops-seed")),
      "# 1. Ops Seed\n\n- [x] ops history\n",
      "utf-8",
    );

    const threadsDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsDir, { recursive: true });
    fs.writeFileSync(path.join(threadsDir, "billing.md"), "# Billing\n\nFocus on billing concerns.\n", "utf-8");
    fs.writeFileSync(path.join(threadsDir, "ops.md"), "# Ops\n\nFocus on ops concerns.\n", "utf-8");

    const workerScript = buildThreadIsolationAndNumberingWorkerScript();
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        commands: {
          research: ["node", "-e", workerScript],
          plan: ["node", "-e", workerScript],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      workerScript,
    ], workspace);

    const debugOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(result.code, debugOutput).toBe(0);

    expect(fs.existsSync(path.join(billingThreadDir, formatMigrationFilename(5, "billing-followup")))).toBe(true);
    expect(fs.existsSync(path.join(opsThreadDir, formatMigrationFilename(2, "ops-followup")))).toBe(true);

    const rev1Meta = readRevisionMeta(workspace, "docs", 1);
    const migrations = rev1Meta.migrations ?? [];
    const normalizedMigrations = migrations.map((entry) => normalizePathForAssertion(entry));
    expect(normalizedMigrations).toContain("migrations/threads/billing/5. Billing Followup.md");
    expect(normalizedMigrations).toContain("migrations/threads/ops/2. Ops Followup.md");

    const billingPrompt = fs.readFileSync(path.join(workspace, ".captured-thread-prompt.billing.txt"), "utf-8");
    const opsPrompt = fs.readFileSync(path.join(workspace, ".captured-thread-prompt.ops.txt"), "utf-8");
    expect(billingPrompt).toContain("Current migration number: 4");
    expect(opsPrompt).toContain("Current migration number: 1");
    expect(billingPrompt).toContain("- 4. Billing Seed.md");
    expect(billingPrompt).not.toContain("- 1. Ops Seed.md");
    expect(opsPrompt).toContain("- 1. Ops Seed.md");
    expect(opsPrompt).not.toContain("- 4. Billing Seed.md");
    expect(billingPrompt).toContain("translated billing brief");
    expect(billingPrompt).not.toContain("translated ops brief");
    expect(opsPrompt).toContain("translated ops brief");
    expect(opsPrompt).not.toContain("translated billing brief");
    expect(billingPrompt).not.toContain("- 99. Root Only Seed.md");
    expect(opsPrompt).not.toContain("- 99. Root Only Seed.md");
  });

  it("plans from --from-file without requiring design workspace directories", async () => {
    const workspace = makeTempWorkspace();
    configureMigrateWorkers(workspace);
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
      "# 1. Initialize\n\n- [x] done\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "Plan.md"),
      "# File-input design source\n\nCapture this plan content in migrate context.\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--from-file",
      "Plan.md",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildFromFileRootWorkerScript(),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", "2. File Input Integration.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "design"))).toBe(false);

    const capturedPrompt = fs.readFileSync(path.join(workspace, ".captured-from-file-prompt.txt"), "utf-8");
    expect(capturedPrompt).toContain("# File-input design source");
    expect(capturedPrompt).toContain("Capture this plan content in migrate context.");
  });

  it("keeps thread-aware drafting when planning from --from-file with thread briefs", async () => {
    const workspace = makeTempWorkspace();
    configureMigrateWorkers(workspace);
    fs.mkdirSync(path.join(workspace, "migrations", "threads", "billing"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", "threads", "billing", formatMigrationFilename(3, "billing seed")),
      "# 3. Billing Seed\n\n- [x] done\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(workspace, ".rundown", "threads"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "threads", "billing.md"),
      "# Billing\n\nFocus on billing-specific migration work.\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "Plan.md"),
      "# Shared file source\n\nThis source should be specialized into billing lane drafts.\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--from-file",
      "Plan.md",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildFromFileThreadWorkerScript(),
    ], workspace);

    const debug = debugOutput(result);
    expect(result.code, debug).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", "threads", "billing", "4. Billing From File.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", "4. Billing From File.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "design"))).toBe(false);

    const capturedPrompt = fs.readFileSync(path.join(workspace, ".captured-from-file-thread-prompt.billing.txt"), "utf-8");
    expect(capturedPrompt).toContain("# Shared file source");
    expect(capturedPrompt).toContain("specialized into billing lane drafts");
    expect(capturedPrompt).toContain("translated billing brief");
    expect(capturedPrompt).toContain("Current migration number: 3");
  });

  it("`migrate new <title>` creates exactly one next-numbered canonical migration without planning, prediction, or release side effects", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "docs");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "migrations", formatMigrationFilename(7, "existing migration")),
      "# 7. Existing Migration\n\n- [x] done\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "migrations", "Notes.md"),
      "# Notes\n\n- existing notes\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "docs", "current", "Design.md"),
      "# Design\n\nUnreleased design change that would normally trigger a release.\n",
      "utf-8",
    );

    const plannerScript = [
      "const fs=require('node:fs');",
      "const path=require('node:path');",
      "fs.writeFileSync(path.join(process.cwd(),'.unexpected-worker-invoked'),'1','utf-8');",
      "console.log('planner should not run for migrate new');",
      "process.exit(1);",
    ].join("\n");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        commands: {
          research: ["node", "-e", plannerScript],
          plan: ["node", "-e", plannerScript],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const predictionDir = path.join(workspace, "prediction");
    fs.mkdirSync(path.join(predictionDir, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(predictionDir, "migrations", formatMigrationFilename(2, "feature-a")), "# predicted 2\n", "utf-8");
    fs.writeFileSync(path.join(predictionDir, "notes.md"), "# prediction notes\n", "utf-8");
    fs.writeFileSync(path.join(predictionDir, "migrations", "raw.bin"), Buffer.from([0, 255, 17, 42]));

    const migrationsBefore = readDirectoryFileBytes(path.join(workspace, "migrations"));
    const predictionBefore = readDirectoryFileBytes(predictionDir);
    const rev1MetaBefore = fs.readFileSync(path.join(workspace, "docs", "rev.1.meta.json"), "utf-8");

    const result = await runCli([
      "migrate",
      "new",
      "File name basically",
      "--dir",
      "migrations",
    ], workspace);

    const debug = debugOutput(result);
    expect(result.code, debug).toBe(0);

    const migrationsAfter = readDirectoryFileBytes(path.join(workspace, "migrations"));
    const migrationPathsBefore = new Set(migrationsBefore.map((entry) => entry.path));
    const addedMigrationPaths = migrationsAfter
      .map((entry) => entry.path)
      .filter((entryPath) => !migrationPathsBefore.has(entryPath));

    expect(addedMigrationPaths).toEqual(["8. File Name Basically.md"]);
    expect(fs.existsSync(path.join(workspace, "migrations", "8. File Name Basically.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, ".unexpected-worker-invoked"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, ".migrate-plan.seq"))).toBe(false);
    expect(readDirectoryFileBytes(predictionDir)).toEqual(predictionBefore);
    expect(fs.readFileSync(path.join(workspace, "docs", "rev.1.meta.json"), "utf-8")).toBe(rev1MetaBefore);
    expect(fs.existsSync(path.join(workspace, "docs", "rev.2"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "docs", "rev.2.meta.json"))).toBe(false);
  });

  it("does not modify real migrations when staged drafts fail verification", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);
    fs.writeFileSync(
      path.join(workspace, "docs", "rev.1", "BillingFlow.md"),
      "# Billing\n\nNew billing workflow requirements.\n",
      "utf-8",
    );

    const migrationsDir = path.join(workspace, "migrations");
    const migrationsBefore = readDirectoryFileBytes(migrationsDir);

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildFailingDraftCoverageWorkerScript(),
    ], workspace);

    expect(result.code).toBe(1);
    expect(readDirectoryFileBytes(migrationsDir)).toEqual(migrationsBefore);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "api-migration")))).toBe(false);
  });

  it("exits cleanly when planner outputs DONE for an unplanned no-op released revision pair", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);
    scaffoldUnplannedNoOpReleasedRevisionPair(workspace, "docs");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["DONE"]),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "first-loop-change")))).toBe(false);

    const rev2Meta = JSON.parse(
      fs.readFileSync(path.join(workspace, "docs", "rev.2.meta.json"), "utf-8"),
    ) as {
      plannedAt?: string | null;
      migrations?: string[];
    };
    expect(rev2Meta.plannedAt).toBeTypeOf("string");
    expect(rev2Meta.migrations ?? []).toEqual([]);
  });

  it("renders an empty diff section and plans exactly once for unplanned no-op released revision pair", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);
    scaffoldUnplannedNoOpReleasedRevisionPair(workspace, "docs");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildNoOpPlannerPromptCaptureWorkerScript(),
    ], workspace);

    expect(result.code).toBe(0);

    const capturedPrompt = fs.readFileSync(path.join(workspace, ".captured-migrate-planner-prompt.txt"), "utf-8");
    const diffSectionMatch = capturedPrompt.match(/### Diff\n\n([\s\S]*?)\n\n### Diff source references/);
    expect(diffSectionMatch).not.toBeNull();
    const diffSectionBody = diffSectionMatch?.[1]?.trim() ?? "";
    expect(["", "(no content changes)"]).toContain(diffSectionBody);

    const plannerCallCount = Number.parseInt(
      fs.readFileSync(path.join(workspace, ".migrate-plan.seq"), "utf-8"),
      10,
    );
    expect(plannerCallCount).toBe(1);
  });

  it("migrate stamps plannedAt and migrations on each revision after planning", async () => {
    const workspace = makeTempWorkspace();
    scaffoldRevisionPlanningStampProject(workspace);

    const rev0MetaPath = path.join(workspace, "docs", "rev.0.meta.json");
    const rev1MetaPath = path.join(workspace, "docs", "rev.1.meta.json");
    const rev2MetaPath = path.join(workspace, "docs", "rev.2.meta.json");
    const rev0MetaBefore = fs.readFileSync(rev0MetaPath, "utf-8");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript([
        "rev1-added-file",
        "rev2-modified-file",
      ]),
    ], workspace);

    const debugOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(result.code, debugOutput).toBe(0);

    const rev0MetaAfter = fs.readFileSync(rev0MetaPath, "utf-8");
    const rev1Meta = JSON.parse(fs.readFileSync(rev1MetaPath, "utf-8")) as {
      plannedAt?: string | null;
      migrations?: string[];
    };
    const rev2Meta = JSON.parse(fs.readFileSync(rev2MetaPath, "utf-8")) as {
      plannedAt?: string | null;
      migrations?: string[];
    };

    expect(rev0MetaAfter).toBe(rev0MetaBefore);
    expect(rev1Meta.plannedAt).toBeTypeOf("string");
    expect(rev1Meta.migrations?.length ?? 0).toBeGreaterThan(0);
    expect(rev2Meta.plannedAt).toBeTypeOf("string");
    expect(rev2Meta.migrations?.length ?? 0).toBeGreaterThan(0);
  });

  it("renders migrate planner prompt from target revision design with real diff content", async () => {
    const workspace = makeTempWorkspace();
    scaffoldRevisionPlanningStampProject(workspace);

    const rev1MetaPath = path.join(workspace, "docs", "rev.1.meta.json");
    const rev1Meta = JSON.parse(fs.readFileSync(rev1MetaPath, "utf-8")) as {
      plannedAt?: string | null;
      createdAt: string;
      migrations?: string[];
    };
    rev1Meta.plannedAt = rev1Meta.createdAt;
    rev1Meta.migrations = [formatMigrationFilename(1, "initialize")];
    fs.writeFileSync(rev1MetaPath, JSON.stringify(rev1Meta, null, 2) + "\n", "utf-8");

    const targetSentinel = "TARGET-REV2-SENTINEL";
    const currentOnlySentinel = "CURRENT-ONLY-SENTINEL";
    fs.writeFileSync(
      path.join(workspace, "docs", "rev.1", "Target.md"),
      "# Target\n\ncommon line\nline removed from rev.2\nkept line\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "docs", "rev.2", "Target.md"),
      `# Target\n\n${targetSentinel}\ncommon line\nline added in rev.2\nkept line\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "docs", "current", "Target.md"),
      `# Target\n\n${currentOnlySentinel}\n`,
      "utf-8",
    );
    fs.writeFileSync(
      path.join(workspace, "docs", "rev.2", "added.md"),
      "added file from rev.2\nsecond added line\n",
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildPlannerPromptCaptureWorkerScript(),
    ], workspace);

    expect(result.code).toBe(0);

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Planning migrations for rev.1 → rev.2 (position 1)...");

    const capturedPrompt = fs.readFileSync(path.join(workspace, ".captured-migrate-planner-prompt.txt"), "utf-8");
    expect(capturedPrompt).toContain(targetSentinel);
    expect(capturedPrompt).not.toContain(currentOnlySentinel);
    expect(capturedPrompt).toContain("### Diff");
    expect(capturedPrompt).toContain("-line removed from rev.2");
    expect(capturedPrompt).toContain("+line added in rev.2");
    expect(capturedPrompt).toContain("#### added.md (added)");
    expect(capturedPrompt).toContain("+added file from rev.2");
    expect(capturedPrompt).toContain("Inventory design changes not yet reflected in the current prediction tree.");
    expect(capturedPrompt).not.toContain("Read the current prediction tree at");
    expect(capturedPrompt).not.toContain("satellite");
  });

  it("migrate plans with equivalent prompt context when older revision and migration payloads are archived", async () => {
    const hotWorkspace = makeTempWorkspace();
    const archivedWorkspace = makeTempWorkspace();
    scaffoldArchiveTransparencyMigrateProject(hotWorkspace);
    scaffoldArchiveTransparencyMigrateProject(archivedWorkspace);
    archiveOldHistoryForTransparencyFixture(archivedWorkspace);

    const hotResult = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildPlannerPromptCaptureWorkerScript(),
    ], hotWorkspace);
    const archivedResult = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildPlannerPromptCaptureWorkerScript(),
    ], archivedWorkspace);

    expect(hotResult.code).toBe(0);
    expect(archivedResult.code).toBe(0);
    expect(fs.existsSync(path.join(hotWorkspace, "migrations", formatMigrationFilename(2, "prompt-capture-migration")))).toBe(true);
    expect(fs.existsSync(path.join(archivedWorkspace, "migrations", formatMigrationFilename(2, "prompt-capture-migration")))).toBe(true);

    const hotPrompt = fs.readFileSync(path.join(hotWorkspace, ".captured-migrate-planner-prompt.txt"), "utf-8");
    const archivedPrompt = fs.readFileSync(path.join(archivedWorkspace, ".captured-migrate-planner-prompt.txt"), "utf-8");

    expect(hotPrompt).toContain("Current migration number:");
    expect(archivedPrompt).toContain("Current migration number:");
    expect(hotPrompt).toContain("- 1. Initialize.md");
    expect(archivedPrompt).toContain("- 1. Initialize.md");
    expect(hotPrompt).toContain("-legacy anchor from rev.0");
    expect(archivedPrompt).toContain("-legacy anchor from rev.0");
    expect(hotPrompt).toContain("+updated anchor in rev.1");
    expect(archivedPrompt).toContain("+updated anchor in rev.1");
    expect(extractPromptChangedFilesSection(hotPrompt)).toBe(extractPromptChangedFilesSection(archivedPrompt));
    expect(extractPromptDiffSection(hotPrompt)).toBe(extractPromptDiffSection(archivedPrompt));
  });

  it("migrate preflight writes new snapshots to canonical design/revisions/rev.N", async () => {
    const workspace = makeTempWorkspace();
    configureMigrateWorkers(workspace);
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
    fs.mkdirSync(path.join(workspace, "design", "current"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "design", "revisions", "rev.0"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "design", "revisions", "rev.1"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "design", "revisions", "rev.0", "Target.md"), "baseline\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "revisions", "rev.1", "Target.md"), "latest released\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "current", "Target.md"), "changed draft\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "revisions", "rev.0.meta.json"), JSON.stringify({
      revision: "rev.0",
      index: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      plannedAt: "2026-01-01T00:00:00.000Z",
      migrations: [],
    }, null, 2) + "\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "design", "revisions", "rev.1.meta.json"), JSON.stringify({
      revision: "rev.1",
      index: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
      plannedAt: "2026-01-02T00:00:00.000Z",
      migrations: ["migrations/1. Initialize.md"],
    }, null, 2) + "\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["canonical-preflight-plan"]),
    ], workspace);

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));

    expect(result.code, combinedOutput).toBe(0);
    expect(combinedOutput).toContain("Released design revision rev.2 from current design before migration planning.");
    expect(combinedOutput).toContain("Planning migrations for rev.1 → rev.2");
    expect(fs.existsSync(path.join(workspace, "design", "revisions", "rev.2", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "design", "revisions", "rev.2.meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "design", "rev.2", "Target.md"))).toBe(false);
  });

  it("migrate exits success with caught-up message when all released revisions are planned", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "docs");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", "Notes.md"), "# Notes\n\n- seed-item\n", "utf-8");

    const rev1MetaPath = path.join(workspace, "docs", "rev.1.meta.json");
    const rev1Meta = JSON.parse(fs.readFileSync(rev1MetaPath, "utf-8")) as {
      revision: string;
      index: number;
      createdAt: string;
      plannedAt?: string | null;
      migrations?: string[];
    };
    rev1Meta.plannedAt = rev1Meta.createdAt;
    rev1Meta.migrations = [formatMigrationFilename(1, "initialize")];
    fs.writeFileSync(rev1MetaPath, JSON.stringify(rev1Meta, null, 2) + "\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["DONE"]),
    ], workspace);

    expect(result.code).toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("Migrations are caught up to rev.1 (highest released revision, source mode default design-diff). Edit design/current/ and run rundown migrate to release and plan the next revision.");
    expect(fs.existsSync(path.join(workspace, "docs", "rev.2", "Design.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "docs", "rev.2.meta.json"))).toBe(false);
  });

  it("migrate preflight releases changed current design before planning", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "docs");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        commands: {
          research: ["node", "-e", buildMigrateExecutionWorkerScript()],
          plan: ["node", "-e", buildMigrateExecutionWorkerScript()],
        },
      }, null, 2) + "\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");

    const rev1MetaPath = path.join(workspace, "docs", "rev.1.meta.json");
    const rev1Meta = JSON.parse(fs.readFileSync(rev1MetaPath, "utf-8")) as {
      createdAt: string;
      plannedAt?: string | null;
      migrations?: string[];
    };
    rev1Meta.plannedAt = rev1Meta.createdAt;
    rev1Meta.migrations = ["migrations/1. Initialize.md"];
    fs.writeFileSync(rev1MetaPath, JSON.stringify(rev1Meta, null, 2) + "\n", "utf-8");

    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Design\n\nDraft changed after rev.1.\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["preflight-release-check"]),
    ], workspace);

    const debugOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(result.code, debugOutput).toBe(0);
    expect(debugOutput).toContain("Released design revision rev.2 from current design before migration planning.");
    expect(fs.existsSync(path.join(workspace, "docs", "rev.2", "Design.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "docs", "rev.3", "Design.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "docs", "rev.3.meta.json"))).toBe(false);
    const rev2Meta = readRevisionMeta(workspace, "docs", 2);
    expect(rev2Meta.plannedAt).toBeTypeOf("string");
  });

  it("migrate preflight does not create a new revision when current matches latest release", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "docs");
    configureMigrateWorkers(workspace);
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.0", "Design.md"), "# Design\n\nReleased rev.1 design.\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["DONE"]),
    ], workspace);

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));

    expect(result.code, combinedOutput).toBe(0);
    expect(combinedOutput).not.toContain("Released design revision");
    expect(fs.existsSync(path.join(workspace, "docs", "rev.2", "Design.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "docs", "rev.2.meta.json"))).toBe(false);
    expect(readRevisionMeta(workspace, "docs", 1).plannedAt).toBeTypeOf("string");
  });

  it("migrate resolves linked workspace roots and writes only in the source workspace", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspace = path.join(sandbox, "source-workspace");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspace, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldReleasedDesignRevisions(sourceWorkspace, "docs");
    configureMigrateWorkers(sourceWorkspace);
    fs.mkdirSync(path.join(sourceWorkspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");

    const linkedConfigDir = path.join(linkedInvocationDir, ".rundown");
    fs.mkdirSync(linkedConfigDir, { recursive: true });
    fs.writeFileSync(
      path.join(linkedConfigDir, "workspace.link"),
      path.relative(linkedInvocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["linked-workspace-plan"]),
    ], linkedInvocationDir);

    expect(result.code, debugOutput(result)).toBe(0);
    expect(readRevisionMeta(sourceWorkspace, "docs", 1).plannedAt).toBeTypeOf("string");
    expect(fs.existsSync(path.join(linkedInvocationDir, "docs", "rev.1.meta.json"))).toBe(false);
    expect(fs.existsSync(path.join(linkedInvocationDir, "docs", "rev.2.meta.json"))).toBe(false);
  });

  it("migrate requires --workspace for ambiguous linked workspaces", async () => {
    const sandbox = makeTempWorkspace();
    const sourceWorkspaceA = path.join(sandbox, "source-workspace-a");
    const sourceWorkspaceB = path.join(sandbox, "source-workspace-b");
    const linkedInvocationDir = path.join(sandbox, "linked-invocation");

    fs.mkdirSync(sourceWorkspaceA, { recursive: true });
    fs.mkdirSync(sourceWorkspaceB, { recursive: true });
    fs.mkdirSync(linkedInvocationDir, { recursive: true });
    scaffoldReleasedDesignRevisions(sourceWorkspaceA, "docs");
    scaffoldReleasedDesignRevisions(sourceWorkspaceB, "docs");
    configureMigrateWorkers(sourceWorkspaceA);
    configureMigrateWorkers(sourceWorkspaceB);
    fs.mkdirSync(path.join(sourceWorkspaceA, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspaceB, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(sourceWorkspaceA, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
    fs.writeFileSync(path.join(sourceWorkspaceB, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");

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

    const ambiguousResult = await runCli([
      "migrate",
      "--dir",
      "migrations",
    ], linkedInvocationDir);

    expect(ambiguousResult.code, debugOutput(ambiguousResult)).toBe(1);
    const ambiguousOutput = stripAnsi([
      ...ambiguousResult.logs,
      ...ambiguousResult.errors,
      ...ambiguousResult.stdoutWrites,
      ...ambiguousResult.stderrWrites,
    ].join("\n"));
    expect(ambiguousOutput).toContain("Workspace selection is ambiguous");
    expect(ambiguousOutput).toContain("Re-run the command with --workspace <dir>");

    expect(readRevisionMeta(sourceWorkspaceA, "docs", 1).plannedAt).toBeNull();
    expect(readRevisionMeta(sourceWorkspaceB, "docs", 1).plannedAt).toBeNull();
  });

  it("migrate bootstrap honors configured design directory when no revisions exist", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workspace: {
          directories: {
            design: "design-docs",
          },
        },
      }, null, 2) + "\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
    fs.mkdirSync(path.join(workspace, "design-docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "design-docs", "current", "Target.md"), "# Target\n\nConfigured design root\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["DONE"]),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "design-docs", "revisions", "rev.0", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "design-docs", "revisions", "rev.0.meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "design", "revisions", "rev.0", "Target.md"))).toBe(false);
  });

  it("migrate preflight keeps target selection anchored to lowest unplanned revision metadata", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "docs");
    fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        commands: {
          research: ["node", "-e", buildMigrateExecutionWorkerScript()],
          plan: ["node", "-e", buildMigrateExecutionWorkerScript()],
        },
      }, null, 2) + "\n",
      "utf-8",
    );
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");

    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "# Design\n\nDraft changed after rev.1.\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript([
        "first-lowest-unplanned",
        "second-preflight-revision",
      ]),
    ], workspace);

    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));

    expect(result.code, combinedOutput).toBe(0);
    expect(fs.existsSync(path.join(workspace, "docs", "rev.2", "Design.md"))).toBe(true);

    const planningLines = combinedOutput
      .split(/\r?\n/)
      .filter((line) => line.includes("Planning migrations for "));
    expect(planningLines.length).toBeGreaterThan(0);
    expect(planningLines[0]).toContain("Planning migrations for rev.0 → rev.1");

    const rev1Meta = readRevisionMeta(workspace, "docs", 1);
    const rev2Meta = readRevisionMeta(workspace, "docs", 2);
    expect(rev1Meta.plannedAt).toBeTypeOf("string");
    expect(rev2Meta.plannedAt).toBeTypeOf("string");
    expect(rev1Meta.migrations ?? []).toContain("migrations/2. First Lowest Unplanned.md");
    expect(rev2Meta.migrations ?? []).toContain("migrations/3. Second Preflight Revision.md");
  });

  it("migrate bootstraps rev.0 from design/current when no released revisions exist", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
    fs.mkdirSync(path.join(workspace, "design", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "design", "current", "Target.md"), "# Target\n\nInitial baseline\n", "utf-8");

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["DONE"]),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "design", "revisions", "rev.0", "Target.md"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "design", "revisions", "rev.0.meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "design", "revisions", "rev.1", "Target.md"))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "design", "revisions", "rev.1.meta.json"))).toBe(false);
  });

  it("migrate skips re-planning on re-run", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);

    const plannerScript = buildReplanSkipAssertionWorkerScript(
      "first-run-only-slug",
      "second-run-should-not-plan",
    );

    const firstResult = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      plannerScript,
    ], workspace);

    const secondResult = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      plannerScript,
    ], workspace);

    expect(firstResult.code).toBe(0);
    expect([0, 3]).toContain(secondResult.code);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "first-run-only-slug")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "second-run-should-not-plan")))).toBe(false);

    const plannerCallCount = Number.parseInt(
      fs.readFileSync(path.join(workspace, ".migrate-plan.seq"), "utf-8"),
      10,
    );
    expect(plannerCallCount).toBe(1);
  });

  it("materialize leaves prediction/ byte-for-byte unchanged", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectForReconciliation(workspace);

    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", "-e", buildMaterializeImplementationWriteWorkerScript()],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const predictionDir = path.join(workspace, "prediction");
    fs.mkdirSync(path.join(predictionDir, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(predictionDir, "migrations", formatMigrationFilename(2, "feature-a")), "# predicted 2\n", "utf-8");
    fs.writeFileSync(path.join(predictionDir, "notes.md"), "# prediction notes\n", "utf-8");
    fs.writeFileSync(path.join(predictionDir, "migrations", "raw.bin"), Buffer.from([0, 255, 17, 42]));

    const predictionBefore = readDirectoryFileBytes(predictionDir);

    const result = await runCli([
      "materialize",
      path.join("migrations", formatMigrationFilename(2, "feature-a")),
    ], workspace);

    expect(result.code).toBe(0);
    expect(readDirectoryFileBytes(predictionDir)).toEqual(predictionBefore);
  });

  it("materialize still writes expected files into implementation/", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProjectForReconciliation(workspace);

    fs.writeFileSync(
      path.join(workspace, ".rundown", "config.json"),
      JSON.stringify({
        workers: {
          default: ["node", "-e", buildMaterializeImplementationWriteWorkerScript()],
        },
      }, null, 2) + "\n",
      "utf-8",
    );

    const result = await runCli([
      "materialize",
      path.join("migrations", formatMigrationFilename(2, "feature-a")),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.readFileSync(path.join(workspace, "implementation", "status.txt"), "utf-8")).toBe("materialized\n");
    expect(fs.readFileSync(path.join(workspace, "implementation", "nested", "result.json"), "utf-8")).toBe(
      "{\"source\":\"feature-a\"}\n",
    );
  });

});

describeIfMigrateAvailable("migrate revision-action removals", () => {
  it("does not advertise removed revision actions in migrate help text", () => {
    expect(migrateActionHelpText).toBe("");
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

    expect(saveOutput.toLowerCase()).toContain("unknown action");
    expect(saveOutput).toContain("save");
    expect(diffOutput.toLowerCase()).toContain("unknown action");
    expect(diffOutput).toContain("diff");
    expect(previewOutput.toLowerCase()).toContain("unknown action");
    expect(previewOutput).toContain("preview");
  });

  it("rejects migrate down with an unknown action error", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);

    const result = await runCli(["migrate", "down", "1", "--dir", "migrations"], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n")).toLowerCase();
    expect(combinedOutput).toContain("unknown action");
    expect(combinedOutput).toContain("down");
  });

  it("rejects --to for migrate with an unknown option error", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);

    const result = await runCli(["migrate", "--to", "rev.1", "--dir", "migrations"], workspace);

    expect(result.code).toBe(1);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n")).toLowerCase();
    expect(combinedOutput).toContain("unknown option");
    expect(combinedOutput).toContain("--to");
  });

  it("still runs migrate planner loop when no action is provided", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);

    const result = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript([
        "planner-loop-still-active",
        "planner-loop-still-active",
        "DONE",
      ]),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "planner-loop-still-active")))).toBe(true);
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
      "rev.1",
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
    expect(combinedOutput).toContain("rev.0 -> rev.1");
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
    expect(combinedOutput).toContain("rev.1 -> rev.2");
    expect(combinedOutput).toContain("- added: added.md");
    expect(combinedOutput).toContain("- modified: Design.md");
    expect(combinedOutput).toContain("- removed: removed.md");
    expect(combinedOutput).not.toContain("No worker command available");
  });

  it("design diff includes unified per-file diff output", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "current"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Design.md"), "old\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "current", "Design.md"), "new\n", "utf-8");

    const result = await runCli([
      "design",
      "diff",
      "rev.1",
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
    expect(combinedOutput).toContain("rev.0 -> rev.1");
    expect(combinedOutput).toContain("#### Design.md (modified)");
    expect(combinedOutput).toContain("```diff");
    expect(combinedOutput).toContain("-old");
    expect(combinedOutput).toContain("+new");
  });

  it("design diff output stays equivalent when the previous revision payload is archived", async () => {
    const hotWorkspace = makeTempWorkspace();
    const archivedWorkspace = makeTempWorkspace();
    scaffoldArchiveTransparencyDesignDiffProject(hotWorkspace);
    scaffoldArchiveTransparencyDesignDiffProject(archivedWorkspace);
    archivePreviousDesignRevisionPayloadForDiffFixture(archivedWorkspace);

    const hotResult = await runCli([
      "design",
      "diff",
      "rev.1",
      "--dir",
      "migrations",
    ], hotWorkspace);
    const archivedResult = await runCli([
      "design",
      "diff",
      "rev.1",
      "--dir",
      "migrations",
    ], archivedWorkspace);

    expect(hotResult.code).toBe(0);
    expect(archivedResult.code).toBe(0);

    const hotOutput = stripAnsi([
      ...hotResult.logs,
      ...hotResult.errors,
      ...hotResult.stdoutWrites,
      ...hotResult.stderrWrites,
    ].join("\n"));
    const archivedOutput = stripAnsi([
      ...archivedResult.logs,
      ...archivedResult.errors,
      ...archivedResult.stdoutWrites,
      ...archivedResult.stderrWrites,
    ].join("\n"));

    expect(hotOutput).toContain("rev.0 -> rev.1");
    expect(archivedOutput).toContain("rev.0 -> rev.1");
    expect(hotOutput).toContain("-legacy baseline line");
    expect(archivedOutput).toContain("-legacy baseline line");
    expect(hotOutput).toContain("+updated release line");
    expect(archivedOutput).toContain("+updated release line");
    expect(hotOutput).toBe(archivedOutput);
  });

  it("design diff without target defaults to rev.0 -> rev.1 and includes changed file hunks", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "rev.0"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "rev.0", "Target.md"), "before\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.1", "Target.md"), "after\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.0.meta.json"), JSON.stringify({
      revision: "rev.0",
      index: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      plannedAt: "2026-01-01T00:00:00.000Z",
      migrations: [],
    }, null, 2) + "\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.1.meta.json"), JSON.stringify({
      revision: "rev.1",
      index: 1,
      createdAt: "2026-01-02T00:00:00.000Z",
      plannedAt: null,
      migrations: [],
    }, null, 2) + "\n", "utf-8");

    const result = await runCli([
      "design",
      "diff",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    const stdout = stripAnsi(result.stdoutWrites.join(""));
    expect(stdout.trimStart().startsWith("rev.0 → rev.1")).toBe(true);
    expect(stdout).toContain("#### Target.md (modified)");
    expect(stdout).toContain("-before");
    expect(stdout).toContain("+after");
  });

  it("design diff rev.0 prints initial diff against nothing", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(workspace, "docs", "rev.0"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "docs", "rev.0", "Target.md"), "baseline\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "docs", "rev.0.meta.json"), JSON.stringify({
      revision: "rev.0",
      index: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      plannedAt: "2026-01-01T00:00:00.000Z",
      migrations: [],
    }, null, 2) + "\n", "utf-8");

    const result = await runCli([
      "design",
      "diff",
      "rev.0",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).toBe(0);
    const stdout = stripAnsi(result.stdoutWrites.join(""));
    expect(stdout.trimStart().startsWith("nothing → rev.0")).toBe(true);
    expect(stdout).toContain("+baseline");
  });

  it("design diff fails with clear message when no released revisions exist", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });

    const result = await runCli([
      "design",
      "diff",
      "--dir",
      "migrations",
    ], workspace);

    expect(result.code).not.toBe(0);
    const combinedOutput = stripAnsi([
      ...result.logs,
      ...result.errors,
      ...result.stdoutWrites,
      ...result.stderrWrites,
    ].join("\n"));
    expect(combinedOutput).toContain("No released design revisions yet. Run rundown design release to create rev.0.");
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
    expect(combinedOutput).toContain("rev.1 -> rev.2");
  });

  it("design diff fails clearly when docs/current and legacy Design.md are both missing", async () => {
    const workspace = makeTempWorkspace();
    scaffoldPredictionProject(workspace);
    fs.rmSync(path.join(workspace, "docs"), { recursive: true, force: true });
    fs.rmSync(path.join(workspace, "Design.md"), { force: true });

    const result = await runCli([
      "design",
      "diff",
      "rev.1",
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

function readDirectoryFileBytes(rootDir: string): Array<{ path: string; bytes: number[] }> {
  const files: Array<{ path: string; bytes: number[] }> = [];

  const visit = (currentDir: string): void => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const relativePath = path.relative(rootDir, absolutePath).replace(/\\/g, "/");
      files.push({
        path: relativePath,
        bytes: Array.from(fs.readFileSync(absolutePath)),
      });
    }
  };

  visit(rootDir);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function scaffoldPredictionProject(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nSeed design context.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "Notes.md"), "# Notes\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".rundown", "migrate.md"), "{{design}}\n{{migrationHistory}}\n", "utf-8");
}

function scaffoldPredictionProjectForReconciliation(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nReconciliation test project.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n\n- [x] bootstrap\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "Notes.md"), "# Notes\n\n- baseline\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "# 0002 feature-a\n\n- [ ] implement feature a\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
}

function scaffoldLoopMigrateProject(workspace: string): void {
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  configureMigrateWorkers(workspace);
  scaffoldReleasedDesignRevisions(workspace, "docs");
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "Notes.md"), "# Notes\n\n- seed-item\n", "utf-8");
}

function scaffoldReleasedDesignRevisions(workspace: string, designDir: string): void {
  const designRoot = path.join(workspace, designDir);
  const now = "2026-01-01T00:00:00.000Z";

  fs.mkdirSync(path.join(designRoot, "current"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.0"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.1"), { recursive: true });

  fs.writeFileSync(path.join(designRoot, "current", "Design.md"), "# Design\n\nReleased rev.1 design.\n", "utf-8");
  fs.writeFileSync(path.join(designRoot, "rev.0", "Design.md"), "# Design\n\nBaseline design.\n", "utf-8");
  fs.writeFileSync(path.join(designRoot, "rev.1", "Design.md"), "# Design\n\nReleased rev.1 design.\n", "utf-8");

  fs.writeFileSync(path.join(designRoot, "rev.0.meta.json"), JSON.stringify({
    revision: "rev.0",
    index: 0,
    createdAt: now,
    plannedAt: now,
    migrations: [],
  }, null, 2) + "\n", "utf-8");

  fs.writeFileSync(path.join(designRoot, "rev.1.meta.json"), JSON.stringify({
    revision: "rev.1",
    index: 1,
    createdAt: now,
    plannedAt: null,
    migrations: [],
  }, null, 2) + "\n", "utf-8");
}

function scaffoldUnplannedNoOpReleasedRevisionPair(workspace: string, designDir: string): void {
  const designRoot = path.join(workspace, designDir);
  const now = "2026-01-02T00:00:00.000Z";
  const rev1Path = path.join(designRoot, "rev.1", "Design.md");
  const rev1MetaPath = path.join(designRoot, "rev.1.meta.json");
  const rev1Meta = JSON.parse(fs.readFileSync(rev1MetaPath, "utf-8")) as {
    revision: string;
    index: number;
    createdAt: string;
    plannedAt?: string | null;
    migrations?: string[];
  };

  rev1Meta.plannedAt = rev1Meta.createdAt;
  rev1Meta.migrations = [formatMigrationFilename(1, "initialize")];
  fs.writeFileSync(rev1MetaPath, JSON.stringify(rev1Meta, null, 2) + "\n", "utf-8");

  fs.mkdirSync(path.join(designRoot, "rev.2"), { recursive: true });
  fs.writeFileSync(path.join(designRoot, "rev.2", "Design.md"), fs.readFileSync(rev1Path, "utf-8"), "utf-8");
  fs.writeFileSync(path.join(designRoot, "rev.2.meta.json"), JSON.stringify({
    revision: "rev.2",
    index: 2,
    createdAt: now,
    plannedAt: null,
    migrations: [],
  }, null, 2) + "\n", "utf-8");
}

function scaffoldRevisionPlanningStampProject(workspace: string): void {
  const migrationsDir = path.join(workspace, "migrations");
  const designRoot = path.join(workspace, "docs");
  const rev0CreatedAt = "2026-01-01T00:00:00.000Z";
  const rev1CreatedAt = "2026-01-02T00:00:00.000Z";
  const rev2CreatedAt = "2026-01-03T00:00:00.000Z";

  fs.mkdirSync(migrationsDir, { recursive: true });
  configureMigrateWorkers(workspace);
  fs.mkdirSync(path.join(designRoot, "current"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.0"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.1"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.2"), { recursive: true });

  fs.writeFileSync(path.join(designRoot, "rev.1", "Design.md"), "# Design\n\nAdded in rev.1.\n", "utf-8");
  fs.writeFileSync(path.join(designRoot, "rev.2", "Design.md"), "# Design\n\nModified in rev.2.\n", "utf-8");
  fs.writeFileSync(path.join(designRoot, "current", "Design.md"), "# Design\n\nModified in rev.2.\n", "utf-8");

  fs.writeFileSync(path.join(designRoot, "rev.0.meta.json"), JSON.stringify({
    revision: "rev.0",
    index: 0,
    createdAt: rev0CreatedAt,
    plannedAt: rev0CreatedAt,
    migrations: [],
  }, null, 2) + "\n", "utf-8");

  fs.writeFileSync(path.join(designRoot, "rev.1.meta.json"), JSON.stringify({
    revision: "rev.1",
    index: 1,
    createdAt: rev1CreatedAt,
    plannedAt: null,
    migrations: [],
  }, null, 2) + "\n", "utf-8");

  fs.writeFileSync(path.join(designRoot, "rev.2.meta.json"), JSON.stringify({
    revision: "rev.2",
    index: 2,
    createdAt: rev2CreatedAt,
    plannedAt: null,
    migrations: [],
  }, null, 2) + "\n", "utf-8");

  fs.writeFileSync(path.join(migrationsDir, formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
  fs.writeFileSync(path.join(migrationsDir, "Notes.md"), "# Notes\n\n- seed-item\n", "utf-8");
}

function scaffoldRevisionPlanningStampProjectThroughRev3(workspace: string): void {
  scaffoldRevisionPlanningStampProject(workspace);

  const designRoot = path.join(workspace, "docs");
  const rev3CreatedAt = "2026-01-04T00:00:00.000Z";

  fs.mkdirSync(path.join(designRoot, "rev.3"), { recursive: true });
  fs.writeFileSync(path.join(designRoot, "rev.3", "Design.md"), "# Design\n\nAdded in rev.3.\n", "utf-8");
  fs.writeFileSync(path.join(designRoot, "current", "Design.md"), "# Design\n\nAdded in rev.3.\n", "utf-8");

  fs.writeFileSync(path.join(designRoot, "rev.3.meta.json"), JSON.stringify({
    revision: "rev.3",
    index: 3,
    createdAt: rev3CreatedAt,
    plannedAt: null,
    migrations: [],
  }, null, 2) + "\n", "utf-8");
}

function configureMigrateWorkers(workspace: string): void {
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, ".rundown", "config.json"),
    JSON.stringify({
      commands: {
        research: ["node", "-e", buildMigrateExecutionWorkerScript()],
        plan: ["node", "-e", buildMigrateExecutionWorkerScript()],
      },
    }, null, 2) + "\n",
    "utf-8",
  );
}

function debugOutput(result: {
  logs: string[];
  errors: string[];
  stdoutWrites: string[];
  stderrWrites: string[];
}): string {
  return stripAnsi([
    ...result.logs,
    ...result.errors,
    ...result.stdoutWrites,
    ...result.stderrWrites,
  ].join("\n"));
}

function scaffoldArchiveTransparencyMigrateProject(workspace: string): void {
  scaffoldRevisionPlanningStampProject(workspace);

  const rev2MetaPath = path.join(workspace, "docs", "rev.2.meta.json");
  const rev2Meta = JSON.parse(fs.readFileSync(rev2MetaPath, "utf-8")) as {
    createdAt: string;
    plannedAt?: string | null;
    migrations?: string[];
  };
  rev2Meta.plannedAt = rev2Meta.createdAt;
  rev2Meta.migrations = [formatMigrationFilename(99, "already-planned")];
  fs.writeFileSync(rev2MetaPath, JSON.stringify(rev2Meta, null, 2) + "\n", "utf-8");

  fs.writeFileSync(
    path.join(workspace, "docs", "rev.0", "Target.md"),
    "# Target\n\nshared line\nlegacy anchor from rev.0\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(workspace, "docs", "rev.1", "Target.md"),
    "# Target\n\nshared line\nupdated anchor in rev.1\n",
    "utf-8",
  );
}

function archiveOldHistoryForTransparencyFixture(workspace: string): void {
  const archivedRevisionDir = path.join(workspace, "docs", "archive", "revisions");
  const archivedRootMigrationsDir = path.join(workspace, "migrations", "archive", "root");
  fs.mkdirSync(archivedRevisionDir, { recursive: true });
  fs.mkdirSync(archivedRootMigrationsDir, { recursive: true });
  fs.renameSync(
    path.join(workspace, "docs", "rev.0"),
    path.join(archivedRevisionDir, "rev.0"),
  );
  fs.renameSync(
    path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")),
    path.join(archivedRootMigrationsDir, formatMigrationFilename(1, "initialize")),
  );
}

function extractPromptChangedFilesSection(prompt: string): string {
  const match = prompt.match(/### Changed files\n\n([\s\S]*?)\n\n### Diff/);
  return match?.[1]?.trim() ?? "";
}

function extractPromptDiffSection(prompt: string): string {
  const match = prompt.match(/### Diff\n\n([\s\S]*?)\n\n### Diff source references/);
  return match?.[1]?.trim() ?? "";
}

function scaffoldArchiveTransparencyDesignDiffProject(workspace: string): void {
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "docs", "rev.0"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "docs", "rev.1"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "docs", "rev.0", "Target.md"),
    "# Target\n\nlegacy baseline line\nshared line\n",
    "utf-8",
  );
  fs.writeFileSync(
    path.join(workspace, "docs", "rev.1", "Target.md"),
    "# Target\n\nupdated release line\nshared line\n",
    "utf-8",
  );
  fs.writeFileSync(path.join(workspace, "docs", "rev.0.meta.json"), JSON.stringify({
    revision: "rev.0",
    index: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    plannedAt: "2026-01-01T00:00:00.000Z",
    migrations: [],
  }, null, 2) + "\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "docs", "rev.1.meta.json"), JSON.stringify({
    revision: "rev.1",
    index: 1,
    createdAt: "2026-01-02T00:00:00.000Z",
    plannedAt: null,
    migrations: [],
  }, null, 2) + "\n", "utf-8");
}

function archivePreviousDesignRevisionPayloadForDiffFixture(workspace: string): void {
  const archivedRevisionDir = path.join(workspace, "docs", "archive", "revisions");
  fs.mkdirSync(archivedRevisionDir, { recursive: true });
  fs.renameSync(
    path.join(workspace, "docs", "rev.0"),
    path.join(archivedRevisionDir, "rev.0"),
  );
}

function seedPlannedRevisionMigrations(
  workspace: string,
  designDir: string,
  entries: ReadonlyArray<{ revision: number; migrations: string[] }>,
): void {
  const designRoot = path.join(workspace, designDir);
  const plannedAt = "2026-02-01T00:00:00.000Z";

  for (const entry of entries) {
    const revisionMetaPath = path.join(designRoot, `rev.${String(entry.revision)}.meta.json`);
    const revisionMeta = JSON.parse(fs.readFileSync(revisionMetaPath, "utf-8")) as {
      plannedAt?: string | null;
      migrations?: string[];
      migratedAt?: string | null;
    };
    revisionMeta.plannedAt = plannedAt;
    revisionMeta.migrations = [...entry.migrations];
    revisionMeta.migratedAt = plannedAt;
    fs.writeFileSync(revisionMetaPath, JSON.stringify(revisionMeta, null, 2) + "\n", "utf-8");

    for (const migrationFileName of entry.migrations) {
      fs.writeFileSync(
        path.join(workspace, "migrations", migrationFileName),
        `# ${migrationFileName}\n\n- [x] done\n`,
        "utf-8",
      );
    }
  }
}

function readRevisionMeta(workspace: string, designDir: string, revision: number): {
  plannedAt?: string | null;
  migrations?: string[];
  migratedAt?: string | null;
} {
  return JSON.parse(
    fs.readFileSync(path.join(workspace, designDir, `rev.${String(revision)}.meta.json`), "utf-8"),
  ) as {
    plannedAt?: string | null;
    migrations?: string[];
    migratedAt?: string | null;
  };
}

function buildConvergentMigrateWorkerScript(plannerOutputs: string[]): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "const seqPath=path.join(process.cwd(),'.migrate-plan.seq');",
    `const plannerOutputs=${JSON.stringify(plannerOutputs)};`,
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "const draftDirMatch=prompt.match(/staging directory:\\s*(.+)/i);",
    "const positionMatch=prompt.match(/Current migration number:\\s*(\\d+)/i);",
    "const draftDir=draftDirMatch&&draftDirMatch[1]?draftDirMatch[1].trim():'';",
    "const currentPosition=positionMatch&&positionMatch[1]?Number.parseInt(positionMatch[1],10):0;",
    "const changedFilesMatch=prompt.match(/### Changed files\\n\\n([\\s\\S]*?)\\n\\n### Diff/);",
    "const changedPaths=(changedFilesMatch&&changedFilesMatch[1]?changedFilesMatch[1].split(/\\r?\\n/):[])",
    "  .map((line)=>line.trim())",
    "  .filter((line)=>line.startsWith('- '))",
    "  .map((line)=>line.replace(/^-\\s*(?:added|modified|removed):\\s*/i,''))",
    "  .filter((line)=>line.length>0);",
    "const toTitle=(slug)=>slug.split('-').filter(Boolean).map((part)=>part.charAt(0).toUpperCase()+part.slice(1)).join(' ');",
    "const writeDrafts=(spec)=>{",
    "  const slugs=spec.split(/\\r?\\n/).map((line)=>line.trim()).filter((line)=>line.length>0);",
    "  if(slugs.length===0){",
    "    console.log('DONE');",
    "    return;",
    "  }",
    "  fs.mkdirSync(draftDir,{recursive:true});",
    "  for(let idx=0; idx<slugs.length; idx+=1){",
    "    const slug=slugs[idx];",
    "    const number=currentPosition+idx+1;",
    "    const title=toTitle(slug);",
    "    const fileName=`${number}. ${title}.md`;",
    "    const coverageLine=changedPaths.length>0?changedPaths.join(', '):'no design changes';",
    "    const body=[",
    "      `# ${number}. ${title}`,",
    "      '',",
    "      `- [ ] Implement ${slug} across prediction and implementation flows with explicit acceptance criteria.`,",
    "      `- [ ] Cover design diff paths: ${coverageLine}.`,",
    "    ].join('\\n');",
    "    fs.writeFileSync(path.join(draftDir,fileName),body+'\\n','utf-8');",
    "  }",
    "  console.log('drafted migration files');",
    "};",
    "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
    "  let index=0;",
    "  if(fs.existsSync(seqPath)){",
    "    index=Number.parseInt(fs.readFileSync(seqPath,'utf-8'),10)||0;",
    "  }",
    "  const bounded=Math.min(index, Math.max(plannerOutputs.length-1, 0));",
    "  const next=plannerOutputs.length>0?plannerOutputs[bounded]:'DONE';",
    "  fs.writeFileSync(seqPath,String(index+1));",
    "  if(next.trim()==='DONE'){",
    "    console.log('DONE');",
    "  } else {",
    "    writeDrafts(next);",
    "  }",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('grounded in the prediction tree')){",
    "  console.log('# Snapshot');",
    "  console.log('');",
    "  console.log('batch-snapshot-updated');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
    "process.exit(0);",
  ].join("\n");
}

function buildReplanSkipAssertionWorkerScript(firstSlug: string, secondSlug: string): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "const planSeqPath=path.join(process.cwd(),'.migrate-plan.seq');",
    "const slugSeqPath=path.join(process.cwd(),'.migrate-plan.slug.seq');",
    `const firstSlug=${JSON.stringify(firstSlug)};`,
    `const secondSlug=${JSON.stringify(secondSlug)};`,
    "const draftDirMatch=prompt.match(/staging directory:\\s*(.+)/i);",
    "const positionMatch=prompt.match(/Current migration number:\\s*(\\d+)/i);",
    "const draftDir=draftDirMatch&&draftDirMatch[1]?draftDirMatch[1].trim():'';",
    "const currentPosition=positionMatch&&positionMatch[1]?Number.parseInt(positionMatch[1],10):0;",
    "const toTitle=(slug)=>slug.split('-').filter(Boolean).map((part)=>part.charAt(0).toUpperCase()+part.slice(1)).join(' ');",
    "const writeDraft=(slug)=>{",
    "  fs.mkdirSync(draftDir,{recursive:true});",
    "  const number=currentPosition+1;",
    "  const fileName=`${number}. ${toTitle(slug)}.md`;",
    "  const body=[",
    "    `# ${number}. ${toTitle(slug)}`,",
    "    '',",
    "    `- [ ] Implement ${slug} migration draft and link it to changed design files.`,",
    "  ].join('\\n');",
    "  fs.writeFileSync(path.join(draftDir,fileName),body+'\\n','utf-8');",
    "};",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
    "  let planIndex=0;",
    "  if(fs.existsSync(planSeqPath)){",
    "    planIndex=Number.parseInt(fs.readFileSync(planSeqPath,'utf-8'),10)||0;",
    "  }",
    "  fs.writeFileSync(planSeqPath,String(planIndex+1));",
    "",
    "  if(planIndex===0){",
    "    const slugCalls=fs.existsSync(slugSeqPath)?(Number.parseInt(fs.readFileSync(slugSeqPath,'utf-8'),10)||0):0;",
    "    fs.writeFileSync(slugSeqPath,String(slugCalls+1));",
    "    writeDraft(firstSlug);",
    "    console.log('drafted migration files');",
    "    process.exit(0);",
    "  }",
    "",
    "  if(planIndex===1){",
    "    console.log('DONE');",
    "    process.exit(0);",
    "  }",
    "",
    "  const slugCalls=fs.existsSync(slugSeqPath)?(Number.parseInt(fs.readFileSync(slugSeqPath,'utf-8'),10)||0):0;",
    "  fs.writeFileSync(slugSeqPath,String(slugCalls+1));",
    "  writeDraft(secondSlug);",
    "  console.log('drafted migration files');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('grounded in the prediction tree')){",
    "  console.log('# Snapshot');",
    "  console.log('');",
    "  console.log('batch-snapshot-updated');",
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
    "const fullDocMatch=prompt.match(/## Full document\\n\\n([\\s\\S]*?)\\n\\n## Design context/);",
    "if(prompt.includes('Research and enrich the source document with implementation context.')){",
    "  const sourceDoc=fullDocMatch&&fullDocMatch[1]?fullDocMatch[1]:'';",
    "  console.log(sourceDoc.length>0?sourceDoc:'\\n');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Verify whether the research output is acceptable.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Diagnose why research verification keeps failing.')){",
    "  console.log('UNRESOLVED: no additional diagnosis needed in test worker');",
    "  process.exit(0);",
    "}",
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

function buildFromFileRootWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "const capturePath=path.join(process.cwd(),'.captured-from-file-prompt.txt');",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
    "  if(!fs.existsSync(capturePath)){",
    "    fs.writeFileSync(capturePath,prompt,'utf-8');",
    "  }",
    "  const draftDirMatch=prompt.match(/staging directory:\\s*(.+)/i);",
    "  const positionMatch=prompt.match(/Current migration number:\\s*(\\d+)/i);",
    "  const draftDir=draftDirMatch&&draftDirMatch[1]?draftDirMatch[1].trim():'';",
    "  const currentPosition=positionMatch&&positionMatch[1]?Number.parseInt(positionMatch[1],10):0;",
    "  const migrationNumber=currentPosition+1;",
    "  fs.mkdirSync(draftDir,{recursive:true});",
    "  const body=[",
    "    '# '+migrationNumber+'. File Input Integration',",
    "    '',",
    "    '- [ ] Apply file-input migration planning changes.',",
    "  ].join('\\n');",
    "  fs.writeFileSync(path.join(draftDir,migrationNumber+'. File Input Integration.md'),body+'\\n','utf-8');",
    "  console.log('drafted migration files');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('grounded in the prediction tree')){",
    "  console.log('# Snapshot');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
    "process.exit(0);",
  ].join("\n");
}

function buildFromFileThreadWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "const parseThreadSlug=(text)=>{",
    "  const direct=text.match(/Thread slug:\\s*(.+)/i);",
    "  if(direct&&direct[1]) return direct[1].trim();",
    "  const staging=text.match(/staging directory:\\s*(.+)/i);",
    "  if(staging&&staging[1]) return path.basename(staging[1].trim());",
    "  if(text.includes('# Billing')) return 'billing';",
    "  return 'unknown';",
    "};",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('## Source document (<what>)')&&prompt.includes('## Know-how reference (<how>)')&&prompt.includes('Rewrite the full <what> document')){",
    "  const threadSlug=parseThreadSlug(prompt);",
    "  console.log('# translated '+threadSlug+' brief');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
    "  const threadSlug=parseThreadSlug(prompt);",
    "  const capturePath=path.join(process.cwd(),'.captured-from-file-thread-prompt.'+threadSlug+'.txt');",
    "  fs.writeFileSync(capturePath,prompt,'utf-8');",
    "  const draftDirMatch=prompt.match(/staging directory:\\s*(.+)/i);",
    "  const positionMatch=prompt.match(/Current migration number:\\s*(\\d+)/i);",
    "  const draftDir=draftDirMatch&&draftDirMatch[1]?draftDirMatch[1].trim():'';",
    "  const currentPosition=positionMatch&&positionMatch[1]?Number.parseInt(positionMatch[1],10):0;",
    "  const migrationNumber=currentPosition+1;",
    "  fs.mkdirSync(draftDir,{recursive:true});",
    "  const body=[",
    "    '# '+migrationNumber+'. Billing From File',",
    "    '',",
    "    '- [ ] Apply billing-specialized file-input migration updates.',",
    "  ].join('\\n');",
    "  fs.writeFileSync(path.join(draftDir,migrationNumber+'. Billing From File.md'),body+'\\n','utf-8');",
    "  console.log('drafted migration files');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('grounded in the prediction tree')){",
    "  console.log('# Snapshot');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
    "process.exit(0);",
  ].join("\n");
}

function buildThreadIsolationAndNumberingWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "const fullDocMatch=prompt.match(/## Full document\\n\\n([\\s\\S]*?)\\n\\n## Design context/);",
    "const parseThreadSlug=(text)=>{",
    "  const direct=text.match(/Thread slug:\\s*(.+)/i);",
    "  if(direct&&direct[1]) return direct[1].trim();",
    "  const staging=text.match(/staging directory:\\s*(.+)/i);",
    "  if(staging&&staging[1]) return path.basename(staging[1].trim());",
    "  if(text.includes('# Billing')) return 'billing';",
    "  if(text.includes('# Ops')) return 'ops';",
    "  return 'unknown';",
    "};",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Research and enrich the source document with implementation context.')){",
    "  const sourceDoc=fullDocMatch&&fullDocMatch[1]?fullDocMatch[1]:'';",
    "  console.log(sourceDoc.length>0?sourceDoc:'\\n');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Verify whether the research output is acceptable.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Diagnose why research verification keeps failing.')){",
    "  console.log('UNRESOLVED: no additional diagnosis needed in test worker');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('updating migration context incrementally')){",
    "  console.log('# Context');",
    "  console.log('');",
    "  console.log('from-thread-isolation-worker');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('## Source document (<what>)')&&prompt.includes('## Know-how reference (<how>)')&&prompt.includes('Rewrite the full <what> document')){",
      "  const threadSlug=parseThreadSlug(prompt);",
      "  console.log('# translated '+threadSlug+' brief');",
      "  process.exit(0);",
    "}",
    "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
    "  const threadSlug=parseThreadSlug(prompt);",
    "  const promptCapturePath=path.join(process.cwd(),'.captured-thread-prompt.'+threadSlug+'.txt');",
    "  fs.writeFileSync(promptCapturePath,prompt,'utf-8');",
    "  const draftDirMatch=prompt.match(/staging directory:\\s*(.+)/i);",
    "  const positionMatch=prompt.match(/Current migration number:\\s*(\\d+)/i);",
    "  const draftDir=draftDirMatch&&draftDirMatch[1]?draftDirMatch[1].trim():'';",
    "  const currentPosition=positionMatch&&positionMatch[1]?Number.parseInt(positionMatch[1],10):0;",
    "  const migrationNumber=currentPosition+1;",
    "  const title=threadSlug==='billing'?'Billing Followup':'Ops Followup';",
    "  fs.mkdirSync(draftDir,{recursive:true});",
    "  const body=[",
    "    '# '+migrationNumber+'. '+title,",
    "    '',",
    "    '- [ ] Cover thread-specific migration follow-up work.',",
    "  ].join('\\n');",
    "  fs.writeFileSync(path.join(draftDir,migrationNumber+'. '+title+'.md'),body+'\\n','utf-8');",
    "  console.log('drafted migration files');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('grounded in the prediction tree')){",
    "  console.log('# Snapshot');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
    "process.exit(0);",
  ].join("\n");
}

function buildFailingDraftCoverageWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
    "  const draftDirMatch=prompt.match(/staging directory:\\s*(.+)/i);",
    "  const positionMatch=prompt.match(/Current migration number:\\s*(\\d+)/i);",
    "  const draftDir=draftDirMatch&&draftDirMatch[1]?draftDirMatch[1].trim():'';",
    "  const currentPosition=positionMatch&&positionMatch[1]?Number.parseInt(positionMatch[1],10):0;",
    "  fs.mkdirSync(draftDir,{recursive:true});",
    "  const migrationNumber=currentPosition+1;",
    "  const fileName=`${migrationNumber}. Api Migration.md`;",
    "  const body=[",
    "    `# ${migrationNumber}. Api Migration`,",
    "    '',",
    "    '- [ ] Update API handlers and request contracts for migrated endpoints.',",
    "  ].join('\\n');",
    "  fs.writeFileSync(path.join(draftDir,fileName),body+'\\n','utf-8');",
    "  console.log('drafted migration files');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Repair staged migration drafts')){",
    "  console.log('repaired staged draft');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('grounded in the prediction tree')){",
    "  console.log('# Snapshot');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
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

function buildMaterializeImplementationWriteWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "const implementationDir=path.join(process.cwd(),'implementation');",
    "const nestedDir=path.join(implementationDir,'nested');",
    "fs.mkdirSync(nestedDir,{recursive:true});",
    "fs.writeFileSync(path.join(implementationDir,'status.txt'),'materialized\\n','utf-8');",
    "fs.writeFileSync(path.join(nestedDir,'result.json'),'{\\\"source\\\":\\\"feature-a\\\"}\\n','utf-8');",
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

function buildPlannerPromptCaptureWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "const capturedPath=path.join(process.cwd(),'.captured-migrate-planner-prompt.txt');",
    "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
    "  const draftDirMatch=prompt.match(/staging directory:\\s*(.+)/i);",
    "  const positionMatch=prompt.match(/Current migration number:\\s*(\\d+)/i);",
    "  const draftDir=draftDirMatch&&draftDirMatch[1]?draftDirMatch[1].trim():'';",
    "  const currentPosition=positionMatch&&positionMatch[1]?Number.parseInt(positionMatch[1],10):0;",
    "  const changedFilesMatch=prompt.match(/### Changed files\\n\\n([\\s\\S]*?)\\n\\n### Diff/);",
    "  const changedPaths=(changedFilesMatch&&changedFilesMatch[1]?changedFilesMatch[1].split(/\\r?\\n/):[])",
    "    .map((line)=>line.trim())",
    "    .filter((line)=>line.startsWith('- '))",
    "    .map((line)=>line.replace(/^-\\s*(?:added|modified|removed):\\s*/i,''))",
    "    .filter((line)=>line.length>0);",
    "  fs.mkdirSync(draftDir,{recursive:true});",
    "  const migrationNumber=currentPosition+1;",
    "  const coverageLine=changedPaths.length>0?changedPaths.join(', '):'Target.md';",
    "  const draftBody=[",
    "    `# ${migrationNumber}. Prompt Capture Migration`,",
    "    '',",
    "    '- [ ] Implement prompt capture migration changes for revision planning.',",
    "    `- [ ] Cover design diff paths: ${coverageLine}.`,",
    "  ].join('\\n');",
    "  fs.writeFileSync(path.join(draftDir,`${migrationNumber}. Prompt Capture Migration.md`),draftBody+'\\n','utf-8');",
    "  if(!fs.existsSync(capturedPath)){",
    "    fs.writeFileSync(capturedPath,prompt,'utf-8');",
    "  }",
    "  console.log('drafted migration files');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('grounded in the prediction tree')){",
    "  console.log('# Snapshot');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
    "process.exit(0);",
  ].join("\n");
}

function buildNoOpPlannerPromptCaptureWorkerScript(): string {
  return [
    "const fs=require('node:fs');",
    "const path=require('node:path');",
    "const promptPath=process.argv[process.argv.length-1];",
    "const prompt=fs.existsSync(promptPath)?fs.readFileSync(promptPath,'utf-8'):'';",
    "const capturedPath=path.join(process.cwd(),'.captured-migrate-planner-prompt.txt');",
    "const seqPath=path.join(process.cwd(),'.migrate-plan.seq');",
    "if(prompt.includes('Inventory design changes not yet reflected in the current prediction tree.')){",
    "  let index=0;",
    "  if(fs.existsSync(seqPath)){",
    "    index=Number.parseInt(fs.readFileSync(seqPath,'utf-8'),10)||0;",
    "  }",
    "  fs.writeFileSync(seqPath,String(index+1));",
    "  fs.writeFileSync(capturedPath,prompt,'utf-8');",
    "  console.log('DONE');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('grounded in the prediction tree')){",
    "  console.log('# Snapshot');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
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
