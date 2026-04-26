import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMigrationDirectory, parseMigrationFilename } from "../../src/domain/migration-parser.js";

describe("parseMigrationFilename", () => {
  it("returns null for invalid migration numbering", () => {
    expect(parseMigrationFilename("123-build.md")).toBeNull();
    expect(parseMigrationFilename("12345-build.md")).toBeNull();
    expect(parseMigrationFilename("12a4-build.md")).toBeNull();
  });

  it("returns null for unknown satellite types", () => {
    expect(parseMigrationFilename("0007--unknown.md")).toBeNull();
    expect(parseMigrationFilename("0007--user-session.md")).toBeNull();
    expect(parseMigrationFilename("0007--context.md")).toBeNull();
    expect(parseMigrationFilename("0007--backlog.md")).toBeNull();
    expect(parseMigrationFilename("0007--user-experience.md")).toBeNull();
    expect(parseMigrationFilename("7.4 Context.md")).toBeNull();
    expect(parseMigrationFilename("7.2 Backlog.md")).toBeNull();
  });

  it("handles double-dash edge cases without misclassifying invalid files", () => {
    expect(parseMigrationFilename("0007--snapshot.md")).toEqual({
      number: 7,
      name: "snapshot",
    });

    expect(parseMigrationFilename("0007---snapshot.md")).toBeNull();
    expect(parseMigrationFilename("0007--snapshot-extra.md")).toBeNull();
    expect(parseMigrationFilename("0007--snapshot.md.bak")).toBeNull();
  });
});

describe("parseMigrationDirectory", () => {
  it("ignores malformed migration and satellite filenames safely", () => {
    const migrationsDir = path.join("/tmp", "project", "migrations");
    const files = [
      path.join(migrationsDir, "0001-initialize.md"),
      path.join(migrationsDir, "0001--context.md"),
      path.join(migrationsDir, "0001--snapshot.md"),
      path.join(migrationsDir, "001-add-auth.md"),
      path.join(migrationsDir, "0002--unknown.md"),
      path.join(migrationsDir, "0001---snapshot.md"),
      path.join(migrationsDir, "0001--snapshot-extra.md"),
      path.join(migrationsDir, "0001--snapshot.md.bak"),
      path.join(migrationsDir, "Backlog.md"),
    ];

    expect(() => parseMigrationDirectory(files, migrationsDir)).not.toThrow();

    const state = parseMigrationDirectory(files, migrationsDir);
    expect(state.migrations).toHaveLength(1);
    expect(state.migrations[0]?.number).toBe(1);
    expect(state.migrations[0]?.satellites.map((satellite) => satellite.type)).toEqual(["snapshot"]);
    expect(state.currentPosition).toBe(1);
    expect(state.latestSnapshot?.migrationNumber).toBe(1);
    expect(state.backlogPath).toBe(path.join(migrationsDir, "Backlog.md"));
  });

  it("uses latest snapshot and ignores removed satellite types in dotted files", () => {
    const migrationsDir = path.join("/tmp", "project", "migrations");
    const files = [
      path.join(migrationsDir, "1. Initialize.md"),
      path.join(migrationsDir, "1.1 Snapshot.md"),
      path.join(migrationsDir, "2. Add Auth.md"),
      path.join(migrationsDir, "2.1 Snapshot.md"),
      path.join(migrationsDir, "2.3 Review.md"),
      path.join(migrationsDir, "2.4 Context.md"),
      path.join(migrationsDir, "2.2 Backlog.md"),
      path.join(migrationsDir, "Backlog.md"),
    ];

    const state = parseMigrationDirectory(files, migrationsDir);
    expect(state.currentPosition).toBe(2);
    expect(state.latestSnapshot).toEqual({
      migrationNumber: 2,
      type: "snapshot",
      filePath: path.join(migrationsDir, "2.1 Snapshot.md"),
    });
    expect(state.backlogPath).toBe(path.join(migrationsDir, "Backlog.md"));
    expect(state.migrations[1]?.satellites.map((satellite) => satellite.type)).toEqual(["review", "snapshot"]);
  });

  it("does not set backlogPath when singleton Backlog.md is absent", () => {
    const migrationsDir = path.join("/tmp", "project", "migrations");
    const files = [
      path.join(migrationsDir, "1. Initialize.md"),
      path.join(migrationsDir, "1.1 Snapshot.md"),
      path.join(migrationsDir, "1.2 Backlog.md"),
    ];

    const state = parseMigrationDirectory(files, migrationsDir);
    expect(state.backlogPath).toBeNull();
  });
});
