import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPredictTask, type PredictTaskDependencies } from "../../src/application/predict-task.js";
import { inferWorkerPatternFromCommand } from "../../src/domain/worker-pattern.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../../src/domain/exit-codes.js";
import { createNodeFileSystem } from "../../src/infrastructure/adapters/fs-file-system.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/index.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("predict-task", () => {
  it("skips snapshot refresh and progress updates for failed lane passes", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, "1. Root First.md"), "# 1. Root First\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "2. Root Fails.md"), "# 2. Root Fails\n", "utf-8");

    const latestPath = path.join(workspace, "prediction", "latest");
    const snapshotsRootDir = path.join(workspace, "prediction", "snapshots", "root");
    const failedSnapshotPath = path.join(snapshotsRootDir, "2");
    fs.mkdirSync(failedSnapshotPath, { recursive: true });
    fs.writeFileSync(path.join(failedSnapshotPath, "stale.txt"), "stale", "utf-8");

    const runTask = vi.fn(async (runOptions: { source: string }) => {
      const executionSource = fs.readFileSync(runOptions.source, "utf-8");
      if (executionSource.includes("1. Root First.md")) {
        fs.mkdirSync(latestPath, { recursive: true });
        fs.writeFileSync(path.join(latestPath, "state.txt"), "root-1", "utf-8");
        return EXIT_CODE_SUCCESS;
      }
      if (executionSource.includes("2. Root Fails.md")) {
        fs.writeFileSync(path.join(latestPath, "state.txt"), "root-2", "utf-8");
        return EXIT_CODE_FAILURE;
      }

      throw new Error("Unexpected predict execution source");
    });

    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: () => undefined },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      expect(runTask).toHaveBeenCalledTimes(2);

      expect(fs.readFileSync(path.join(snapshotsRootDir, "1", "state.txt"), "utf-8")).toBe("root-1");
      expect(fs.existsSync(path.join(failedSnapshotPath, "state.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(failedSnapshotPath, "stale.txt"), "utf-8")).toBe("stale");

      const progress = JSON.parse(
        fs.readFileSync(path.join(workspace, ".rundown", "prediction-progress.json"), "utf-8"),
      ) as {
        lastAppliedMigration: { migrationIdentifier: string; migrationNumber: number } | null;
        migrations: Array<{ migrationIdentifier: string; migrationNumber: number }>;
      };
      expect(progress.lastAppliedMigration?.migrationIdentifier).toBe("migrations/1. Root First.md");
      expect(progress.lastAppliedMigration?.migrationNumber).toBe(1);
      expect(progress.migrations).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("skips thread snapshot refresh and progress updates for failed thread lane passes", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    const checkoutThreadDir = path.join(migrationsDir, "threads", "checkout");
    const threadsSpecDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsSpecDir, { recursive: true });
    fs.writeFileSync(path.join(threadsSpecDir, "checkout.md"), "# Checkout\n", "utf-8");

    fs.mkdirSync(checkoutThreadDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, "1. Root First.md"), "# 1. Root First\n", "utf-8");
    fs.writeFileSync(path.join(checkoutThreadDir, "1. Checkout Fails.md"), "# 1. Checkout Fails\n", "utf-8");

    const latestPath = path.join(workspace, "prediction", "latest");
    const snapshotsRootDir = path.join(workspace, "prediction", "snapshots", "root");
    const snapshotsThreadDir = path.join(workspace, "prediction", "snapshots", "threads", "checkout");
    const failedThreadSnapshotPath = path.join(snapshotsThreadDir, "1");
    fs.mkdirSync(failedThreadSnapshotPath, { recursive: true });
    fs.writeFileSync(path.join(failedThreadSnapshotPath, "stale-thread.txt"), "stale", "utf-8");

    const runTask = vi.fn(async (runOptions: { source: string }) => {
      const executionSource = fs.readFileSync(runOptions.source, "utf-8");
      if (executionSource.includes("1. Root First.md")) {
        fs.mkdirSync(latestPath, { recursive: true });
        fs.writeFileSync(path.join(latestPath, "state.txt"), "root-1", "utf-8");
        return EXIT_CODE_SUCCESS;
      }
      if (executionSource.includes("1. Checkout Fails.md")) {
        fs.writeFileSync(path.join(latestPath, "thread-state.txt"), "thread-1", "utf-8");
        return EXIT_CODE_FAILURE;
      }

      throw new Error("Unexpected predict execution source");
    });

    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: () => undefined },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_FAILURE);
      expect(runTask).toHaveBeenCalledTimes(2);

      expect(fs.readFileSync(path.join(snapshotsRootDir, "1", "state.txt"), "utf-8")).toBe("root-1");
      expect(fs.existsSync(path.join(failedThreadSnapshotPath, "thread-state.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(failedThreadSnapshotPath, "stale-thread.txt"), "utf-8")).toBe("stale");

      const progress = JSON.parse(
        fs.readFileSync(path.join(workspace, ".rundown", "prediction-progress.json"), "utf-8"),
      ) as {
        lastAppliedMigration: { migrationIdentifier: string; migrationNumber: number } | null;
        migrations: Array<{ migrationIdentifier: string; migrationNumber: number }>;
      };
      expect(progress.lastAppliedMigration?.migrationIdentifier).toBe("migrations/1. Root First.md");
      expect(progress.lastAppliedMigration?.migrationNumber).toBe(1);
      expect(progress.migrations).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("materializes full-tree snapshots for successful root and thread lane boundaries", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    const checkoutThreadDir = path.join(migrationsDir, "threads", "checkout");
    const threadsSpecDir = path.join(workspace, ".rundown", "threads");
    fs.mkdirSync(threadsSpecDir, { recursive: true });
    fs.writeFileSync(path.join(threadsSpecDir, "checkout.md"), "# Checkout\n", "utf-8");

    fs.mkdirSync(checkoutThreadDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, "1. Root First.md"), "# 1. Root First\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "2. Root Second.md"), "# 2. Root Second\n", "utf-8");
    fs.writeFileSync(path.join(checkoutThreadDir, "1. Checkout First.md"), "# 1. Checkout First\n", "utf-8");

    const latestPath = path.join(workspace, "prediction", "latest");
    const snapshotsRootDir = path.join(workspace, "prediction", "snapshots", "root");
    const snapshotsThreadDir = path.join(workspace, "prediction", "snapshots", "threads", "checkout");
    fs.mkdirSync(path.join(snapshotsRootDir, "2"), { recursive: true });
    fs.writeFileSync(path.join(snapshotsRootDir, "2", "stale.txt"), "stale", "utf-8");
    fs.mkdirSync(path.join(snapshotsThreadDir, "1"), { recursive: true });
    fs.writeFileSync(path.join(snapshotsThreadDir, "1", "stale-thread.txt"), "stale", "utf-8");

    const runTask = vi.fn(async (runOptions: { source: string }) => {
      const executionSource = fs.readFileSync(runOptions.source, "utf-8");
      if (executionSource.includes("1. Root First.md")) {
        fs.mkdirSync(latestPath, { recursive: true });
        fs.writeFileSync(path.join(latestPath, "alpha.txt"), "one", "utf-8");
        fs.writeFileSync(path.join(latestPath, "replace.txt"), "root-1", "utf-8");
        return EXIT_CODE_SUCCESS;
      }
      if (executionSource.includes("2. Root Second.md")) {
        fs.writeFileSync(path.join(latestPath, "replace.txt"), "root-2", "utf-8");
        fs.writeFileSync(path.join(latestPath, "beta.txt"), "two", "utf-8");
        fs.unlinkSync(path.join(latestPath, "alpha.txt"));
        return EXIT_CODE_SUCCESS;
      }
      if (executionSource.includes("1. Checkout First.md")) {
        fs.mkdirSync(path.join(latestPath, "nested"), { recursive: true });
        fs.writeFileSync(path.join(latestPath, "nested", "thread.txt"), "thread", "utf-8");
        return EXIT_CODE_SUCCESS;
      }

      throw new Error("Unexpected predict execution source");
    });

    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: () => undefined },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(3);

      expect(fs.existsSync(path.join(snapshotsRootDir, "1", "alpha.txt"))).toBe(true);
      expect(fs.readFileSync(path.join(snapshotsRootDir, "1", "replace.txt"), "utf-8")).toBe("root-1");

      expect(fs.existsSync(path.join(snapshotsRootDir, "2", "stale.txt"))).toBe(false);
      expect(fs.existsSync(path.join(snapshotsRootDir, "2", "alpha.txt"))).toBe(false);
      expect(fs.readFileSync(path.join(snapshotsRootDir, "2", "replace.txt"), "utf-8")).toBe("root-2");
      expect(fs.readFileSync(path.join(snapshotsRootDir, "2", "beta.txt"), "utf-8")).toBe("two");

      expect(fs.readFileSync(path.join(snapshotsThreadDir, "1", "replace.txt"), "utf-8")).toBe("root-2");
      expect(fs.readFileSync(path.join(snapshotsThreadDir, "1", "nested", "thread.txt"), "utf-8")).toBe("thread");
      expect(fs.existsSync(path.join(snapshotsThreadDir, "1", "stale-thread.txt"))).toBe(false);

      expect(fs.readFileSync(path.join(latestPath, "replace.txt"), "utf-8")).toBe("root-2");
      expect(fs.readFileSync(path.join(latestPath, "nested", "thread.txt"), "utf-8")).toBe("thread");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("upgrades legacy flat prediction root into prediction/latest on next successful run", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(path.join(migrationsDir, "1. Root First.md"), "# 1. Root First\n", "utf-8");

    const predictionRootPath = path.join(workspace, "prediction");
    const legacyNestedDir = path.join(predictionRootPath, "nested");
    const latestPath = path.join(predictionRootPath, "latest");
    fs.mkdirSync(legacyNestedDir, { recursive: true });
    fs.writeFileSync(path.join(predictionRootPath, "legacy.txt"), "legacy-root", "utf-8");
    fs.writeFileSync(path.join(legacyNestedDir, "legacy-nested.txt"), "legacy-nested", "utf-8");

    const runTask = vi.fn(async () => {
      expect(fs.readFileSync(path.join(latestPath, "legacy.txt"), "utf-8")).toBe("legacy-root");
      expect(fs.readFileSync(path.join(latestPath, "nested", "legacy-nested.txt"), "utf-8")).toBe("legacy-nested");
      fs.writeFileSync(path.join(latestPath, "legacy.txt"), "legacy-updated", "utf-8");
      fs.writeFileSync(path.join(latestPath, "new.txt"), "new", "utf-8");
      return EXIT_CODE_SUCCESS;
    });

    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: () => undefined },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(1);

      expect(fs.existsSync(path.join(predictionRootPath, "legacy.txt"))).toBe(false);
      expect(fs.existsSync(path.join(predictionRootPath, "nested", "legacy-nested.txt"))).toBe(false);

      expect(fs.readFileSync(path.join(latestPath, "legacy.txt"), "utf-8")).toBe("legacy-updated");
      expect(fs.readFileSync(path.join(latestPath, "nested", "legacy-nested.txt"), "utf-8")).toBe("legacy-nested");
      expect(fs.readFileSync(path.join(latestPath, "new.txt"), "utf-8")).toBe("new");

      expect(
        fs.readFileSync(path.join(predictionRootPath, "snapshots", "root", "1", "legacy.txt"), "utf-8"),
      ).toBe("legacy-updated");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("enumerates root and thread migrations deterministically and runs only unapplied files in order", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    const archiveRootDir = path.join(migrationsDir, "archive", "root");
    const archiveThreadsDir = path.join(migrationsDir, "archive", "threads");
    const threadsSpecDir = path.join(workspace, ".rundown", "threads");
    const billingThreadDir = path.join(migrationsDir, "threads", "billing");
    const opsThreadDir = path.join(migrationsDir, "threads", "ops");

    fs.mkdirSync(threadsSpecDir, { recursive: true });
    fs.writeFileSync(path.join(threadsSpecDir, "billing.md"), "# Billing\n", "utf-8");
    fs.writeFileSync(path.join(threadsSpecDir, "ops.md"), "# Ops\n", "utf-8");

    fs.mkdirSync(archiveRootDir, { recursive: true });
    fs.mkdirSync(archiveThreadsDir, { recursive: true });
    fs.mkdirSync(path.join(archiveThreadsDir, "billing"), { recursive: true });

    fs.writeFileSync(
      path.join(archiveRootDir, "1. Root Archived Done.md"),
      "# 1. Root Archived Done\n\n- [x] already predicted\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(migrationsDir, "2. Root Hot Pending.md"),
      "# 2. Root Hot Pending\n\n- [ ] apply root change\n",
      "utf-8",
    );

    fs.mkdirSync(billingThreadDir, { recursive: true });
    fs.writeFileSync(
      path.join(archiveThreadsDir, "billing", "1. Billing Archived Done.md"),
      "# 1. Billing Archived Done\n\n- [x] done\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(billingThreadDir, "2. Billing Pending.md"),
      "# 2. Billing Pending\n\n- [ ] apply billing change\n",
      "utf-8",
    );

    fs.mkdirSync(opsThreadDir, { recursive: true });
    fs.writeFileSync(
      path.join(opsThreadDir, "1. Ops Pending.md"),
      "# 1. Ops Pending\n\n- [ ] apply ops change\n",
      "utf-8",
    );

    writePredictionProgress(workspace, [
      {
        migrationPath: path.join(archiveRootDir, "1. Root Archived Done.md"),
        migrationNumber: 1,
      },
      {
        migrationPath: path.join(archiveThreadsDir, "billing", "1. Billing Archived Done.md"),
        migrationNumber: 1,
      },
    ]);

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const dependencies: PredictTaskDependencies = {
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    };
    const predictTask = createPredictTask(dependencies);

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(3);
      const runTaskSources = runTask.mock.calls.map((call) => String(call[0].source));
      expect(runTaskSources).toHaveLength(3);
      for (const sourcePath of runTaskSources) {
        expect(sourcePath).toContain(path.join(".rundown", "prediction-execution"));
        expect(sourcePath.endsWith(".predict.md")).toBe(true);
      }

      const rootPassSource = fs.readFileSync(runTaskSources[0]!, "utf-8");
      expect(rootPassSource).toContain(path.join(migrationsDir, "2. Root Hot Pending.md"));
      expect(rootPassSource).toContain("# 2. Root Hot Pending");
      expect(rootPassSource).toContain(
        `Apply the migration file to ${path.join(workspace, "prediction", "latest")} as a single pass`,
      );

      const progressPath = path.join(workspace, ".rundown", "prediction-progress.json");
      const progress = JSON.parse(fs.readFileSync(progressPath, "utf-8")) as {
        schemaVersion: number;
        version: string;
        predictionRootPath: string;
        workspaceRoutingFingerprint: string;
        lastAppliedMigration: { migrationNumber: number; migrationIdentifier: string } | null;
        migrations: Array<{ migrationIdentifier: string; migrationContentHash: string; status: string; appliedAt: string }>;
      };
      expect(progress.schemaVersion).toBe(1);
      expect(progress.version).toBe("prediction-progress/v1");
      expect(progress.predictionRootPath).toBe(path.join(workspace, "prediction", "latest"));
      expect(progress.workspaceRoutingFingerprint.length).toBeGreaterThan(0);
      expect(progress.lastAppliedMigration?.migrationIdentifier).toBe("migrations/threads/billing/2. Billing Pending.md");
      expect(progress.lastAppliedMigration?.migrationNumber).toBe(2);
      expect(progress.migrations).toHaveLength(5);
      for (const record of progress.migrations) {
        expect(record.status).toBe("applied");
        expect(record.migrationContentHash).toMatch(/^[a-f0-9]{64}$/);
        expect(Number.isFinite(Date.parse(record.appliedAt))).toBe(true);
      }

      const billingPassSource = fs.readFileSync(runTaskSources[1]!, "utf-8");
      expect(billingPassSource).toContain(path.join(billingThreadDir, "2. Billing Pending.md"));

      const opsPassSource = fs.readFileSync(runTaskSources[2]!, "utf-8");
      expect(opsPassSource).toContain(path.join(opsThreadDir, "1. Ops Pending.md"));

      for (const call of runTask.mock.calls) {
        expect(call[0].runAll).toBe(true);
        expect(call[0].verify).toBe(true);
        expect(call[0].repairAttempts).toBe(1);
      }
      expect(events.filter((event) => event.kind === "info").map((event) => event.message)).toContain(
        "Predicting migration 2. Root Hot Pending.md...",
      );
      expect(events.filter((event) => event.kind === "success").map((event) => event.message)).toContain(
        "Prediction run completed.",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("exits successfully with informational output when no migrations exist", async () => {
    const workspace = makeTempWorkspace();
    fs.mkdirSync(path.join(workspace, "migrations"), { recursive: true });

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).not.toHaveBeenCalled();
      expect(events.filter((event) => event.kind === "info").map((event) => event.message)).toContain(
        "No migrations found to predict.",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("exits successfully when every discovered migration is already applied", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    const migrationPath = path.join(migrationsDir, "1. Already Applied.md");
    fs.writeFileSync(
      migrationPath,
      "# 1. Already Applied\n\n- [x] done\n",
      "utf-8",
    );
    writePredictionProgress(workspace, [
      {
        migrationPath,
        migrationNumber: 1,
      },
    ]);

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).not.toHaveBeenCalled();
      expect(events.filter((event) => event.kind === "info").map((event) => event.message)).toContain(
        "Prediction is already up to date.",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("logs explicit recovery message when prediction progress state is missing", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "1. First Pending.md"),
      "# 1. First Pending\n\n- [ ] apply\n",
      "utf-8",
    );

    const progressPath = path.join(workspace, ".rundown", "prediction-progress.json");
    if (fs.existsSync(progressPath)) {
      fs.unlinkSync(progressPath);
    }

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(1);
      expect(events.filter((event) => event.kind === "info").map((event) => event.message)).toContain(
        "Prediction progress state not found; starting from first migration.",
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("recovers from unreadable prediction progress state with warning", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "1. First Pending.md"),
      "# 1. First Pending\n\n- [ ] apply\n",
      "utf-8",
    );

    fs.writeFileSync(path.join(workspace, ".rundown", "prediction-progress.json"), "{not-json", "utf-8");

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(1);
      const warnMessages = events.filter((event) => event.kind === "warn").map((event) => event.message);
      expect(warnMessages.some((message) => message.includes("Prediction progress state is unreadable"))).toBe(true);
      expect(warnMessages.some((message) => message.includes("Rebuilding progress from migration files."))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("recovers from incompatible prediction progress state with warning", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });
    fs.writeFileSync(
      path.join(migrationsDir, "1. First Pending.md"),
      "# 1. First Pending\n\n- [ ] apply\n",
      "utf-8",
    );

    fs.writeFileSync(
      path.join(workspace, ".rundown", "prediction-progress.json"),
      JSON.stringify({
        schemaVersion: 999,
        version: "prediction-progress/v999",
        migrations: [],
      }, null, 2) + "\n",
      "utf-8",
    );

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(1);
      const warnMessages = events.filter((event) => event.kind === "warn").map((event) => event.message);
      expect(warnMessages.some((message) => message.includes("Prediction progress state is incompatible"))).toBe(true);
      expect(warnMessages.some((message) => message.includes("Rebuilding progress from migration files."))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("invalidates stale progress from the first changed migration and replays downstream migrations", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });

    const firstMigrationPath = path.join(migrationsDir, "1. First Stable.md");
    const secondMigrationPath = path.join(migrationsDir, "2. Second Changes.md");
    const thirdMigrationPath = path.join(migrationsDir, "3. Third Downstream.md");

    fs.writeFileSync(firstMigrationPath, "# 1. First Stable\n\n- [ ] stable\n", "utf-8");
    fs.writeFileSync(secondMigrationPath, "# 2. Second Changes\n\n- [ ] original\n", "utf-8");
    fs.writeFileSync(thirdMigrationPath, "# 3. Third Downstream\n\n- [ ] downstream\n", "utf-8");

    writePredictionProgress(workspace, [
      { migrationPath: firstMigrationPath, migrationNumber: 1 },
      { migrationPath: secondMigrationPath, migrationNumber: 2 },
      { migrationPath: thirdMigrationPath, migrationNumber: 3 },
    ]);

    fs.writeFileSync(secondMigrationPath, "# 2. Second Changes\n\n- [ ] edited after prediction\n", "utf-8");

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(2);
      const runTaskSources = runTask.mock.calls.map((call) => String(call[0].source));
      const secondPassSource = fs.readFileSync(runTaskSources[0]!, "utf-8");
      const thirdPassSource = fs.readFileSync(runTaskSources[1]!, "utf-8");
      expect(secondPassSource).toContain(secondMigrationPath);
      expect(thirdPassSource).toContain(thirdMigrationPath);

      const infoMessages = events.filter((event) => event.kind === "info").map((event) => event.message);
      expect(
        infoMessages.some((message) => message.includes(
          "Prediction progress invalidated: migration content changed for 2. Second Changes.md",
        )),
      ).toBe(true);
      expect(
        infoMessages.some((message) => message.includes("Replaying from this migration.")),
      ).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("invalidates progress when a previously predicted migration is deleted", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });

    const firstMigrationPath = path.join(migrationsDir, "1. First Stable.md");
    const secondMigrationPath = path.join(migrationsDir, "2. Will Be Deleted.md");
    const thirdMigrationPath = path.join(migrationsDir, "3. Third Downstream.md");

    fs.writeFileSync(firstMigrationPath, "# 1. First Stable\n\n- [ ] stable\n", "utf-8");
    fs.writeFileSync(secondMigrationPath, "# 2. Will Be Deleted\n\n- [ ] soon removed\n", "utf-8");
    fs.writeFileSync(thirdMigrationPath, "# 3. Third Downstream\n\n- [ ] downstream\n", "utf-8");

    writePredictionProgress(workspace, [
      { migrationPath: firstMigrationPath, migrationNumber: 1 },
      { migrationPath: secondMigrationPath, migrationNumber: 2 },
      { migrationPath: thirdMigrationPath, migrationNumber: 3 },
    ]);

    fs.unlinkSync(secondMigrationPath);

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(2);
      const runTaskSources = runTask.mock.calls.map((call) => String(call[0].source));
      const firstPassSource = fs.readFileSync(runTaskSources[0]!, "utf-8");
      const secondPassSource = fs.readFileSync(runTaskSources[1]!, "utf-8");
      expect(firstPassSource).toContain(firstMigrationPath);
      expect(secondPassSource).toContain(thirdMigrationPath);

      const infoMessages = events.filter((event) => event.kind === "info").map((event) => event.message);
      expect(
        infoMessages.some((message) => message.includes(
          "is missing from current migration discovery (possible deletion)",
        )),
      ).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("invalidates progress when a previously predicted migration is renamed or renumbered", async () => {
    const workspace = makeTempWorkspace();
    const migrationsDir = path.join(workspace, "migrations");
    fs.mkdirSync(migrationsDir, { recursive: true });

    const firstMigrationPath = path.join(migrationsDir, "1. First Stable.md");
    const secondMigrationPath = path.join(migrationsDir, "2. Original Name.md");

    fs.writeFileSync(firstMigrationPath, "# 1. First Stable\n\n- [ ] stable\n", "utf-8");
    fs.writeFileSync(secondMigrationPath, "# 2. Original Name\n\n- [ ] second\n", "utf-8");

    writePredictionProgress(workspace, [
      { migrationPath: firstMigrationPath, migrationNumber: 1 },
      { migrationPath: secondMigrationPath, migrationNumber: 2 },
    ]);

    const renamedSecondMigrationPath = path.join(migrationsDir, "2. Renamed Name.md");
    fs.renameSync(secondMigrationPath, renamedSecondMigrationPath);
    fs.writeFileSync(renamedSecondMigrationPath, "# 2. Original Name\n\n- [ ] second\n", "utf-8");

    const events: ApplicationOutputEvent[] = [];
    const runTask = vi.fn(async () => EXIT_CODE_SUCCESS);
    const predictTask = createPredictTask({
      fileSystem: createNodeFileSystem(),
      output: { emit: (event) => events.push(event) },
      runTask,
    });

    const previousCwd = process.cwd();
    process.chdir(workspace);
    try {
      const code = await predictTask({
        dir: "migrations",
        workerPattern: inferWorkerPatternFromCommand(["node", "-e", "void 0"]),
      });

      expect(code).toBe(EXIT_CODE_SUCCESS);
      expect(runTask).toHaveBeenCalledTimes(2);
      const infoMessages = events.filter((event) => event.kind === "info").map((event) => event.message);
      expect(
        infoMessages.some((message) => message.includes("possible rename or renumber")),
      ).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

function makeTempWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-predict-task-"));
  tempDirs.push(workspace);
  fs.mkdirSync(path.join(workspace, ".rundown"), { recursive: true });
  return workspace;
}

function writePredictionProgress(
  workspace: string,
  records: Array<{ migrationPath: string; migrationNumber: number }>,
): void {
  const normalizedRecords = records.map((record) => {
    const source = fs.readFileSync(record.migrationPath, "utf-8");
    const migrationIdentifier = path.relative(workspace, record.migrationPath).split(path.sep).join("/");
    return {
      migrationIdentifier,
      migrationNumber: record.migrationNumber,
      migrationFileName: path.basename(record.migrationPath),
      migrationContentHash: createHash("sha256").update(source, "utf-8").digest("hex"),
      status: "applied",
      appliedAt: new Date().toISOString(),
    };
  });

  fs.writeFileSync(
    path.join(workspace, ".rundown", "prediction-progress.json"),
    JSON.stringify({
      schemaVersion: 1,
      version: "prediction-progress/v1",
      updatedAt: new Date().toISOString(),
      predictionRootPath: path.join(workspace, "prediction", "latest"),
      workspaceRoutingFingerprint: createHash("sha256")
        .update([
          path.join(workspace, "design"),
          path.join(workspace, "implementation"),
          path.join(workspace, "specs"),
          path.join(workspace, "migrations"),
          path.join(workspace, "prediction"),
        ].join("\n"), "utf-8")
        .digest("hex"),
      lastAppliedMigration: normalizedRecords.length > 0
        ? {
          migrationIdentifier: normalizedRecords[normalizedRecords.length - 1]!.migrationIdentifier,
          migrationNumber: normalizedRecords[normalizedRecords.length - 1]!.migrationNumber,
        }
        : null,
      migrations: normalizedRecords,
    }, null, 2) + "\n",
    "utf-8",
  );
}
