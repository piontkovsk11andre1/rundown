import { describe, expect, it, vi } from "vitest";
import { createDocsTask } from "../../src/application/docs-task.js";
import { WORKSPACE_LINK_SCHEMA_VERSION } from "../../src/domain/workspace-link.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";
import type {
  FileSystem,
  FileSystemDirent,
  FileSystemStat,
} from "../../src/domain/ports/file-system.js";

class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  private readonly stats = new Map<string, FileSystemStat>();

  public constructor(seed: {
    directories?: Record<string, FileSystemDirent[]>;
    files?: Record<string, string>;
    stats?: Record<string, FileSystemStat>;
  }) {
    for (const [dirPath, entries] of Object.entries(seed.directories ?? {})) {
      const normalizedDirPath = normalizePath(dirPath);
      void entries;
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
    this.stats.set(normalizedDirPath, { isDirectory: true, isFile: false });
  }

  public readdir(dirPath: string): FileSystemDirent[] {
    const normalizedDirPath = normalizePath(dirPath);
    const dirStat = this.stats.get(normalizedDirPath);
    if (!dirStat?.isDirectory) {
      return [];
    }

    const entries: FileSystemDirent[] = [];
    for (const [entryPath, stat] of this.stats.entries()) {
      if (entryPath === normalizedDirPath) {
        continue;
      }
      if (parentPath(entryPath) !== normalizedDirPath) {
        continue;
      }
      entries.push({
        name: baseName(entryPath),
        isDirectory: stat.isDirectory,
        isFile: stat.isFile,
      });
    }

    return entries.sort((left, right) => left.name.localeCompare(right.name));
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
    const keys = [...this.stats.keys()]
      .filter((candidate) => candidate === normalizedTargetPath || candidate.startsWith(normalizedTargetPath + "/"));
    for (const key of keys) {
      this.files.delete(key);
      this.stats.delete(key);
    }
  }
}

describe("createDocsTask", () => {
  it("publishes design/current snapshot and keeps no-change no-op behavior", async () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo": [
          { name: "design", isDirectory: true, isFile: false },
          { name: "migrations", isDirectory: true, isFile: false },
        ],
        "/repo/design": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
        "/repo/migrations": [
          { name: "0001-init.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/design/current/Target.md": "# Design\n\ninitial\n",
        "/repo/migrations/0001-init.md": "# init\n",
      },
      stats: {
        "/repo": { isDirectory: true, isFile: false },
        "/repo/design": { isDirectory: true, isFile: false },
        "/repo/design/current": { isDirectory: true, isFile: false },
        "/repo/migrations": { isDirectory: true, isFile: false },
      },
    });
    const outputEvents: ApplicationOutputEvent[] = [];

    const docsTask = createDocsTask({
      fileSystem,
      output: {
        emit: (event) => {
          outputEvents.push(event);
        },
      },
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    try {
      const firstCode = await docsTask({ action: "publish", dir: "migrations", label: "Baseline" });

      expect(firstCode).toBe(0);
      expect(fileSystem.exists("/repo/design/rev.1")).toBe(true);
      expect(fileSystem.exists("/repo/design/rev.1/Target.md")).toBe(true);
      expect(fileSystem.readText("/repo/design/rev.1.meta.json")).toContain("\"label\": \"Baseline\"");
      expect(outputEvents.some((event) => event.kind === "success" && event.message.includes("Saved design revision rev.1"))).toBe(true);

      outputEvents.length = 0;

      const secondCode = await docsTask({ action: "publish", dir: "migrations", label: "Baseline" });

      expect(secondCode).toBe(0);
      expect(fileSystem.exists("/repo/design/rev.2")).toBe(false);
      expect(outputEvents.some(
        (event) => event.kind === "info"
          && event.message.includes("No design changes detected in")
          && event.message.includes("design/current"),
      )).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("bootstraps canonical design/current/Target.md from legacy root Design.md", async () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/repo": [
          { name: "migrations", isDirectory: true, isFile: false },
        ],
        "/repo/migrations": [
          { name: "0001-init.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/repo/Design.md": "legacy\n",
        "/repo/migrations/0001-init.md": "# init\n",
      },
      stats: {
        "/repo": { isDirectory: true, isFile: false },
        "/repo/Design.md": { isDirectory: false, isFile: true },
        "/repo/migrations": { isDirectory: true, isFile: false },
      },
    });
    const outputEvents: ApplicationOutputEvent[] = [];

    const docsTask = createDocsTask({
      fileSystem,
      output: {
        emit: (event) => {
          outputEvents.push(event);
        },
      },
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/repo");
    try {
      const code = await docsTask({ action: "diff", dir: "migrations", target: "preview" });

      expect(code).toBe(0);
      expect(fileSystem.readText("/repo/design/current/Target.md")).toBe("legacy\n");
      expect(outputEvents.some((event) => event.kind === "info" && event.message.includes("Bootstrapped design/current/Target.md from legacy Design.md"))).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("requires --workspace when workspace.link has multiple records without a default", async () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/linked": [
          { name: ".rundown", isDirectory: true, isFile: false },
        ],
        "/linked/.rundown": [
          { name: "workspace.link", isDirectory: false, isFile: true },
        ],
        "/repo-a": [
          { name: "migrations", isDirectory: true, isFile: false },
          { name: "design", isDirectory: true, isFile: false },
        ],
        "/repo-a/migrations": [],
        "/repo-a/design": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo-a/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
        "/repo-b": [
          { name: "migrations", isDirectory: true, isFile: false },
          { name: "design", isDirectory: true, isFile: false },
        ],
        "/repo-b/migrations": [],
        "/repo-b/design": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo-b/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/linked/.rundown/workspace.link": JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "workspace-a", workspacePath: "../repo-a" },
            { id: "workspace-b", workspacePath: "../repo-b" },
          ],
        }),
        "/repo-a/design/current/Target.md": "# A\n",
        "/repo-b/design/current/Target.md": "# B\n",
      },
      stats: {
        "/linked": { isDirectory: true, isFile: false },
        "/linked/.rundown": { isDirectory: true, isFile: false },
        "/linked/.rundown/workspace.link": { isDirectory: false, isFile: true },
        "/repo-a": { isDirectory: true, isFile: false },
        "/repo-a/migrations": { isDirectory: true, isFile: false },
        "/repo-a/design": { isDirectory: true, isFile: false },
        "/repo-a/design/current": { isDirectory: true, isFile: false },
        "/repo-a/design/current/Target.md": { isDirectory: false, isFile: true },
        "/repo-b": { isDirectory: true, isFile: false },
        "/repo-b/migrations": { isDirectory: true, isFile: false },
        "/repo-b/design": { isDirectory: true, isFile: false },
        "/repo-b/design/current": { isDirectory: true, isFile: false },
        "/repo-b/design/current/Target.md": { isDirectory: false, isFile: true },
      },
    });
    const outputEvents: ApplicationOutputEvent[] = [];

    const docsTask = createDocsTask({
      fileSystem,
      output: {
        emit: (event) => {
          outputEvents.push(event);
        },
      },
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/linked");
    try {
      const code = await docsTask({ action: "diff", dir: "migrations", target: "current" });

      expect(code).toBe(1);
      expect(outputEvents.some(
        (event) => event.kind === "error"
          && event.message.includes("Workspace selection is ambiguous")
          && event.message.includes("--workspace <dir>"),
      )).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("resolves workspace from --workspace when workspace.link selection is ambiguous", async () => {
    const fileSystem = new InMemoryFileSystem({
      directories: {
        "/linked": [
          { name: ".rundown", isDirectory: true, isFile: false },
        ],
        "/linked/.rundown": [
          { name: "workspace.link", isDirectory: false, isFile: true },
        ],
        "/repo-a": [
          { name: "migrations", isDirectory: true, isFile: false },
          { name: "design", isDirectory: true, isFile: false },
        ],
        "/repo-a/migrations": [],
        "/repo-a/design": [
          { name: "current", isDirectory: true, isFile: false },
        ],
        "/repo-a/design/current": [
          { name: "Target.md", isDirectory: false, isFile: true },
        ],
      },
      files: {
        "/linked/.rundown/workspace.link": JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "workspace-a", workspacePath: "../repo-a" },
            { id: "workspace-b", workspacePath: "../repo-b" },
          ],
        }),
        "/repo-a/design/current/Target.md": "# A\n",
      },
      stats: {
        "/linked": { isDirectory: true, isFile: false },
        "/linked/.rundown": { isDirectory: true, isFile: false },
        "/linked/.rundown/workspace.link": { isDirectory: false, isFile: true },
        "/repo-a": { isDirectory: true, isFile: false },
        "/repo-a/migrations": { isDirectory: true, isFile: false },
        "/repo-a/design": { isDirectory: true, isFile: false },
        "/repo-a/design/current": { isDirectory: true, isFile: false },
        "/repo-a/design/current/Target.md": { isDirectory: false, isFile: true },
      },
    });
    const outputEvents: ApplicationOutputEvent[] = [];

    const docsTask = createDocsTask({
      fileSystem,
      output: {
        emit: (event) => {
          outputEvents.push(event);
        },
      },
    });

    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/linked");
    try {
      const code = await docsTask({
        action: "diff",
        dir: "migrations",
        target: "current",
        workspace: "../repo-a",
      });

      expect(code).toBe(0);
      expect(outputEvents.some((event) => event.kind === "info" && event.message.includes("Design revision diff"))).toBe(true);
    } finally {
      cwdSpy.mockRestore();
    }
  });
});

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized === "/") {
    return normalized;
  }
  return normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
}

function parentPath(value: string): string {
  const normalized = normalizePath(value);
  if (normalized === "/") {
    return "/";
  }
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "/";
  }
  return normalized.slice(0, lastSlash);
}

function baseName(value: string): string {
  const normalized = normalizePath(value);
  if (normalized === "/") {
    return "/";
  }
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash < 0
    ? normalized
    : normalized.slice(lastSlash + 1);
}
