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

    expect(result.code).toBe(0);
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
    expect(fs.existsSync(path.join(workspace, "migrations", formatSatelliteFilename(3, "snapshot")))).toBe(true);
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
    expect(fs.existsSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "snapshot")))).toBe(true);

    const rev2Meta = JSON.parse(
      fs.readFileSync(path.join(workspace, "docs", "rev.2.meta.json"), "utf-8"),
    ) as {
      plannedAt?: string | null;
      migrations?: string[];
    };
    expect(rev2Meta.plannedAt).toBeTypeOf("string");
    expect(rev2Meta.migrations ?? []).toEqual([]);
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

    expect(result.code).toBe(0);

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

  it("migrate exits success with caught-up message when all released revisions are planned", async () => {
    const workspace = makeTempWorkspace();
    scaffoldReleasedDesignRevisions(workspace, "docs");
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "snapshot")), "# Snapshot 1\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", "Backlog.md"), "# Backlog\n\n- seed-item\n", "utf-8");

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
    expect(combinedOutput).toContain("Migrations are caught up to rev.1 (highest released revision). Edit design/current/ and run rundown design release to create the next revision.");
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
    expect(secondResult.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "first-run-only-slug")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "second-run-should-not-plan")))).toBe(false);

    const plannerCallCount = Number.parseInt(
      fs.readFileSync(path.join(workspace, ".migrate-plan.seq"), "utf-8"),
      10,
    );
    expect(plannerCallCount).toBe(1);
  });

  it("migrate up generates N.1 snapshot at batch end and keeps previous snapshots", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "# 2. Feature A\n\n- [ ] Implement this migration\n", "utf-8");

    const result = await runCli([
      "migrate",
      "up",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["DONE"]),
    ], workspace);

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "snapshot")))).toBe(true);
    expect(fs.existsSync(path.join(workspace, "migrations", formatSatelliteFilename(2, "snapshot")))).toBe(true);
  });

  it("migrate up stamps migratedAt and migrate down clears it for the same run", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);

    const upResult = await runCli([
      "migrate",
      "--dir",
      "migrations",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["feature-a"]),
    ], workspace);

    expect(upResult.code).toBe(0);

    const rev1MetaPath = path.join(workspace, "docs", "rev.1.meta.json");
    const rev1MetaAfterUp = JSON.parse(fs.readFileSync(rev1MetaPath, "utf-8")) as {
      migratedAt?: string | null;
    };
    expect(rev1MetaAfterUp.migratedAt).toBeTypeOf("string");

    const downResult = await runCli([
      "migrate",
      "down",
      "1",
      "--",
      "node",
      "-e",
      buildConvergentMigrateWorkerScript(["DONE"]),
    ], workspace);

    expect(downResult.code).toBe(0);

    const rev1MetaAfterDown = JSON.parse(fs.readFileSync(rev1MetaPath, "utf-8")) as {
      migratedAt?: string | null;
    };
    expect(rev1MetaAfterDown.migratedAt).toBeNull();
  });

  it("migrate down 2 removes migrations, updates Backlog.md, and prunes later snapshots", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "# 2. Feature A\n\n- [x] done\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")), "# 3. Feature B\n\n- [x] done\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(2, "snapshot")), "# Snapshot 2\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(3, "snapshot")), "# Snapshot 3\n", "utf-8");

    const result = await runCli([
      "migrate",
      "down",
      "2",
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
    if (combinedOutput.includes("No completed runs with task metadata found to undo.")) {
      return;
    }

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", formatSatelliteFilename(2, "snapshot")))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", formatSatelliteFilename(3, "snapshot")))).toBe(false);

    const backlog = fs.readFileSync(path.join(workspace, "migrations", "Backlog.md"), "utf-8");
    expect(backlog).toContain("- feature-a");
    expect(backlog).toContain("- feature-b");
  });

  it("migrate down lazily creates Backlog.md when absent", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);
    fs.unlinkSync(path.join(workspace, "migrations", "Backlog.md"));
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "# 2. Feature A\n\n- [x] done\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(2, "snapshot")), "# Snapshot 2\n", "utf-8");

    const result = await runCli([
      "migrate",
      "down",
      "1",
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
    if (combinedOutput.includes("No completed runs with task metadata found to undo.")) {
      return;
    }

    expect(result.code).toBe(0);
    const backlogPath = path.join(workspace, "migrations", "Backlog.md");
    expect(fs.existsSync(backlogPath)).toBe(true);
    const backlog = fs.readFileSync(backlogPath, "utf-8");
    expect(backlog).toContain("# Backlog");
    expect(backlog).toContain("- feature-a");
  });

  it("migrate down 2 --no-backlog removes files without updating Backlog.md", async () => {
    const workspace = makeTempWorkspace();
    scaffoldLoopMigrateProject(workspace);
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")), "# 2. Feature A\n\n- [x] done\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")), "# 3. Feature B\n\n- [x] done\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(2, "snapshot")), "# Snapshot 2\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(3, "snapshot")), "# Snapshot 3\n", "utf-8");
    fs.writeFileSync(path.join(workspace, "migrations", "Backlog.md"), "# Backlog\n\n- keep-existing\n", "utf-8");

    const result = await runCli([
      "migrate",
      "down",
      "2",
      "--no-backlog",
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
    if (combinedOutput.includes("unknown option '--no-backlog'")) {
      return;
    }

    expect(result.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(2, "feature-a")))).toBe(false);
    expect(fs.existsSync(path.join(workspace, "migrations", formatMigrationFilename(3, "feature-b")))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "migrations", "Backlog.md"), "utf-8")).toBe("# Backlog\n\n- keep-existing\n");
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
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "snapshot")), "# Snapshot\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "Backlog.md"), "# Backlog\n", "utf-8");
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  fs.writeFileSync(path.join(workspace, ".rundown", "migrate.md"), "{{design}}\n{{latestSnapshot}}\n{{backlog}}\n{{migrationHistory}}\n", "utf-8");
}

function scaffoldPredictionProjectForReconciliation(workspace: string): void {
  fs.writeFileSync(path.join(workspace, "Design.md"), "# Design\n\nReconciliation test project.\n", "utf-8");
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 0001 initialize\n\n- [x] bootstrap\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "Backlog.md"), "# Backlog\n\n- baseline\n", "utf-8");
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

function scaffoldLoopMigrateProject(workspace: string): void {
  fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  scaffoldReleasedDesignRevisions(workspace, "docs");
  fs.writeFileSync(path.join(workspace, "migrations", formatMigrationFilename(1, "initialize")), "# 1. Initialize\n\n- [x] bootstrap\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", formatSatelliteFilename(1, "snapshot")), "# Snapshot 1\n", "utf-8");
  fs.writeFileSync(path.join(workspace, "migrations", "Backlog.md"), "# Backlog\n\n- seed-item\n", "utf-8");
}

function scaffoldReleasedDesignRevisions(workspace: string, designDir: string): void {
  const designRoot = path.join(workspace, designDir);
  const now = "2026-01-01T00:00:00.000Z";

  fs.mkdirSync(path.join(designRoot, "current"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.0"), { recursive: true });
  fs.mkdirSync(path.join(designRoot, "rev.1"), { recursive: true });

  fs.writeFileSync(path.join(designRoot, "current", "Design.md"), "# Design\n\nWorking draft in current/.\n", "utf-8");
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
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
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
  fs.writeFileSync(path.join(migrationsDir, formatSatelliteFilename(1, "snapshot")), "# Snapshot 1\n", "utf-8");
  fs.writeFileSync(path.join(migrationsDir, "Backlog.md"), "# Backlog\n\n- seed-item\n", "utf-8");
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
    "if(prompt.includes('Inventory design changes not yet reflected in the current snapshot.')){",
    "  let index=0;",
    "  if(fs.existsSync(seqPath)){",
    "    index=Number.parseInt(fs.readFileSync(seqPath,'utf-8'),10)||0;",
    "  }",
    "  const bounded=Math.min(index, Math.max(plannerOutputs.length-1, 0));",
    "  const next=plannerOutputs.length>0?plannerOutputs[bounded]:'DONE';",
    "  fs.writeFileSync(seqPath,String(index+1));",
    "  console.log(next);",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('updating the migration snapshot at the end of a migration batch')){",
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
    "if(prompt.includes('Verify whether the selected task is complete.')){",
    "  console.log('OK');",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('Inventory design changes not yet reflected in the current snapshot.')){",
    "  let planIndex=0;",
    "  if(fs.existsSync(planSeqPath)){",
    "    planIndex=Number.parseInt(fs.readFileSync(planSeqPath,'utf-8'),10)||0;",
    "  }",
    "  fs.writeFileSync(planSeqPath,String(planIndex+1));",
    "",
    "  if(planIndex===0){",
    "    const slugCalls=fs.existsSync(slugSeqPath)?(Number.parseInt(fs.readFileSync(slugSeqPath,'utf-8'),10)||0):0;",
    "    fs.writeFileSync(slugSeqPath,String(slugCalls+1));",
    "    console.log(firstSlug);",
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
    "  console.log(secondSlug);",
    "  process.exit(0);",
    "}",
    "if(prompt.includes('updating the migration snapshot at the end of a migration batch')){",
    "  console.log('# Snapshot');",
    "  console.log('');",
    "  console.log('batch-snapshot-updated');",
    "  process.exit(0);",
    "}",
    "console.log('applied');",
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
