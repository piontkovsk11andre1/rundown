import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveManifestFilePath,
  findArchiveManifestEntry,
  readArchiveManifest,
  upsertArchiveManifestEntries,
  writeArchiveManifest,
  type ArchiveManifest,
} from "../../src/application/archive-manifest.js";
import type {
  FileSystem,
  FileSystemDirent,
  FileSystemStat,
} from "../../src/domain/ports/file-system.js";

class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  private readonly directories = new Set<string>();

  public constructor(initialFiles: Record<string, string> = {}) {
    for (const [filePath, content] of Object.entries(initialFiles)) {
      const normalizedPath = normalizePath(filePath);
      this.files.set(normalizedPath, content);
      this.addParentDirectories(normalizedPath);
    }
  }

  public exists(targetPath: string): boolean {
    const normalizedPath = normalizePath(targetPath);
    return this.files.has(normalizedPath) || this.directories.has(normalizedPath);
  }

  public readText(filePath: string): string {
    const normalizedPath = normalizePath(filePath);
    const value = this.files.get(normalizedPath);
    if (value === undefined) {
      throw new Error("ENOENT: " + normalizedPath);
    }

    return value;
  }

  public writeText(filePath: string, content: string): void {
    const normalizedPath = normalizePath(filePath);
    this.files.set(normalizedPath, content);
    this.addParentDirectories(normalizedPath);
  }

  public mkdir(dirPath: string, options?: { recursive?: boolean }): void {
    const normalizedPath = normalizePath(dirPath);
    this.directories.add(normalizedPath);
    if (options?.recursive) {
      this.addParentDirectories(normalizedPath);
    }
  }

  public readdir(_dirPath: string): FileSystemDirent[] {
    return [];
  }

  public stat(targetPath: string): FileSystemStat | null {
    const normalizedPath = normalizePath(targetPath);
    if (this.files.has(normalizedPath)) {
      return { isFile: true, isDirectory: false };
    }
    if (this.directories.has(normalizedPath)) {
      return { isFile: false, isDirectory: true };
    }

    return null;
  }

  public unlink(filePath: string): void {
    this.files.delete(normalizePath(filePath));
  }

  public rm(targetPath: string): void {
    const normalizedPath = normalizePath(targetPath);
    this.files.delete(normalizedPath);
    this.directories.delete(normalizedPath);
  }

  public rename(fromPath: string, toPath: string): void {
    const normalizedFromPath = normalizePath(fromPath);
    const normalizedToPath = normalizePath(toPath);
    const content = this.files.get(normalizedFromPath);
    if (content === undefined) {
      throw new Error("ENOENT: " + normalizedFromPath);
    }

    this.files.delete(normalizedFromPath);
    this.files.set(normalizedToPath, content);
    this.addParentDirectories(normalizedToPath);
  }

  private addParentDirectories(targetPath: string): void {
    const parentPath = path.posix.dirname(targetPath);
    if (parentPath === targetPath || parentPath === ".") {
      return;
    }

    this.directories.add(parentPath);
    this.addParentDirectories(parentPath);
  }
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

describe("archive manifest", () => {
  it("returns an empty manifest when archive index is missing", () => {
    const fileSystem = new InMemoryFileSystem();

    const manifest = readArchiveManifest(fileSystem, "/repo");

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.entries).toEqual([]);
    expect(Number.isFinite(Date.parse(manifest.updatedAt))).toBe(true);
  });

  it("writes and re-reads normalized archive entries under .rundown", () => {
    const fileSystem = new InMemoryFileSystem();
    const workspaceRoot = "/repo";
    const written = writeArchiveManifest(fileSystem, workspaceRoot, {
      schemaVersion: 999,
      updatedAt: "invalid",
      entries: [
        {
          kind: "revision-payload",
          originalLogicalPath: "design/revisions/rev.1",
          archiveLogicalPath: "design/archive/revisions/rev.1",
          archivedAt: "2026-05-01T12:00:00.000Z",
        },
        {
          kind: "migration-thread-review",
          originalLogicalPath: " migrations/threads/backend/2. Add.md ",
          archiveLogicalPath: "migrations/archive/threads/backend/2. Add.md",
          archivedAt: "not-an-iso",
          lane: "thread",
          threadSlug: " backend ",
        },
      ],
    } as ArchiveManifest);

    expect(written.schemaVersion).toBe(1);
    expect(written.entries).toHaveLength(2);
    expect(written.entries.find((entry) => entry.kind === "migration-thread-review")).toMatchObject({
      kind: "migration-thread-review",
      lane: "thread",
      threadSlug: "backend",
    });

    const manifestPath = archiveManifestFilePath(workspaceRoot);
    expect(manifestPath).toBe(path.join(workspaceRoot, ".rundown", "archive-index.json"));
    expect(fileSystem.exists(manifestPath)).toBe(true);

    const reloaded = readArchiveManifest(fileSystem, workspaceRoot);
    expect(reloaded).toEqual(written);
  });

  it("upserts entries by logical identity and keeps deterministic ordering", () => {
    const fileSystem = new InMemoryFileSystem();
    const workspaceRoot = "/repo";

    const first = upsertArchiveManifestEntries(fileSystem, workspaceRoot, [
      {
        kind: "migration-primary",
        originalLogicalPath: "migrations/2. Add.md",
        archiveLogicalPath: "migrations/archive/root/2. Add.md",
        archivedAt: "2026-05-01T00:00:00.000Z",
        lane: "root",
      },
      {
        kind: "revision-payload",
        originalLogicalPath: "design/revisions/rev.1",
        archiveLogicalPath: "design/archive/revisions/rev.1",
        archivedAt: "2026-05-01T00:00:00.000Z",
      },
    ]);

    expect(first.entries.map((entry) => entry.kind)).toEqual([
      "migration-primary",
      "revision-payload",
    ]);

    const second = upsertArchiveManifestEntries(fileSystem, workspaceRoot, [
      {
        kind: "migration-primary",
        originalLogicalPath: "migrations/2. Add.md",
        archiveLogicalPath: "migrations/archive/root/2. Add (moved).md",
        archivedAt: "2026-05-02T00:00:00.000Z",
        lane: "root",
      },
      {
        kind: "migration-thread-primary",
        originalLogicalPath: "migrations/threads/api/3. Expand.md",
        archiveLogicalPath: "migrations/archive/threads/api/3. Expand.md",
        archivedAt: "2026-05-03T00:00:00.000Z",
        lane: "thread",
        threadSlug: "api",
      },
    ]);

    expect(second.entries).toHaveLength(3);
    const updatedRootEntry = second.entries.find((entry) => entry.kind === "migration-primary");
    expect(updatedRootEntry?.archiveLogicalPath).toBe("migrations/archive/root/2. Add (moved).md");
    expect(second.entries.map((entry) => entry.kind)).toEqual([
      "migration-primary",
      "migration-thread-primary",
      "revision-payload",
    ]);
  });

  it("finds entries by deterministic identity fields", () => {
    const manifest: ArchiveManifest = {
      schemaVersion: 1,
      updatedAt: "2026-05-01T00:00:00.000Z",
      entries: [
        {
          kind: "revision-payload",
          originalLogicalPath: "design/revisions/rev.7",
          archiveLogicalPath: "design/archive/revisions/rev.7",
          archivedAt: "2026-05-01T00:00:00.000Z",
        },
        {
          kind: "migration-thread-review",
          originalLogicalPath: "migrations/threads/ux/5. Polish.review.md",
          archiveLogicalPath: "migrations/archive/threads/ux/5. Polish.review.md",
          archivedAt: "2026-05-02T00:00:00.000Z",
          lane: "thread",
          threadSlug: "ux",
        },
      ],
    };

    const revisionMatch = findArchiveManifestEntry(manifest, {
      kind: "revision-payload",
      originalLogicalPath: "design/revisions/rev.7",
    });
    const threadMatch = findArchiveManifestEntry(manifest, {
      kind: "migration-thread-review",
      originalLogicalPath: "migrations/threads/ux/5. Polish.review.md",
      lane: "thread",
      threadSlug: "ux",
    });
    const missing = findArchiveManifestEntry(manifest, {
      kind: "migration-thread-review",
      originalLogicalPath: "migrations/threads/ux/5. Polish.review.md",
      lane: "root",
    });

    expect(revisionMatch?.archiveLogicalPath).toBe("design/archive/revisions/rev.7");
    expect(threadMatch?.archiveLogicalPath).toBe("migrations/archive/threads/ux/5. Polish.review.md");
    expect(missing).toBeNull();
  });
});
