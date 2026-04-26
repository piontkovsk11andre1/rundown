import { describe, expect, it } from "vitest";
import {
  discoverDesignRevisionDirectories,
  findLowestUnplannedRevision,
  markRevisionPlanned,
  markRevisionUnmigrated,
  prepareDesignRevisionDiffContext,
  resolveDesignContext,
  resolveDesignContextSourceReferences,
  saveDesignRevisionSnapshot,
} from "../../src/application/design-context.ts";
import type {
  FileSystem,
  FileSystemDirent,
  FileSystemStat,
} from "../../src/domain/ports/file-system.ts";

class InMemoryFileSystem implements FileSystem {
  private readonly directories = new Map<string, FileSystemDirent[]>();

  private readonly files = new Map<string, string>();

  private readonly stats = new Map<string, FileSystemStat>();

  public constructor(seed: {
    directories?: Record<string, FileSystemDirent[]>;
    files?: Record<string, string>;
    stats?: Record<string, FileSystemStat>;
  }) {
    for (const [dirPath, entries] of Object.entries(seed.directories ?? {})) {
      const normalizedDirPath = normalizePath(dirPath);
      this.directories.set(normalizedDirPath, entries.slice());
      this.stats.set(normalizedDirPath, { isDirectory: true, isFile: false });
    }

    for (const [filePath, content] of Object.entries(seed.files ?? {})) {
      const normalizedFilePath = normalizePath(filePath);
      this.files.set(normalizedFilePath, content);
      this.stats.set(normalizedFilePath, { isDirectory: false, isFile: true });
    }

    for (const [entryPath, stat] of Object.entries(seed.stats ?? {})) {
      this.stats.set(normalizePath(entryPath), stat);
    }
  }

  public exists(targetPath: string): boolean {
    return this.stats.has(normalizePath(targetPath));
  }

  public readText(filePath: string): string {
    const normalizedFilePath = normalizePath(filePath);
    const value = this.files.get(normalizedFilePath);
    if (value === undefined) {
      throw new Error("File not found: " + normalizedFilePath);
    }

    return value;
  }

  public writeText(filePath: string, content: string): void {
    const normalizedFilePath = normalizePath(filePath);
    this.files.set(normalizedFilePath, content);
    this.stats.set(normalizedFilePath, { isDirectory: false, isFile: true });
  }

  public mkdir(dirPath: string): void {
    const normalizedDirPath = normalizePath(dirPath);
    if (!this.directories.has(normalizedDirPath)) {
      this.directories.set(normalizedDirPath, []);
    }
    this.stats.set(normalizedDirPath, { isDirectory: true, isFile: false });
  }

  public readdir(dirPath: string): FileSystemDirent[] {
    return (this.directories.get(normalizePath(dirPath)) ?? []).slice();
  }

  public stat(targetPath: string): FileSystemStat | null {
    return this.stats.get(normalizePath(targetPath)) ?? null;
  }

  public unlink(filePath: string): void {
    const normalizedFilePath = normalizePath(filePath);
    this.files.delete(normalizedFilePath);
    this.stats.delete(normalizedFilePath);
  }

  public rm(targetPath: string): void {
    const normalizedTargetPath = normalizePath(targetPath);
    this.files.delete(normalizedTargetPath);
    this.directories.delete(normalizedTargetPath);
    this.stats.delete(normalizedTargetPath);
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

describe("design-context revision metadata and immutability", () => {
  it("finds the lowest unplanned released revision and skips rev.0", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "rev.0", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
          { name: "rev.3", isDirectory: true, isFile: false },
        ],
        "/repo/design/rev.0": [{ name: "Target.md", isDirectory: false, isFile: true }],
        "/repo/design/rev.1": [{ name: "Target.md", isDirectory: false, isFile: true }],
        "/repo/design/rev.2": [{ name: "Target.md", isDirectory: false, isFile: true }],
        "/repo/design/rev.3": [{ name: "Target.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/design/rev.0/Target.md": "zero\n",
        "/repo/design/rev.1/Target.md": "one\n",
        "/repo/design/rev.2/Target.md": "two\n",
        "/repo/design/rev.3/Target.md": "three\n",
        "/repo/design/rev.0.meta.json": JSON.stringify({
          revision: "rev.0",
          index: 0,
          createdAt: "2026-01-01T00:00:00.000Z",
          plannedAt: "2026-01-01T00:00:00.000Z",
          migrations: [],
        }),
        "/repo/design/rev.1.meta.json": JSON.stringify({
          revision: "rev.1",
          index: 1,
          createdAt: "2026-01-02T00:00:00.000Z",
          plannedAt: "2026-01-02T00:00:00.000Z",
          migrations: ["1. Existing.md"],
        }),
        "/repo/design/rev.3.meta.json": JSON.stringify({
          revision: "rev.3",
          index: 3,
          createdAt: "2026-01-04T00:00:00.000Z",
          plannedAt: "2026-01-04T00:00:00.000Z",
          migrations: ["2. Existing.md"],
        }),
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/rev.0": { isDirectory: true, isFile: false },
        "/repo/design/rev.1": { isDirectory: true, isFile: false },
        "/repo/design/rev.2": { isDirectory: true, isFile: false },
        "/repo/design/rev.3": { isDirectory: true, isFile: false },
        "/repo/design/rev.0.meta.json": { isDirectory: false, isFile: true },
        "/repo/design/rev.1.meta.json": { isDirectory: false, isFile: true },
        "/repo/design/rev.3.meta.json": { isDirectory: false, isFile: true },
      },
    });

    const unplanned = findLowestUnplannedRevision(fileSystem, "/repo");

    expect(unplanned).toMatchObject({
      name: "rev.2",
      index: 2,
      metadata: {
        plannedAt: null,
        migrations: [],
      },
    });
  });

  it("returns null when all released revisions are already planned", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "rev.0", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
        ],
        "/repo/design/rev.0": [{ name: "Target.md", isDirectory: false, isFile: true }],
        "/repo/design/rev.1": [{ name: "Target.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/design/rev.0/Target.md": "zero\n",
        "/repo/design/rev.1/Target.md": "one\n",
        "/repo/design/rev.1.meta.json": JSON.stringify({
          revision: "rev.1",
          index: 1,
          createdAt: "2026-01-02T00:00:00.000Z",
          plannedAt: "2026-01-02T00:00:00.000Z",
          migrations: ["1. Existing.md"],
        }),
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/rev.0": { isDirectory: true, isFile: false },
        "/repo/design/rev.1": { isDirectory: true, isFile: false },
        "/repo/design/rev.1.meta.json": { isDirectory: false, isFile: true },
      },
    });

    expect(findLowestUnplannedRevision(fileSystem, "/repo")).toBeNull();
  });

  it("returns null when only rev.0 exists", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "rev.0", isDirectory: true, isFile: false },
        ],
        "/repo/design/rev.0": [{ name: "Target.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/design/rev.0/Target.md": "zero\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/rev.0": { isDirectory: true, isFile: false },
      },
    });

    expect(findLowestUnplannedRevision(fileSystem, "/repo")).toBeNull();
  });

  it("marks a revision planned and records migrations", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "rev.1", isDirectory: true, isFile: false },
        ],
        "/repo/design/rev.1": [{ name: "Target.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/design/rev.1/Target.md": "one\n",
        "/repo/design/rev.1.meta.json": JSON.stringify({
          revision: "rev.1",
          index: 1,
          createdAt: "2026-01-02T00:00:00.000Z",
          label: "Release 1",
        }),
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/rev.1": { isDirectory: true, isFile: false },
        "/repo/design/rev.1.meta.json": { isDirectory: false, isFile: true },
      },
    });

    markRevisionPlanned(fileSystem, "/repo", "rev.1", ["139. Example.md", "140. Follow-up.md"]);

    const persisted = JSON.parse(fileSystem.readText("/repo/design/rev.1.meta.json")) as {
      revision: string;
      index: number;
      createdAt: string;
      label?: string;
      plannedAt?: string;
      migrations?: string[];
    };

    expect(persisted.revision).toBe("rev.1");
    expect(persisted.index).toBe(1);
    expect(persisted.createdAt).toBe("2026-01-02T00:00:00.000Z");
    expect(persisted.label).toBe("Release 1");
    expect(typeof persisted.plannedAt).toBe("string");
    expect(persisted.migrations).toEqual(["139. Example.md", "140. Follow-up.md"]);
  });

  it("creates revision metadata when it is missing", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "rev.2", isDirectory: true, isFile: false },
        ],
        "/repo/design/rev.2": [{ name: "Target.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/design/rev.2/Target.md": "two\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/rev.2": { isDirectory: true, isFile: false },
      },
    });

    markRevisionPlanned(fileSystem, "/repo", "rev.2", []);

    const persisted = JSON.parse(fileSystem.readText("/repo/design/rev.2.meta.json")) as {
      revision: string;
      index: number;
      createdAt: string;
      plannedAt?: string;
      migrations?: string[];
    };

    expect(persisted.revision).toBe("rev.2");
    expect(persisted.index).toBe(2);
    expect(typeof persisted.createdAt).toBe("string");
    expect(persisted.createdAt.length).toBeGreaterThan(0);
    expect(typeof persisted.plannedAt).toBe("string");
    expect(persisted.migrations).toEqual([]);
  });

  it("marks an existing revision as unmigrated by setting migratedAt to null", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [],
        "/repo/design/rev.2": [{ name: "Target.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/design/rev.2/Target.md": "two\n",
        "/repo/design/rev.2.meta.json": JSON.stringify({
          revision: "rev.2",
          index: 2,
          createdAt: "2026-01-02T00:00:00.000Z",
          plannedAt: "2026-01-02T00:01:00.000Z",
          migrations: ["140. Something.md"],
          migratedAt: "2026-01-02T00:02:00.000Z",
          extra: "preserve-me",
        }),
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/design/rev.2": { isDirectory: true, isFile: false },
        "/repo/design/rev.2.meta.json": { isDirectory: false, isFile: true },
      },
    });

    markRevisionUnmigrated(fileSystem, "/repo", "rev.2");

    const persisted = JSON.parse(fileSystem.readText("/repo/design/rev.2.meta.json")) as {
      revision: string;
      index: number;
      createdAt: string;
      plannedAt?: string | null;
      migrations?: string[];
      migratedAt?: string | null;
      extra?: string;
    };
    expect(persisted.revision).toBe("rev.2");
    expect(persisted.index).toBe(2);
    expect(persisted.createdAt).toBe("2026-01-02T00:00:00.000Z");
    expect(persisted.plannedAt).toBe("2026-01-02T00:01:00.000Z");
    expect(persisted.migrations).toEqual(["140. Something.md"]);
    expect(persisted.migratedAt).toBeNull();
    expect(persisted.extra).toBe("preserve-me");
  });

  it("no-ops when revision metadata does not exist while marking unmigrated", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.3", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [],
        "/repo/design/rev.3": [{ name: "Target.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/design/rev.3/Target.md": "three\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/design/rev.3": { isDirectory: true, isFile: false },
      },
    });

    expect(() => markRevisionUnmigrated(fileSystem, "/repo", "rev.3")).not.toThrow();
    expect(fileSystem.stat("/repo/design/rev.3.meta.json")).toBeNull();
  });

  it("saves canonical design/current into design/rev.N snapshots", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/design/current/Target.md": "current\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/design/rev.2": { isDirectory: true, isFile: false },
      },
    });

    const saved = saveDesignRevisionSnapshot(fileSystem, "/repo");

    expect(saved).toMatchObject({
      kind: "saved",
      revision: {
        index: 3,
        name: "rev.3",
        absolutePath: expect.any(String),
        sourcePath: expect.any(String),
      },
    });
    if (saved.kind === "saved") {
      expect(normalizePath(saved.revision.absolutePath)).toBe("/repo/design/rev.3");
      expect(normalizePath(saved.revision.sourcePath)).toBe("/repo/design/current");
    }
    expect(fileSystem.readText("/repo/design/rev.3/Target.md")).toBe("current\n");
  });

  it("falls back to legacy docs/current for revisions when canonical design/current is missing", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [],
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.4", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [
          { name: "Design.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/current/Design.md": "legacy\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
        "/repo/docs/rev.4": { isDirectory: true, isFile: false },
      },
    });

    const saved = saveDesignRevisionSnapshot(fileSystem, "/repo");

    expect(saved).toMatchObject({
      kind: "saved",
      revision: {
        index: 5,
        name: "rev.5",
        absolutePath: expect.any(String),
        sourcePath: expect.any(String),
      },
    });
    if (saved.kind === "saved") {
      expect(normalizePath(saved.revision.absolutePath)).toBe("/repo/docs/rev.5");
      expect(normalizePath(saved.revision.sourcePath)).toBe("/repo/docs/current");
    }
    expect(fileSystem.readText("/repo/docs/rev.5/Design.md")).toBe("legacy\n");
  });

  it("keeps saved revision content immutable after later docs/current edits", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [
          { name: "Design.md", isDirectory: false, isFile: true },
          { name: "notes", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current/notes": [
          { name: "api.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/current/Design.md": "original design\n",
        "/repo/docs/current/notes/api.md": "v1\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
        "/repo/docs/current/notes": { isDirectory: true, isFile: false },
      },
    });

    const saved = saveDesignRevisionSnapshot(fileSystem, "/repo", {
      now: new Date("2026-01-02T03:04:05.000Z"),
    });
    expect(saved.kind).toBe("saved");

    fileSystem.writeText("/repo/docs/current/Design.md", "updated design\n");
    fileSystem.writeText("/repo/docs/current/notes/api.md", "v2\n");

    expect(fileSystem.readText("/repo/docs/rev.0/Design.md")).toBe("original design\n");
    expect(fileSystem.readText("/repo/docs/rev.0/notes/api.md")).toBe("v1\n");
    expect(JSON.parse(fileSystem.readText("/repo/docs/rev.0.meta.json"))).toEqual({
      revision: "rev.0",
      index: 0,
      createdAt: "2026-01-02T03:04:05.000Z",
    });
  });

  it("returns unchanged when design/current matches the latest saved revision", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.5", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
          { name: "notes", isDirectory: true, isFile: false },
        ],
        "/repo/design/current/notes": [
          { name: "api.md", isDirectory: false, isFile: true },
        ],
        "/repo/design/rev.5": [
          { name: "Target.md", isDirectory: false, isFile: true },
          { name: "notes", isDirectory: true, isFile: false },
        ],
        "/repo/design/rev.5/notes": [
          { name: "api.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/design/current/Target.md": "same\n",
        "/repo/design/current/notes/api.md": "same\n",
        "/repo/design/rev.5/Target.md": "same\n",
        "/repo/design/rev.5/notes/api.md": "same\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/design/current/notes": { isDirectory: true, isFile: false },
        "/repo/design/rev.5": { isDirectory: true, isFile: false },
        "/repo/design/rev.5/notes": { isDirectory: true, isFile: false },
      },
    });

    const saved = saveDesignRevisionSnapshot(fileSystem, "/repo");

    expect(saved).toMatchObject({
      kind: "unchanged",
      latestRevision: {
        index: 5,
        name: "rev.5",
        metadata: { createdAt: "", label: "" },
      },
    });
    if (saved.kind === "unchanged") {
      expect(normalizePath(saved.sourcePath)).toBe("/repo/design/current");
      expect(normalizePath(saved.latestRevision.absolutePath)).toBe("/repo/design/rev.5");
      expect(normalizePath(saved.latestRevision.metadataPath)).toBe("/repo/design/rev.5.meta.json");
    }
    expect(fileSystem.stat("/repo/design/rev.6")).toBeNull();
  });

  it("writes optional label metadata into revision sidecar", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/design/current/Target.md": "draft\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
      },
    });

    const saved = saveDesignRevisionSnapshot(fileSystem, "/repo", {
      label: "  stable  ",
      now: new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(saved.kind).toBe("saved");
    expect(JSON.parse(fileSystem.readText("/repo/design/rev.0.meta.json"))).toEqual({
      revision: "rev.0",
      index: 0,
      createdAt: "2026-01-02T03:04:05.000Z",
      label: "stable",
    });
  });

  it("throws immutable conflicts when next revision directory or sidecar already exists", () => {
    const occupiedRevisionDir = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/design/current/Target.md": "draft\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/design/rev.2": { isDirectory: true, isFile: false },
        "/repo/design/rev.3": { isDirectory: false, isFile: true },
      },
    });

    expect(() => saveDesignRevisionSnapshot(occupiedRevisionDir, "/repo")).toThrow(
      /Cannot save design revision: target snapshot already exists and revisions are immutable/,
    );

    const occupiedMetadataSidecar = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/design/current/Target.md": "draft\n",
        "/repo/design/rev.3.meta.json": "{}\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/design/rev.2": { isDirectory: true, isFile: false },
        "/repo/design/rev.3.meta.json": { isDirectory: false, isFile: true },
      },
    });

    expect(() => saveDesignRevisionSnapshot(occupiedMetadataSidecar, "/repo")).toThrow(
      /Cannot save design revision: metadata sidecar already exists for immutable snapshot rev\.3/,
    );
  });

  it("respects configured workspace design directory for snapshot resolution and guidance", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/blueprint": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo/blueprint/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/.rundown/config.json": JSON.stringify({
          workspace: {
            directories: {
              design: "blueprint",
            },
          },
        }),
        "/repo/blueprint/current/Target.md": "configured\n",
      },
      stats: {
        "/repo/.rundown/config.json": { isDirectory: false, isFile: true },
        "/repo/blueprint": { isDirectory: true, isFile: false },
        "/repo/blueprint/current": { isDirectory: true, isFile: false },
      },
    });

    const saved = saveDesignRevisionSnapshot(fileSystem, "/repo");
    expect(saved).toMatchObject({
      kind: "saved",
      revision: {
        name: "rev.0",
      },
    });
    if (saved.kind === "saved") {
      expect(normalizePath(saved.revision.absolutePath)).toBe("/repo/blueprint/rev.0");
      expect(normalizePath(saved.revision.sourcePath)).toBe("/repo/blueprint/current");
    }

    const missingCurrent = new InMemoryFileSystem({
      directories: {
        "/repo/blueprint": [],
      },
      files: {
        "/repo/.rundown/config.json": JSON.stringify({
          workspace: {
            directories: {
              design: "blueprint",
            },
          },
        }),
      },
      stats: {
        "/repo/.rundown/config.json": { isDirectory: false, isFile: true },
        "/repo/blueprint": { isDirectory: true, isFile: false },
      },
    });

    expect(() => saveDesignRevisionSnapshot(missingCurrent, "/repo")).toThrow(
      /Design working directory is missing: .*blueprint[\\/]current\. Create blueprint\/current\/ first \(or run `rundown start \.\.\.`\)\./,
    );
  });

  it("derives revision metadata from sidecars for revision-to-revision diffs", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "rev.2", isDirectory: true, isFile: false },
          { name: "rev.4", isDirectory: true, isFile: false },
        ],
        "/repo/docs/rev.2": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.4": [{ name: "Design.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/docs/rev.2/Design.md": "two\n",
        "/repo/docs/rev.4/Design.md": "four\n",
        "/repo/docs/rev.2.meta.json": JSON.stringify({
          revision: "rev.2",
          index: 2,
          createdAt: "2026-01-02T03:04:05.000Z",
          label: "baseline",
        }),
        "/repo/docs/rev.4.meta.json": JSON.stringify({
          revision: "rev.4",
          index: 4,
          createdAt: "2026-01-03T04:05:06.000Z",
          label: "candidate",
        }),
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/rev.2": { isDirectory: true, isFile: false },
        "/repo/docs/rev.4": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo", { target: "rev.4" });

    expect(diff.hasComparison).toBe(true);
    expect(diff.fromRevision).toMatchObject({
      name: "rev.2",
      metadata: {
        createdAt: "2026-01-02T03:04:05.000Z",
        label: "baseline",
      },
      metadataPath: expect.stringMatching(/(?:\\|\/)repo(?:\\|\/)docs(?:\\|\/)rev\.2\.meta\.json$/),
    });
    expect(diff.toTarget).toMatchObject({
      kind: "revision",
      name: "rev.4",
      absolutePath: expect.stringMatching(/(?:\\|\/)repo(?:\\|\/)docs(?:\\|\/)rev\.4$/),
      metadata: {
        createdAt: "2026-01-03T04:05:06.000Z",
        label: "candidate",
      },
      metadataPath: expect.stringMatching(/(?:\\|\/)repo(?:\\|\/)docs(?:\\|\/)rev\.4\.meta\.json$/),
    });
    expect(diff.summary).toBe("Compared rev.2 -> rev.4: 0 added 1 modified 0 removed");
  });

  it("uses legacy docs revisions for diff when canonical design/current is unavailable", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [],
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [
          { name: "Design.md", isDirectory: false, isFile: true },
        ],
        "/repo/docs/rev.1": [
          { name: "Design.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/current/Design.md": "new\n",
        "/repo/docs/rev.1/Design.md": "old\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
        "/repo/docs/rev.1": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo");

    expect(normalizePath(diff.fromRevision?.absolutePath ?? "")).toBe("/repo/docs/rev.1");
    expect(normalizePath(diff.toTarget.absolutePath)).toBe("/repo/docs/current");
    expect(diff.summary).toBe("Compared rev.1 -> current: 0 added 1 modified 0 removed");
  });

  it("treats explicit rev.0 target as migration from nothing when rev.0 is first", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "rev.0", isDirectory: true, isFile: false },
        ],
        "/repo/docs/rev.0": [
          { name: "Design.md", isDirectory: false, isFile: true },
          { name: "notes.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/rev.0/Design.md": "zero\n",
        "/repo/docs/rev.0/notes.md": "note\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/rev.0": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo", { target: "rev.0" });

    expect(diff.hasComparison).toBe(true);
    expect(diff.fromRevision).toBeNull();
    expect(diff.summary).toBe("Compared nothing -> rev.0: 2 added 0 modified 0 removed");
    expect(diff.sourceReferences.map(normalizePath)).toEqual(["/repo/docs/rev.0"]);
    expect(diff.changes.map((change) => ({
      ...change,
      toPath: normalizePath(change.toPath),
    }))).toEqual([
      {
        relativePath: "Design.md",
        kind: "added",
        fromPath: "",
        toPath: "/repo/docs/rev.0/Design.md",
      },
      {
        relativePath: "notes.md",
        kind: "added",
        fromPath: "",
        toPath: "/repo/docs/rev.0/notes.md",
      },
    ]);
  });

  it("treats explicit rev.1 target as migration from nothing when rev.1 is first", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "rev.1", isDirectory: true, isFile: false },
        ],
        "/repo/docs/rev.1": [
          { name: "Design.md", isDirectory: false, isFile: true },
          { name: "notes.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/rev.1/Design.md": "one\n",
        "/repo/docs/rev.1/notes.md": "note\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/rev.1": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo", { target: "rev.1" });

    expect(diff.hasComparison).toBe(true);
    expect(diff.fromRevision).toBeNull();
    expect(diff.summary).toBe("Compared nothing -> rev.1: 2 added 0 modified 0 removed");
    expect(diff.sourceReferences.map(normalizePath)).toEqual(["/repo/docs/rev.1"]);
    expect(diff.changes.map((change) => ({
      ...change,
      toPath: normalizePath(change.toPath),
    }))).toEqual([
      {
        relativePath: "Design.md",
        kind: "added",
        fromPath: "",
        toPath: "/repo/docs/rev.1/Design.md",
      },
      {
        relativePath: "notes.md",
        kind: "added",
        fromPath: "",
        toPath: "/repo/docs/rev.1/notes.md",
      },
    ]);
  });

  it("treats rev.0 as fresh state and shows rev.1 as initial when rev.0 and rev.1 are present and rev.1 is targeted", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "rev.0", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
        ],
        "/repo/docs/rev.0": [
          { name: "Design.md", isDirectory: false, isFile: true },
        ],
        "/repo/docs/rev.1": [
          { name: "Design.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/rev.0/Design.md": "zero\n",
        "/repo/docs/rev.1/Design.md": "one\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/rev.0": { isDirectory: true, isFile: false },
        "/repo/docs/rev.1": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo", { target: "rev.1" });

    expect(diff.hasComparison).toBe(true);
    expect(diff.fromRevision).toBeNull();
    expect(diff.summary).toBe("Compared nothing -> rev.1: 1 added 0 modified 0 removed");
    expect(diff.sourceReferences.map(normalizePath)).toEqual([
      "/repo/docs/rev.1",
    ]);
  });

  it("ignores malformed revision entries and still picks highest valid predecessor for current", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.bad", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
          { name: "rev.10", isDirectory: true, isFile: false },
          { name: "rev.3.md", isDirectory: false, isFile: true },
        ],
        "/repo/docs/current": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.2": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.10": [{ name: "Design.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/docs/current/Design.md": "current\n",
        "/repo/docs/rev.2/Design.md": "two\n",
        "/repo/docs/rev.10/Design.md": "ten\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
        "/repo/docs/rev.bad": { isDirectory: true, isFile: false },
        "/repo/docs/rev.2": { isDirectory: true, isFile: false },
        "/repo/docs/rev.10": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo");

    expect(diff.hasComparison).toBe(true);
    expect(diff.fromRevision?.name).toBe("rev.10");
    expect(diff.summary).toBe("Compared rev.10 -> current: 0 added 1 modified 0 removed");
  });

  it("returns graceful diff-unavailable result when explicit revision target directory is missing", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.1": [{ name: "Design.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/docs/current/Design.md": "current\n",
        "/repo/docs/rev.1/Design.md": "one\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
        "/repo/docs/rev.1": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo", { target: "rev.9" });

    expect(diff.fromRevision).toBeNull();
    expect(diff.toTarget).toMatchObject({
      kind: "revision",
      name: "rev.9",
      metadata: { createdAt: "", label: "" },
      revisionIndex: 9,
    });
    expect(normalizePath(diff.toTarget.absolutePath)).toBe("/repo/docs/rev.9");
    expect(normalizePath(diff.toTarget.metadataPath)).toBe("/repo/docs/rev.9.meta.json");
    expect(diff.hasComparison).toBe(false);
    expect(diff.summary).toBe("Design diff unavailable: target directory does not exist for rev.9.");
    expect(diff.addedCount).toBe(0);
    expect(diff.removedCount).toBe(0);
    expect(diff.modifiedCount).toBe(0);
    expect(diff.changes).toEqual([]);
    expect(diff.sourceReferences.map(normalizePath)).toEqual(["/repo/docs/rev.9"]);
  });
});

describe("design-context canonical workspace resolution", () => {
  it("prefers design/current/Target.md over legacy docs/current/Design.md", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [{ name: "Target.md", isDirectory: false, isFile: true }],
        "/repo/design/rev.2": [{ name: "Target.md", isDirectory: false, isFile: true }],
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.1": [{ name: "Design.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/design/current/Target.md": "canonical\n",
        "/repo/design/rev.2/Target.md": "snapshot\n",
        "/repo/docs/current/Design.md": "legacy\n",
        "/repo/docs/rev.1/Design.md": "legacy snapshot\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/design/rev.2": { isDirectory: true, isFile: false },
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
        "/repo/docs/rev.1": { isDirectory: true, isFile: false },
      },
    });

    const resolvedContext = resolveDesignContext(fileSystem, "/repo");
    expect(resolvedContext.sourcePaths.map(normalizePath)).toEqual(["/repo/design/current/Target.md"]);
    expect(resolvedContext.design).toBe("canonical");

    const sourceReferences = resolveDesignContextSourceReferences(fileSystem, "/repo");
    expect({
      sourceReferences: sourceReferences.sourceReferences.map(normalizePath),
      hasManagedDocs: sourceReferences.hasManagedDocs,
    }).toEqual({
      sourceReferences: ["/repo/design/current", "/repo/design/rev.2"],
      hasManagedDocs: true,
    });

    const revisions = discoverDesignRevisionDirectories(fileSystem, "/repo");
    expect(revisions.map((entry) => normalizePath(entry.absolutePath))).toEqual(["/repo/design/rev.2"]);
  });

  it("falls back to legacy docs/current/Design.md when canonical workspace is absent", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [{ name: "Design.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/docs/current/Design.md": "legacy only\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
      },
    });

    const resolvedContext = resolveDesignContext(fileSystem, "/repo");
    expect(resolvedContext.sourcePaths.map(normalizePath)).toEqual(["/repo/docs/current/Design.md"]);
    expect(resolvedContext.design).toBe("legacy only");
  });

  it("falls back to legacy docs/current/Design.md when canonical current exists but is empty", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [],
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [{ name: "Design.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/docs/current/Design.md": "legacy only\n",
      },
      stats: {
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
      },
    });

    const resolvedContext = resolveDesignContext(fileSystem, "/repo");
    expect(resolvedContext.sourcePaths.map(normalizePath)).toEqual(["/repo/docs/current/Design.md"]);
    expect(resolvedContext.design).toBe("legacy only");
  });
});
