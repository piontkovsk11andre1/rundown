import { describe, expect, it } from "vitest";
import {
  discoverDesignRevisionDirectories,
  prepareDesignRevisionDiffContext,
  parseDesignRevisionDirectoryName,
  resolveDesignContextSourceReferences,
  saveDesignRevisionSnapshot,
} from "../../application/design-context.ts";
import type {
  FileSystem,
  FileSystemDirent,
  FileSystemStat,
} from "../../domain/ports/file-system.ts";

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
      this.directories.set(dirPath, entries.slice());
      this.stats.set(dirPath, { isDirectory: true, isFile: false });
    }

    for (const [filePath, content] of Object.entries(seed.files ?? {})) {
      this.files.set(filePath, content);
      this.stats.set(filePath, { isDirectory: false, isFile: true });
    }

    for (const [entryPath, stat] of Object.entries(seed.stats ?? {})) {
      this.stats.set(entryPath, stat);
    }
  }

  public exists(targetPath: string): boolean {
    return this.stats.has(targetPath);
  }

  public readText(filePath: string): string {
    const value = this.files.get(filePath);
    if (value === undefined) {
      throw new Error("File not found: " + filePath);
    }

    return value;
  }

  public writeText(filePath: string, content: string): void {
    this.files.set(filePath, content);
    this.stats.set(filePath, { isDirectory: false, isFile: true });
  }

  public mkdir(dirPath: string): void {
    if (!this.directories.has(dirPath)) {
      this.directories.set(dirPath, []);
    }
    this.stats.set(dirPath, { isDirectory: true, isFile: false });
  }

  public readdir(dirPath: string): FileSystemDirent[] {
    return (this.directories.get(dirPath) ?? []).slice();
  }

  public stat(targetPath: string): FileSystemStat | null {
    return this.stats.get(targetPath) ?? null;
  }

  public unlink(filePath: string): void {
    this.files.delete(filePath);
    this.stats.delete(filePath);
  }

  public rm(targetPath: string): void {
    this.files.delete(targetPath);
    this.directories.delete(targetPath);
    this.stats.delete(targetPath);
  }
}

describe("parseDesignRevisionDirectoryName", () => {
  it("parses valid revision directory names", () => {
    expect(parseDesignRevisionDirectoryName("rev.1")).toEqual({ index: 1 });
    expect(parseDesignRevisionDirectoryName("REV.42")).toEqual({ index: 42 });
    expect(parseDesignRevisionDirectoryName(" rev.7 ")).toEqual({ index: 7 });
  });

  it("returns null for malformed revision directory names", () => {
    expect(parseDesignRevisionDirectoryName("rev.0")).toBeNull();
    expect(parseDesignRevisionDirectoryName("rev.-1")).toBeNull();
    expect(parseDesignRevisionDirectoryName("rev.1-draft")).toBeNull();
    expect(parseDesignRevisionDirectoryName("rev.one")).toBeNull();
    expect(parseDesignRevisionDirectoryName("current")).toBeNull();
  });
});

describe("discoverDesignRevisionDirectories", () => {
  it("returns deterministic ascending order and ignores malformed entries", () => {
    const projectRoot = "/repo";
    const docsDir = "/repo/docs";
    const fileSystem = new InMemoryFileSystem({
      directories: {
        [docsDir]: [
          { name: "rev.10", isDirectory: true, isFile: false },
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
          { name: "REV.2", isDirectory: true, isFile: false },
          { name: "rev.x", isDirectory: true, isFile: false },
          { name: "rev.0", isDirectory: true, isFile: false },
          { name: "rev.3.md", isDirectory: false, isFile: true },
          { name: "rev.001", isDirectory: true, isFile: false },
        ],
      },
      stats: {
        [docsDir]: { isDirectory: true, isFile: false },
      },
    });

    const revisions = discoverDesignRevisionDirectories(fileSystem, projectRoot);

    expect(revisions).toEqual([
      { index: 1, name: "rev.001", absolutePath: "/repo/docs/rev.001" },
      { index: 2, name: "REV.2", absolutePath: "/repo/docs/REV.2" },
      { index: 2, name: "rev.2", absolutePath: "/repo/docs/rev.2" },
      { index: 10, name: "rev.10", absolutePath: "/repo/docs/rev.10" },
    ]);
  });

  it("returns empty list when docs directory is missing", () => {
    const fileSystem = new InMemoryFileSystem({});
    expect(discoverDesignRevisionDirectories(fileSystem, "/repo")).toEqual([]);
  });
});

describe("saveDesignRevisionSnapshot", () => {
  it("saves docs/current into next monotonic revision directory", () => {
    const projectRoot = "/repo";
    const docsDir = "/repo/docs";
    const docsCurrentDir = "/repo/docs/current";
    const docsCurrentNestedDir = "/repo/docs/current/notes";
    const fileSystem = new InMemoryFileSystem({
      directories: {
        [docsDir]: [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.1", isDirectory: true, isFile: false },
          { name: "rev.03", isDirectory: true, isFile: false },
          { name: "rev.bad", isDirectory: true, isFile: false },
        ],
        [docsCurrentDir]: [
          { name: "Design.md", isDirectory: false, isFile: true },
          { name: "notes", isDirectory: true, isFile: false },
        ],
        [docsCurrentNestedDir]: [
          { name: "api.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/current/Design.md": "# Design\n",
        "/repo/docs/current/notes/api.md": "- endpoint\n",
      },
      stats: {
        [docsDir]: { isDirectory: true, isFile: false },
        [docsCurrentDir]: { isDirectory: true, isFile: false },
        [docsCurrentNestedDir]: { isDirectory: true, isFile: false },
        "/repo/docs/rev.1": { isDirectory: true, isFile: false },
        "/repo/docs/rev.03": { isDirectory: true, isFile: false },
        "/repo/docs/rev.bad": { isDirectory: true, isFile: false },
      },
    });

    const saved = saveDesignRevisionSnapshot(fileSystem, projectRoot);

    expect(saved).toEqual({
      kind: "saved",
      revision: {
        index: 4,
        name: "rev.4",
        absolutePath: "/repo/docs/rev.4",
        sourcePath: "/repo/docs/current",
        copiedFileCount: 2,
      },
    });
    expect(fileSystem.readText("/repo/docs/rev.4/Design.md")).toBe("# Design\n");
    expect(fileSystem.readText("/repo/docs/rev.4/notes/api.md")).toBe("- endpoint\n");
  });

  it("returns unchanged when docs/current matches latest revision", () => {
    const projectRoot = "/repo";
    const docsDir = "/repo/docs";
    const docsCurrentDir = "/repo/docs/current";
    const latestRevisionDir = "/repo/docs/rev.5";
    const fileSystem = new InMemoryFileSystem({
      directories: {
        [docsDir]: [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.5", isDirectory: true, isFile: false },
        ],
        [docsCurrentDir]: [
          { name: "Design.md", isDirectory: false, isFile: true },
          { name: "notes", isDirectory: true, isFile: false },
        ],
        ["/repo/docs/current/notes"]: [
          { name: "api.md", isDirectory: false, isFile: true },
        ],
        [latestRevisionDir]: [
          { name: "Design.md", isDirectory: false, isFile: true },
          { name: "notes", isDirectory: true, isFile: false },
        ],
        ["/repo/docs/rev.5/notes"]: [
          { name: "api.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/current/Design.md": "# Design\n",
        "/repo/docs/current/notes/api.md": "- endpoint\n",
        "/repo/docs/rev.5/Design.md": "# Design\n",
        "/repo/docs/rev.5/notes/api.md": "- endpoint\n",
      },
      stats: {
        [docsDir]: { isDirectory: true, isFile: false },
        [docsCurrentDir]: { isDirectory: true, isFile: false },
        ["/repo/docs/current/notes"]: { isDirectory: true, isFile: false },
        [latestRevisionDir]: { isDirectory: true, isFile: false },
        ["/repo/docs/rev.5/notes"]: { isDirectory: true, isFile: false },
      },
    });

    const saved = saveDesignRevisionSnapshot(fileSystem, projectRoot);

    expect(saved).toEqual({
      kind: "unchanged",
      sourcePath: "/repo/docs/current",
      latestRevision: {
        index: 5,
        name: "rev.5",
        absolutePath: "/repo/docs/rev.5",
      },
    });
    expect(fileSystem.stat("/repo/docs/rev.6")).toBeNull();
  });

  it("throws with guidance when docs/current is missing", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [],
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
      },
    });

    expect(() => saveDesignRevisionSnapshot(fileSystem, "/repo")).toThrow(
      "Design working directory is missing: /repo/docs/current. Create docs/current/ first (or run `rundown start ...`).",
    );
  });
});

describe("prepareDesignRevisionDiffContext", () => {
  it("compares latest saved revision against docs/current by default", () => {
    const projectRoot = "/repo";
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [
          { name: "Design.md", isDirectory: false, isFile: true },
          { name: "new.md", isDirectory: false, isFile: true },
        ],
        "/repo/docs/rev.2": [
          { name: "Design.md", isDirectory: false, isFile: true },
          { name: "old.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/docs/current/Design.md": "updated\n",
        "/repo/docs/current/new.md": "added\n",
        "/repo/docs/rev.2/Design.md": "original\n",
        "/repo/docs/rev.2/old.md": "removed\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
        "/repo/docs/rev.2": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, projectRoot);

    expect(diff.hasComparison).toBe(true);
    expect(diff.fromRevision?.name).toBe("rev.2");
    expect(diff.toTarget).toEqual({
      kind: "current",
      name: "current",
      absolutePath: "/repo/docs/current",
    });
    expect(diff.addedCount).toBe(1);
    expect(diff.modifiedCount).toBe(1);
    expect(diff.removedCount).toBe(1);
    expect(diff.summary).toBe("Compared rev.2 -> current: 1 added 1 modified 1 removed");
    expect(diff.sourceReferences).toEqual([
      "/repo/docs/rev.2",
      "/repo/docs/current",
    ]);
    expect(diff.changes).toEqual([
      {
        relativePath: "Design.md",
        kind: "modified",
        fromPath: "/repo/docs/rev.2/Design.md",
        toPath: "/repo/docs/current/Design.md",
      },
      {
        relativePath: "new.md",
        kind: "added",
        fromPath: "/repo/docs/rev.2",
        toPath: "/repo/docs/current/new.md",
      },
      {
        relativePath: "old.md",
        kind: "removed",
        fromPath: "/repo/docs/rev.2/old.md",
        toPath: "/repo/docs/current",
      },
    ]);
  });

  it("compares previous revision against an explicit revision target", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "rev.1", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
          { name: "rev.4", isDirectory: true, isFile: false },
        ],
        "/repo/docs/rev.1": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.2": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.4": [{ name: "Design.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/docs/rev.1/Design.md": "one\n",
        "/repo/docs/rev.2/Design.md": "two\n",
        "/repo/docs/rev.4/Design.md": "four\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/rev.1": { isDirectory: true, isFile: false },
        "/repo/docs/rev.2": { isDirectory: true, isFile: false },
        "/repo/docs/rev.4": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo", { target: "rev.4" });

    expect(diff.hasComparison).toBe(true);
    expect(diff.fromRevision?.name).toBe("rev.2");
    expect(diff.toTarget).toEqual({
      kind: "revision",
      name: "rev.4",
      absolutePath: "/repo/docs/rev.4",
    });
    expect(diff.modifiedCount).toBe(1);
    expect(diff.summary).toBe("Compared rev.2 -> rev.4: 0 added 1 modified 0 removed");
  });

  it("returns no comparison when no previous revision exists", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [],
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
      },
    });

    const diff = prepareDesignRevisionDiffContext(fileSystem, "/repo");

    expect(diff.hasComparison).toBe(false);
    expect(diff.summary).toBe("No previous design revision found; cannot compute a revision diff yet.");
    expect(diff.sourceReferences).toEqual(["/repo/docs/current"]);
    expect(diff.changes).toEqual([]);
  });
});

describe("resolveDesignContextSourceReferences", () => {
  it("prefers managed docs/current and docs/rev.* directories as context roots", () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo/docs": [
          { name: "current", isDirectory: true, isFile: false },
          { name: "rev.2", isDirectory: true, isFile: false },
          { name: "rev.7", isDirectory: true, isFile: false },
        ],
        "/repo/docs/current": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.2": [{ name: "Design.md", isDirectory: false, isFile: true }],
        "/repo/docs/rev.7": [{ name: "Design.md", isDirectory: false, isFile: true }],
      },
      files: {
        "/repo/docs/current/Design.md": "current\n",
        "/repo/docs/rev.2/Design.md": "two\n",
        "/repo/docs/rev.7/Design.md": "seven\n",
      },
      stats: {
        "/repo/docs": { isDirectory: true, isFile: false },
        "/repo/docs/current": { isDirectory: true, isFile: false },
        "/repo/docs/rev.2": { isDirectory: true, isFile: false },
        "/repo/docs/rev.7": { isDirectory: true, isFile: false },
      },
    });

    const resolution = resolveDesignContextSourceReferences(fileSystem, "/repo");

    expect(resolution).toEqual({
      sourceReferences: [
        "/repo/docs/current",
        "/repo/docs/rev.2",
        "/repo/docs/rev.7",
      ],
      hasManagedDocs: true,
    });
  });

  it("falls back to root Design.md when managed docs are unavailable", () => {
    const fileSystem = new InMemoryFileSystem({
      files: {
        "/repo/Design.md": "legacy\n",
      },
      stats: {
        "/repo/Design.md": { isDirectory: false, isFile: true },
      },
    });

    const resolution = resolveDesignContextSourceReferences(fileSystem, "/repo");

    expect(resolution).toEqual({
      sourceReferences: ["/repo/Design.md"],
      hasManagedDocs: false,
    });
  });
});
