import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_DIRECTORIES,
  DEFAULT_WORKSPACE_PLACEMENT,
  resolveWorkspaceDirectories,
  resolveWorkspacePath,
  resolveWorkspacePaths,
  resolveWorkspacePlacement,
} from "../../src/application/workspace-paths.js";
import type { FileSystem } from "../../src/domain/ports/index.js";

class InMemoryFileSystem implements FileSystem {
  private readonly files = new Map<string, string>();

  public constructor(initialFiles: Record<string, string>) {
    for (const [filePath, content] of Object.entries(initialFiles)) {
      this.files.set(filePath, content);
    }
  }

  public exists(targetPath: string): boolean {
    return this.files.has(targetPath);
  }

  public readText(filePath: string): string {
    const content = this.files.get(filePath);
    if (content === undefined) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return content;
  }

  public writeText(filePath: string, content: string): void {
    this.files.set(filePath, content);
  }

  public mkdir(_dirPath: string, _options?: { recursive?: boolean }): void {
    throw new Error("not implemented");
  }

  public readdir(_dirPath: string): never[] {
    return [];
  }

  public stat(_path: string): null {
    return null;
  }

  public unlink(filePath: string): void {
    this.files.delete(filePath);
  }

  public rm(_path: string, _options?: { recursive?: boolean; force?: boolean }): void {
    return;
  }
}

describe("prediction workspace config", () => {
  it("preserves backward-compatible sourcedir placement when only directories are configured", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo", "invocation");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "design-docs",
            specs: "quality/specs",
            migrations: "changesets",
            prediction: "predictions-tree",
          },
        },
      }),
    });

    expect(resolveWorkspacePlacement({ fileSystem, workspaceRoot })).toEqual({
      design: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design-docs"),
      specs: path.join(workspaceRoot, "quality", "specs"),
      migrations: path.join(workspaceRoot, "changesets"),
      prediction: path.join(workspaceRoot, "predictions-tree"),
    });
  });

  it("uses sourcedir placement defaults when project config is missing", () => {
    const fileSystem = new InMemoryFileSystem({});
    const workspaceRoot = path.join(path.sep, "repo");

    expect(DEFAULT_WORKSPACE_DIRECTORIES).toEqual({
      design: "design",
      specs: "specs",
      migrations: "migrations",
      prediction: "prediction",
    });
    expect(DEFAULT_WORKSPACE_PLACEMENT).toEqual({
      design: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });

    expect(resolveWorkspaceDirectories({ fileSystem, workspaceRoot })).toEqual({
      design: "design",
      specs: "specs",
      migrations: "migrations",
      prediction: "prediction",
    });
    expect(resolveWorkspacePlacement({ fileSystem, workspaceRoot })).toEqual({
      design: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
  });

  it("falls back to sourcedir placement for buckets not configured", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          placement: {
            design: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePlacement({ fileSystem, workspaceRoot })).toEqual({
      design: "workdir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
  });

  it("rejects non-string workspace placement values", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          placement: {
            design: true,
          },
        },
      }),
    });

    expect(() => resolveWorkspacePlacement({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: "workspace.placement.design" must be a string.`,
    );
  });

  it("rejects invalid workspace placement enum values", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          placement: {
            design: "workspace",
          },
        },
      }),
    });

    expect(() => resolveWorkspacePlacement({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: "workspace.placement.design" must be "sourcedir" or "workdir".`,
    );
  });

  it("derives bucket paths from workspace root for sourcedir placement", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo", "work");
    const fileSystem = new InMemoryFileSystem({});

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design"),
      specs: path.join(workspaceRoot, "specs"),
      migrations: path.join(workspaceRoot, "migrations"),
      prediction: path.join(workspaceRoot, "prediction"),
    });
  });

  it("derives per-bucket paths from mixed placement roots", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo", "work");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "docs",
            specs: "checks/specs",
            migrations: "history",
            prediction: "predicted",
          },
          placement: {
            design: "sourcedir",
            specs: "workdir",
            migrations: "workdir",
            prediction: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "docs"),
      specs: path.join(invocationRoot, "checks", "specs"),
      migrations: path.join(invocationRoot, "history"),
      prediction: path.join(invocationRoot, "predicted"),
    });
  });

  it("uses invocation/workspace divergence deterministically in linked-style placement", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source-workspace");
    const invocationRoot = path.join(path.sep, "repo", "linked-invocation");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "design",
            specs: "quality/specs",
            migrations: "changesets",
            prediction: "predicted",
          },
          placement: {
            design: "sourcedir",
            specs: "workdir",
            migrations: "workdir",
            prediction: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design"),
      specs: path.join(invocationRoot, "quality", "specs"),
      migrations: path.join(invocationRoot, "changesets"),
      prediction: path.join(invocationRoot, "predicted"),
    });
  });

  it("resolves single bucket path with placement when no override is provided", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo", "work");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          placement: {
            specs: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePath({
      fileSystem,
      workspaceRoot,
      invocationRoot,
      bucket: "specs",
    })).toBe(path.join(invocationRoot, "specs"));
  });

  it("rejects bucket directories that escape selected workdir placement root", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo", "work");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({});

    expect(() =>
      resolveWorkspacePaths({
        fileSystem,
        workspaceRoot,
        invocationRoot,
        directories: {
          design: "../outside",
          specs: "specs",
          migrations: "migrations",
          prediction: "prediction",
        },
        placement: {
          design: "workdir",
          specs: "sourcedir",
          migrations: "sourcedir",
          prediction: "sourcedir",
        },
      }),
    ).toThrow(`Invalid project config at ${configPath}: "workspace.directories.design" escapes the project root.`);
  });

  it("rejects collisions when mixed placement roots resolve to same absolute path", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "source/design",
            specs: "design",
            migrations: "migrations",
            prediction: "prediction",
          },
          placement: {
            design: "workdir",
            specs: "sourcedir",
            migrations: "sourcedir",
            prediction: "sourcedir",
          },
        },
      }),
    });

    expect(() => resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toThrow(
      `Invalid project config at ${configPath}: workspace directories "design" and "specs" both resolve to "${path.join(workspaceRoot, "design")}".`,
    );
  });

  it("rejects overlaps when mixed placement roots resolve to nested absolute paths", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "source/design/current",
            specs: "design",
            migrations: "migrations",
            prediction: "prediction",
          },
          placement: {
            design: "workdir",
            specs: "sourcedir",
            migrations: "sourcedir",
            prediction: "sourcedir",
          },
        },
      }),
    });

    expect(() => resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toThrow(
      `Invalid project config at ${configPath}: workspace directories "design" ("${path.join(workspaceRoot, "design", "current")}") and "specs" ("${path.join(workspaceRoot, "design")}") overlap.`,
    );
  });
});
