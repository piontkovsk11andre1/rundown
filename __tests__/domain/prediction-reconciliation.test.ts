import { describe, expect, it } from "vitest";
import {
  reconcilePendingPredictedItemsAtomically,
  createPredictionReconciliationEntryPoint,
  createPredictionBaseline,
  detectStalePendingPredictions,
  reResolvePendingPredictionSequence,
  type PredictionInputs,
} from "../../src/domain/prediction-reconciliation.js";

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

  it("builds reconciliation entry point from latest executed migration state", () => {
    const current: PredictionInputs = {
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: true },
        { number: 3, name: "feature-b", isApplied: false },
        { number: 4, name: "feature-c", isApplied: false },
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
          content: "- [x] delivered\n",
        },
        {
          relativePath: "migrations/0002--context.md",
          migrationNumber: 2,
          kind: "context",
          content: "# Context at 0002\n",
        },
        {
          relativePath: "migrations/0002--snapshot.md",
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot at 0002\n",
        },
        {
          relativePath: "migrations/0002--backlog.md",
          migrationNumber: 2,
          kind: "backlog",
          content: "# Backlog at 0002\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] planned\n",
        },
        {
          relativePath: "migrations/0004-feature-c.md",
          migrationNumber: 4,
          kind: "migration",
          content: "- [ ] planned\n",
        },
      ],
    };
    const baseline = createPredictionBaseline(current);
    const staleness = detectStalePendingPredictions({
      baseline,
      current: {
        ...current,
        files: current.files.map((file) => (file.relativePath === "migrations/0003-feature-b.md"
          ? { ...file, content: "- [ ] planned\n- [ ] hot fix follow-up\n" }
          : file)),
      },
    });

    const entryPoint = createPredictionReconciliationEntryPoint({
      baseline,
      current,
      staleness,
    });

    expect(entryPoint.lastCompletedMigrationNumber).toBe(2);
    expect(entryPoint.reconciliationStartMigrationNumber).toBe(3);
    expect(entryPoint.preservedCompletedMigrationNumbers).toEqual([1, 2]);
    expect(entryPoint.pendingPredictionMigrationNumbers).toEqual([3, 4]);
    expect(entryPoint.latestExecutedMigration?.relativePath).toBe("migrations/0002-feature-a.md");
    expect(entryPoint.latestContext?.relativePath).toBe("migrations/0002--context.md");
    expect(entryPoint.latestSnapshot?.relativePath).toBe("migrations/0002--snapshot.md");
    expect(entryPoint.latestBacklog?.relativePath).toBe("migrations/0002--backlog.md");
  });

  it("uses pending frontier as reconciliation start when predictions are not stale", () => {
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
          content: "- [x] bootstrap\n",
        },
        {
          relativePath: "migrations/0001--snapshot.md",
          migrationNumber: 1,
          kind: "snapshot",
          content: "# Snapshot at 0001\n",
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

    expect(staleness.isStale).toBe(false);
    expect(entryPoint.reconciliationStartMigrationNumber).toBe(2);
    expect(entryPoint.latestExecutedMigration?.relativePath).toBe("migrations/0001-initialize.md");
    expect(entryPoint.latestSnapshot?.relativePath).toBe("migrations/0001--snapshot.md");
  });

  it("re-resolves only remaining pending sequence from current state", async () => {
    const current: PredictionInputs = {
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: true },
        { number: 3, name: "feature-b", isApplied: false },
        { number: 4, name: "feature-c", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [x] completed\n",
        },
        {
          relativePath: "migrations/0002--context.md",
          migrationNumber: 2,
          kind: "context",
          content: "# Context at 0002\n",
        },
        {
          relativePath: "migrations/0002--snapshot.md",
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot at 0002\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] planned b\n",
        },
        {
          relativePath: "migrations/0004-feature-c.md",
          migrationNumber: 4,
          kind: "migration",
          content: "- [ ] planned c\n",
        },
      ],
    };
    const baseline = createPredictionBaseline(current);
    const staleness = detectStalePendingPredictions({
      baseline,
      current: {
        ...current,
        files: current.files.map((file) => (file.relativePath === "migrations/0003-feature-b.md"
          ? { ...file, content: "- [ ] planned b\n- [ ] manual edit\n" }
          : file)),
      },
    });
    const entryPoint = createPredictionReconciliationEntryPoint({ baseline, current, staleness });

    const capturedPrompts: string[] = [];
    const plan = await reResolvePendingPredictionSequence({
      entryPoint,
      current,
      invokeWorker: async (prompt) => {
        capturedPrompts.push(prompt);
        return JSON.stringify({
          migrations: [
            {
              number: 3,
              name: "Feature B Replanned",
              migration: "# 0003 feature-b-replanned\n\n- [ ] updated\n",
              snapshot: "# Snapshot 0003\n",
            },
            {
              number: 4,
              name: "feature-c-replanned",
              migration: "# 0004 feature-c-replanned\n\n- [ ] updated\n",
              snapshot: "# Snapshot 0004\n",
            },
          ],
        });
      },
    });

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("reconciliationStartMigrationNumber: 3");
    expect(capturedPrompts[0]).toContain("pendingMigrationNumbers: [3, 4]");
    expect(capturedPrompts[0]).not.toContain("0002-feature-a.md");

    expect(plan.startMigrationNumber).toBe(3);
    expect(plan.pendingMigrationNumbers).toEqual([3, 4]);
    expect(plan.items.map((item) => item.migrationNumber)).toEqual([3, 4]);
    expect(plan.items[0]?.migrationName).toBe("feature-b-replanned");
    expect(plan.fallback).toBeNull();
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

  it("atomically patches only pending migration and snapshot artifacts", () => {
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
          relativePath: "migrations/0001--snapshot.md",
          migrationNumber: 1,
          kind: "snapshot",
          content: "# Snapshot 0001\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] old planned a\n",
        },
        {
          relativePath: "migrations/0002--snapshot.md",
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot 0002 old\n",
        },
        {
          relativePath: "migrations/0002--context.md",
          migrationNumber: 2,
          kind: "context",
          content: "# Context 0002\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] old planned b\n",
        },
        {
          relativePath: "migrations/0003--snapshot.md",
          migrationNumber: 3,
          kind: "snapshot",
          content: "# Snapshot 0003 old\n",
        },
      ],
    };

    const reconciled = reconcilePendingPredictedItemsAtomically({
      current,
      plan: {
        startMigrationNumber: 2,
        pendingMigrationNumbers: [2, 3],
        items: [
          {
            migrationNumber: 2,
            migrationName: "feature-a-replanned",
            migrationContent: "# 0002 feature-a-replanned\n",
            snapshotContent: "# Snapshot 0002 new\n",
          },
          {
            migrationNumber: 3,
            migrationName: "feature-b-replanned",
            migrationContent: "# 0003 feature-b-replanned\n",
            snapshotContent: "# Snapshot 0003 new\n",
          },
        ],
        fallback: null,
      },
    });

    expect(reconciled.preservedCompletedMigrationNumbers).toEqual([1]);
    expect(reconciled.reconciledPendingMigrationNumbers).toEqual([2, 3]);
    expect(reconciled.patch.removeRelativePaths).toEqual([
      "migrations/0002--snapshot.md",
      "migrations/0002-feature-a.md",
      "migrations/0003--snapshot.md",
      "migrations/0003-feature-b.md",
    ]);

    expect(reconciled.patch.writeFiles.map((file) => file.relativePath)).toEqual([
      "migrations/0002--snapshot.md",
      "migrations/0002-feature-a-replanned.md",
      "migrations/0003--snapshot.md",
      "migrations/0003-feature-b-replanned.md",
    ]);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0001-initialize.md")).toBe(true);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0002--context.md")).toBe(true);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0002-feature-a.md")).toBe(false);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0003-feature-b.md")).toBe(false);
    expect(reconciled.migrations).toEqual([
      { number: 1, name: "initialize", isApplied: true },
      { number: 2, name: "feature-a-replanned", isApplied: false },
      { number: 3, name: "feature-b-replanned", isApplied: false },
    ]);
  });

  it("preserves completed migration history while rewriting pending plan", () => {
    const current: PredictionInputs = {
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: true },
        { number: 3, name: "feature-b", isApplied: false },
        { number: 4, name: "feature-c", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0001-initialize.md",
          migrationNumber: 1,
          kind: "migration",
          content: "- [x] completed 0001\n",
        },
        {
          relativePath: "migrations/0001--snapshot.md",
          migrationNumber: 1,
          kind: "snapshot",
          content: "# Snapshot 0001\n",
        },
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [x] completed 0002\n",
        },
        {
          relativePath: "migrations/0002--snapshot.md",
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot 0002\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] old planned 0003\n",
        },
        {
          relativePath: "migrations/0003--snapshot.md",
          migrationNumber: 3,
          kind: "snapshot",
          content: "# Snapshot 0003 old\n",
        },
        {
          relativePath: "migrations/0004-feature-c.md",
          migrationNumber: 4,
          kind: "migration",
          content: "- [ ] old planned 0004\n",
        },
        {
          relativePath: "migrations/0004--snapshot.md",
          migrationNumber: 4,
          kind: "snapshot",
          content: "# Snapshot 0004 old\n",
        },
      ],
    };

    const reconciled = reconcilePendingPredictedItemsAtomically({
      current,
      plan: {
        startMigrationNumber: 3,
        pendingMigrationNumbers: [3, 4],
        items: [
          {
            migrationNumber: 3,
            migrationName: "feature-b-hotfix-reconciled",
            migrationContent: "# 0003 feature-b-hotfix-reconciled\n",
            snapshotContent: "# Snapshot 0003 new\n",
          },
          {
            migrationNumber: 4,
            migrationName: "feature-c-reconciled",
            migrationContent: "# 0004 feature-c-reconciled\n",
            snapshotContent: "# Snapshot 0004 new\n",
          },
        ],
        fallback: null,
      },
    });

    expect(reconciled.preservedCompletedMigrationNumbers).toEqual([1, 2]);
    expect(reconciled.migrations.filter((migration) => migration.isApplied)).toEqual([
      { number: 1, name: "initialize", isApplied: true },
      { number: 2, name: "feature-a", isApplied: true },
    ]);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0001-initialize.md")).toBe(true);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0002-feature-a.md")).toBe(true);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0003-feature-b.md")).toBe(false);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0004-feature-c.md")).toBe(false);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0003-feature-b-hotfix-reconciled.md")).toBe(true);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0004-feature-c-reconciled.md")).toBe(true);
  });

  it("rewrites only the specified pending subset during reconciliation", () => {
    const current: PredictionInputs = {
      migrations: [
        { number: 1, name: "initialize", isApplied: true },
        { number: 2, name: "feature-a", isApplied: false },
        { number: 3, name: "feature-b", isApplied: false },
        { number: 4, name: "feature-c", isApplied: false },
      ],
      files: [
        {
          relativePath: "migrations/0002-feature-a.md",
          migrationNumber: 2,
          kind: "migration",
          content: "- [ ] keep existing\n",
        },
        {
          relativePath: "migrations/0002--snapshot.md",
          migrationNumber: 2,
          kind: "snapshot",
          content: "# Snapshot 0002 keep\n",
        },
        {
          relativePath: "migrations/0003-feature-b.md",
          migrationNumber: 3,
          kind: "migration",
          content: "- [ ] replace 0003\n",
        },
        {
          relativePath: "migrations/0003--snapshot.md",
          migrationNumber: 3,
          kind: "snapshot",
          content: "# Snapshot 0003 old\n",
        },
        {
          relativePath: "migrations/0004-feature-c.md",
          migrationNumber: 4,
          kind: "migration",
          content: "- [ ] keep existing 0004\n",
        },
        {
          relativePath: "migrations/0004--snapshot.md",
          migrationNumber: 4,
          kind: "snapshot",
          content: "# Snapshot 0004 keep\n",
        },
      ],
    };

    const reconciled = reconcilePendingPredictedItemsAtomically({
      current,
      plan: {
        startMigrationNumber: 3,
        pendingMigrationNumbers: [3],
        items: [
          {
            migrationNumber: 3,
            migrationName: "feature-b-rewritten",
            migrationContent: "# 0003 feature-b-rewritten\n",
            snapshotContent: "# Snapshot 0003 rewritten\n",
          },
        ],
        fallback: null,
      },
    });

    expect(reconciled.reconciledPendingMigrationNumbers).toEqual([3]);
    expect(reconciled.patch.removeRelativePaths).toEqual([
      "migrations/0003--snapshot.md",
      "migrations/0003-feature-b.md",
    ]);
    expect(reconciled.patch.writeFiles.map((file) => file.relativePath)).toEqual([
      "migrations/0003--snapshot.md",
      "migrations/0003-feature-b-rewritten.md",
    ]);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0002-feature-a.md")).toBe(true);
    expect(reconciled.files.some((file) => file.relativePath === "migrations/0004-feature-c.md")).toBe(true);
    expect(reconciled.migrations).toEqual([
      { number: 1, name: "initialize", isApplied: true },
      { number: 2, name: "feature-a", isApplied: false },
      { number: 3, name: "feature-b-rewritten", isApplied: false },
      { number: 4, name: "feature-c", isApplied: false },
    ]);
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
