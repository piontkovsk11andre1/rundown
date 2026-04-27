import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatMigrationFilename } from "../../src/domain/migration-parser.js";
import {
  readPredictionTreeAsTrackedFiles,
  reconcilePendingPredictedItemsAtomically,
  createPredictionReconciliationEntryPoint,
  createPredictionBaseline,
  detectStalePendingPredictions,
  reResolvePendingPredictionSequence,
  type PredictionInputs,
} from "../../src/domain/prediction-reconciliation.js";
import { createNodeFileSystem } from "../../src/infrastructure/adapters/fs-file-system.js";

const pathForMigration = (number: number, name: string): string => `migrations/${formatMigrationFilename(number, name)}`;

describe("readPredictionTreeAsTrackedFiles", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("returns an empty list when prediction directory is empty", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-prediction-tree-"));
    tempDirs.push(tempRoot);
    const predictionDir = path.join(tempRoot, "prediction");
    fs.mkdirSync(predictionDir, { recursive: true });

    const trackedFiles = readPredictionTreeAsTrackedFiles({
      fileSystem: createNodeFileSystem(),
      predictionDir,
    });

    expect(trackedFiles).toEqual([]);
  });

  it("reads nested files and returns stable ordering", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-prediction-tree-"));
    tempDirs.push(tempRoot);
    const predictionDir = path.join(tempRoot, "prediction");

    fs.mkdirSync(path.join(predictionDir, "src", "core"), { recursive: true });
    fs.mkdirSync(path.join(predictionDir, "src", "api"), { recursive: true });
    fs.writeFileSync(path.join(predictionDir, "src", "core", "z-last.ts"), "export const z = true;\n", "utf-8");
    fs.writeFileSync(path.join(predictionDir, "src", "api", "a-first.ts"), "export const a = true;\n", "utf-8");
    fs.writeFileSync(path.join(predictionDir, "README.md"), "# Prediction\n", "utf-8");

    const trackedFiles = readPredictionTreeAsTrackedFiles({
      fileSystem: createNodeFileSystem(),
      predictionDir,
    });

    expect(trackedFiles).toEqual([
      {
        relativePath: "README.md",
        migrationNumber: 0,
        kind: "file",
        content: "# Prediction\n",
      },
      {
        relativePath: "src/api/a-first.ts",
        migrationNumber: 0,
        kind: "file",
        content: "export const a = true;\n",
      },
      {
        relativePath: "src/core/z-last.ts",
        migrationNumber: 0,
        kind: "file",
        content: "export const z = true;\n",
      },
    ]);
  });
});

describe("prediction-reconciliation", () => {
  it("returns not stale when no pending predictions exist", () => {
    const baselineInputs: PredictionInputs = {
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
      ],
      files: [
        {
          relativePath: "migrations/0001-initialize.md",
          migrationNumber: 1,
          kind: "migration",
          content: "- [x] done\n",
        },
      ],
    };

    const baseline = createPredictionBaseline(baselineInputs);
    const result = detectStalePendingPredictions({
      baseline,
      current: baselineInputs,
    });

    expect(result).toEqual({
      isStale: false,
      staleReasons: [],
      earliestAffectedMigrationNumber: null,
      staleFromMigrationNumber: null,
      stalePendingMigrationNumbers: [],
    });
  });

  it("marks pending predictions stale from first pending migration when completed migration content changes", () => {
    const baseline = createPredictionBaseline({
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
          content: "- [x] setup\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] implement\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] implement\n",
        },
      ],
    });

    const result = detectStalePendingPredictions({
      baseline,
      current: {
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
            content: "- [x] setup\n- [x] hotfix\n",
          },
          {
            relativePath: "migrations/0002-feature-a.md",
            migrationNumber: 2,
            kind: "migration",
            content: "- [ ] implement\n",
          },
          {
            relativePath: "migrations/0003-feature-b.md",
            migrationNumber: 3,
            kind: "migration",
            content: "- [ ] implement\n",
          },
        ],
      },
    });

    expect(result.isStale).toBe(true);
    expect(result.staleReasons).toEqual(["task_text_changed"]);
    expect(result.staleFromMigrationNumber).toBe(2);
    expect(result.stalePendingMigrationNumbers).toEqual([2, 3]);
  });

  it("marks only later pending predictions stale for a manual edit in pending migration", () => {
    const baseline = createPredictionBaseline({
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: false },
        { number: 3, name: "feature-b", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] implement a\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] implement b\n",
        },
      ],
    });

    const result = detectStalePendingPredictions({
      baseline,
      current: {
        migrations: [
          { number: 1, name: "initialize", isApplied: true },
          { number: 2, name: "feature-a", isApplied: false },
          { number: 3, name: "feature-b", isApplied: false },
        ],
        files: [
          {
            relativePath: "migrations/0002-feature-a.md",
            migrationNumber: 2,
            kind: "migration",
            content: "- [ ] implement a\n",
          },
          {
            relativePath: "migrations/0003-feature-b.md",
            migrationNumber: 3,
            kind: "migration",
            content: "- [ ] implement b\n- [ ] manual hotfix\n",
          },
        ],
      },
    });

    expect(result.isStale).toBe(true);
    expect(result.staleReasons).toEqual(["pending_manual_edit"]);
    expect(result.staleFromMigrationNumber).toBe(3);
    expect(result.stalePendingMigrationNumbers).toEqual([3]);
  });

  it("does not mark stale for whitespace-only changes", () => {
    const baseline = createPredictionBaseline({
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0001-initialize.md",
          migrationNumber: 1,
          kind: "migration",
          content: "- [x] setup\n\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] implement\n",
        },
      ],
    });

    const result = detectStalePendingPredictions({
      baseline,
      current: {
        migrations: [
          { number: 1, name: "initialize", isApplied: true },
          { number: 2, name: "feature-a", isApplied: false },
        ],
        files: [
          {
            relativePath: "migrations\\0001-initialize.md",
            migrationNumber: 1,
            kind: "migration",
            content: "- [x] setup  \r\n\r\n\r\n",
          },
          {
            relativePath: "migrations/0002-feature-a.md",
            migrationNumber: 2,
            kind: "migration",
            content: "- [ ] implement\n",
          },
        ],
      },
    });

    expect(result.isStale).toBe(false);
  });

  it("is a no-op when prediction inputs have not changed", () => {
    const current: PredictionInputs = {
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
          content: "- [x] bootstrap\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] planned a\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] planned b\n",
        },
      ],
    };

    const baseline = createPredictionBaseline(current);
    const staleness = detectStalePendingPredictions({ baseline, current });
    const entryPoint = createPredictionReconciliationEntryPoint({ baseline, current, staleness });
    const reconciled = reconcilePendingPredictedItemsAtomically({
      current,
      plan: {
        startMigrationNumber: 2,
        pendingMigrationNumbers: [],
        items: [],
        fallback: null,
      },
    });

    expect(staleness).toEqual({
      isStale: false,
      staleReasons: [],
      earliestAffectedMigrationNumber: null,
      staleFromMigrationNumber: null,
      stalePendingMigrationNumbers: [],
    });
    expect(entryPoint.reconciliationStartMigrationNumber).toBe(2);
    expect(reconciled.migrations).toEqual(current.migrations);
    expect(reconciled.files).toEqual(current.files);
    expect(reconciled.patch).toEqual({
      removeRelativePaths: [],
      writeFiles: [],
    });
  });

  it("marks stale with sequence_changed when pending ordering changes", () => {
    const baseline = createPredictionBaseline({
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: false },
        { number: 3, name: "feature-b", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] implement\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] implement\n",
        },
      ],
    });

    const result = detectStalePendingPredictions({
      baseline,
      current: {
        migrations: [
          { number: 1, name: "initialize", isApplied: true },
          { number: 3, name: "feature-b", isApplied: false },
          { number: 4, name: "feature-c", isApplied: false },
        ],
        files: [
          {
            relativePath: "migrations/0003-feature-b.md",
            migrationNumber: 3,
            kind: "migration",
            content: "- [ ] implement\n",
          },
          {
            relativePath: "migrations/0004-feature-c.md",
            migrationNumber: 4,
            kind: "migration",
            content: "- [ ] implement\n",
          },
        ],
      },
    });

    expect(result.isStale).toBe(true);
    expect(result.staleReasons).toContain("sequence_changed");
    expect(result.staleFromMigrationNumber).toBe(2);
    expect(result.stalePendingMigrationNumbers).toEqual([2, 3]);
  });


  it("falls back safely when worker output omits pending migrations", async () => {
    const current: PredictionInputs = {
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
          content: "- [x] done\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] planned\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] planned\n",
        },
      ],
    };

    const baseline = createPredictionBaseline(current);
    const staleness = detectStalePendingPredictions({ baseline, current });
    const entryPoint = createPredictionReconciliationEntryPoint({ baseline, current, staleness });

    const plan = await reResolvePendingPredictionSequence({
      entryPoint,
      current,
      invokeWorker: async () => JSON.stringify({
        migrations: [
          {
            number: 2,
            name: "feature-a",
            migration: "# 0002 feature-a\n",
            snapshot: "# Snapshot 0002\n",
          },
        ],
      }),
    });

    expect(plan.startMigrationNumber).toBe(2);
    expect(plan.pendingMigrationNumbers).toEqual([]);
    expect(plan.items).toEqual([]);
    expect(plan.fallback?.reason).toBe("partial_output");
    expect(plan.fallback?.message).toContain("missing pending migration 3");
    expect(plan.fallback?.attemptedPendingMigrationNumbers).toEqual([2, 3]);
  });

  it("falls back safely when worker output has invalid ordering", async () => {
    const current: PredictionInputs = {
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
          content: "- [x] done\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] planned\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] planned\n",
        },
      ],
    };

    const baseline = createPredictionBaseline(current);
    const staleness = detectStalePendingPredictions({ baseline, current });
    const entryPoint = createPredictionReconciliationEntryPoint({ baseline, current, staleness });

    const plan = await reResolvePendingPredictionSequence({
      entryPoint,
      current,
      invokeWorker: async () => JSON.stringify({
        migrations: [
          {
            number: 3,
            name: "feature-b",
            migration: "# 0003 feature-b\n",
            snapshot: "# Snapshot 0003\n",
          },
          {
            number: 2,
            name: "feature-a",
            migration: "# 0002 feature-a\n",
            snapshot: "# Snapshot 0002\n",
          },
        ],
      }),
    });

    expect(plan.pendingMigrationNumbers).toEqual([]);
    expect(plan.items).toEqual([]);
    expect(plan.fallback?.reason).toBe("invalid_ordering");
    expect(plan.fallback?.message).toContain("invalid ordering");
    expect(plan.fallback?.attemptedPendingMigrationNumbers).toEqual([2, 3]);
  });

  it("falls back safely when worker output schema is invalid", async () => {
    const current: PredictionInputs = {
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0001-initialize.md",
          migrationNumber: 1,
          kind: "migration",
          content: "- [x] done\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] planned\n",
        },
      ],
    };

    const baseline = createPredictionBaseline(current);
    const staleness = detectStalePendingPredictions({ baseline, current });
    const entryPoint = createPredictionReconciliationEntryPoint({ baseline, current, staleness });

    const plan = await reResolvePendingPredictionSequence({
      entryPoint,
      current,
      invokeWorker: async () => JSON.stringify({ migrations: "invalid" }),
    });

    expect(plan.pendingMigrationNumbers).toEqual([]);
    expect(plan.items).toEqual([]);
    expect(plan.fallback?.reason).toBe("schema_mismatch");
    expect(plan.fallback?.attemptedPendingMigrationNumbers).toEqual([2]);
  });

  it("rejects atomic patch when plan attempts to rewrite completed migration", () => {
    const current: PredictionInputs = {
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0001-initialize.md",
          migrationNumber: 1,
          kind: "migration",
          content: "- [x] done\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] planned\n",
        },
      ],
    };

    expect(() => reconcilePendingPredictedItemsAtomically({
      current,
      plan: {
        startMigrationNumber: 1,
        pendingMigrationNumbers: [1, 2],
        items: [
          {
            migrationNumber: 1,
            migrationName: "initialize-replanned",
            migrationContent: "# 0001 initialize-replanned\n",
            snapshotContent: "# Snapshot 0001\n",
          },
          {
            migrationNumber: 2,
            migrationName: "feature-a-replanned",
            migrationContent: "# 0002 feature-a-replanned\n",
            snapshotContent: "# Snapshot 0002\n",
          },
        ],
        fallback: null,
      },
    })).toThrow("cannot rewrite completed migration 1");
  });
});
