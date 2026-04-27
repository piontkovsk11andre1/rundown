import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMigrationDirectory, parseMigrationFilename } from "../../src/domain/migration-parser.js";

describe("parseMigrationFilename", () => {
  it("returns null for invalid migration numbering", () => {
    expect(parseMigrationFilename("123-build.md")).toBeNull();
    expect(parseMigrationFilename("12345-build.md")).toBeNull();
    expect(parseMigrationFilename("12a4-build.md")).toBeNull();
  });

  it("returns null for unknown double-dash types", () => {
    expect(parseMigrationFilename("0007--unknown.md")).toBeNull();
    expect(parseMigrationFilename("0007--user-session.md")).toBeNull();
    expect(parseMigrationFilename("0007--context.md")).toBeNull();
    expect(parseMigrationFilename("0007--backlog.md")).toBeNull();
    expect(parseMigrationFilename("0007--user-experience.md")).toBeNull();
    expect(parseMigrationFilename("7.4 Context.md")).toBeNull();
    expect(parseMigrationFilename("7.2 Backlog.md")).toBeNull();
  });

  it("parses review filenames and rejects malformed variants", () => {
    expect(parseMigrationFilename("0007--review.md")).toEqual({
      number: 7,
      name: "review",
    });

    expect(parseMigrationFilename("0007---review.md")).toBeNull();
    expect(parseMigrationFilename("0007--review-extra.md")).toBeNull();
    expect(parseMigrationFilename("0007--review.md.bak")).toBeNull();
  });
});

describe("parseMigrationDirectory", () => {
  it("ignores malformed migration-like filenames safely", () => {
    const migrationsDir = path.join("/tmp", "project", "migrations");
    const files = [
      path.join(migrationsDir, "0001-initialize.md"),
      path.join(migrationsDir, "0001--review.md"),
      path.join(migrationsDir, "001-add-auth.md"),
      path.join(migrationsDir, "0002--unknown.md"),
      path.join(migrationsDir, "0001---review.md"),
      path.join(migrationsDir, "0001--review-extra.md"),
      path.join(migrationsDir, "0001--review.md.bak"),
      path.join(migrationsDir, "Backlog.md"),
    ];

    expect(() => parseMigrationDirectory(files, migrationsDir)).not.toThrow();

    const state = parseMigrationDirectory(files, migrationsDir);
    expect(state.migrations).toHaveLength(1);
    expect(state.migrations[0]?.number).toBe(1);
    expect(state.migrations[0]?.reviews.map((review) => review.type)).toEqual(["review"]);
    expect(state.currentPosition).toBe(1);
    expect(state.backlogPath).toBe(path.join(migrationsDir, "Backlog.md"));
  });

  it("ignores legacy suffix auxiliary files gracefully", () => {
    const migrationsDir = path.join("/tmp", "project", "migrations");
    const files = [
      path.join(migrationsDir, "1. Initialize.md"),
      path.join(migrationsDir, "1.3 Review.md"),
      path.join(migrationsDir, "0002-add-auth.md"),
      path.join(migrationsDir, "0002.snapshot.md"),
      path.join(migrationsDir, "0002.context.md"),
      path.join(migrationsDir, "0002.backlog.md"),
      path.join(migrationsDir, "Backlog.md"),
    ];

    expect(() => parseMigrationDirectory(files, migrationsDir)).not.toThrow();

    const state = parseMigrationDirectory(files, migrationsDir);
    expect(state.currentPosition).toBe(2);
    expect(state.migrations).toHaveLength(2);
    expect(state.migrations[0]?.number).toBe(1);
    expect(state.migrations[0]?.reviews.map((review) => review.type)).toEqual(["review"]);
    expect(state.migrations[1]?.number).toBe(2);
    expect(state.migrations[1]?.reviews).toEqual([]);
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
