import { describe, expect, it } from "vitest";
import {
  discoverDesignRevisionDirectories,
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

    expect(fileSystem.readText("/repo/docs/rev.1/Design.md")).toBe("original design\n");
    expect(fileSystem.readText("/repo/docs/rev.1/notes/api.md")).toBe("v1\n");
    expect(JSON.parse(fileSystem.readText("/repo/docs/rev.1.meta.json"))).toEqual({
      revision: "rev.1",
      index: 1,
      createdAt: "2026-01-02T03:04:05.000Z",
    });
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
