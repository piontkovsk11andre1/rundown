import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../../src/infrastructure/adapters/fs-file-system.js";
import { createMigrationAdapter } from "../../../src/infrastructure/adapters/migration-adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createTempMigrationsDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-migration-adapter-"));
  const migrationsDir = path.join(root, "migrations");
  fs.mkdirSync(migrationsDir, { recursive: true });
  tempDirs.push(root);
  return migrationsDir;
}

describe("createMigrationAdapter", () => {
  it("detects isApplied from migration checkbox state", () => {
    const migrationsDir = createTempMigrationsDir();

    fs.writeFileSync(path.join(migrationsDir, "0001-initialize.md"), "- [x] bootstrap\n- [x] add docs\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "0002-implement-feature.md"), "- [x] backend\n- [ ] ui\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "0003-no-tasks.md"), "# Notes only\n", "utf-8");

    const adapter = createMigrationAdapter({ fileSystem: createNodeFileSystem() });
    const state = adapter.scanDirectory(migrationsDir);

    expect(state.migrations.map((migration) => ({ number: migration.number, isApplied: migration.isApplied }))).toEqual([
      { number: 1, isApplied: true },
      { number: 2, isApplied: false },
      { number: 3, isApplied: false },
    ]);
  });

  it("groups migrations and keeps non-migration files ignored", () => {
    const migrationsDir = createTempMigrationsDir();

    fs.writeFileSync(path.join(migrationsDir, "0001-initialize.md"), "- [ ] init\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "0002-implement-feature.md"), "- [ ] impl\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "0003-polish.md"), "- [ ] polish\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "0002--review.md"), "review\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "0004--unknown.md"), "ignore\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "Backlog.md"), "debt\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "README.md"), "not a migration\n", "utf-8");
    fs.writeFileSync(path.join(migrationsDir, "0005-missing-extension.txt"), "ignore\n", "utf-8");

    const adapter = createMigrationAdapter({ fileSystem: createNodeFileSystem() });
    const state = adapter.scanDirectory(migrationsDir);

    expect(state.projectRoot).toBe(path.dirname(migrationsDir));
    expect(state.currentPosition).toBe(3);
    expect(state.migrations.map((migration) => migration.number)).toEqual([1, 2, 3]);
    expect(state.migrations[1]?.satellites.map((satellite) => satellite.type)).toEqual(["review"]);
    expect(state.migrations[2]?.satellites.map((satellite) => satellite.type)).toEqual([]);
    expect(state.latestSnapshot).toBeNull();
    expect(state.backlogPath).toBe(path.join(migrationsDir, "Backlog.md"));
  });
});
