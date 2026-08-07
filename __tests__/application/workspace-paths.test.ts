import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveImplementationRootSnapshotPath,
  resolveImplementationSnapshotWorkspacePaths,
  resolveImplementationThreadSnapshotPath,
  resolveArchiveWorkspacePaths,
  resolvePredictionThreadSnapshotsPath,
  resolvePredictionWorkspacePaths,
  resolveMigrationThreadArchivePath,
  DEFAULT_WORKSPACE_DIRECTORIES,
  DEFAULT_WORKSPACE_PLACEMENT,
  normalizeWorkspaceLogicalPath,
  resolveWorkspaceMountPath,
  resolveWorkspaceMounts,
  resolveWorkspaceDirectories,
  resolveWorkspacePath,
  resolveWorkspacePaths,
  resolveWorkspacePlacement,
  validateWorkspaceBucketRootDirectory,
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
            implementation: "implementation-src",
            specs: "quality/specs",
            migrations: "changesets",
            prediction: "predictions-tree",
          },
        },
      }),
    });

    expect(resolveWorkspacePlacement({ fileSystem, workspaceRoot })).toEqual({
      design: "sourcedir",
      implementation: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design-docs"),
      implementation: path.join(workspaceRoot, "implementation-src"),
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
      implementation: "implementation",
      specs: "specs",
      migrations: "migrations",
      prediction: "prediction",
    });
    expect(DEFAULT_WORKSPACE_PLACEMENT).toEqual({
      design: "sourcedir",
      implementation: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });

    expect(resolveWorkspaceDirectories({ fileSystem, workspaceRoot })).toEqual({
      design: "design",
      implementation: "implementation",
      specs: "specs",
      migrations: "migrations",
      prediction: "prediction",
    });
    expect(resolveWorkspacePlacement({ fileSystem, workspaceRoot })).toEqual({
      design: "sourcedir",
      implementation: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
    expect(resolveWorkspaceMounts({ fileSystem, workspaceRoot })).toEqual({
      design: {
        logicalPath: "design",
        absoluteTargetPath: path.resolve(workspaceRoot, "design"),
        source: "legacy",
      },
      implementation: {
        logicalPath: "implementation",
        absoluteTargetPath: path.resolve(workspaceRoot, "implementation"),
        source: "legacy",
      },
      specs: {
        logicalPath: "specs",
        absoluteTargetPath: path.resolve(workspaceRoot, "specs"),
        source: "legacy",
      },
      migrations: {
        logicalPath: "migrations",
        absoluteTargetPath: path.resolve(workspaceRoot, "migrations"),
        source: "legacy",
      },
      prediction: {
        logicalPath: "prediction",
        absoluteTargetPath: path.resolve(workspaceRoot, "prediction"),
        source: "legacy",
      },
    });
  });

  it("normalizes explicit workspace mounts with absolute targets", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            "implementation/generated": "../shared/generated",
            "design/current": "/notes/current",
          },
        },
      }),
    });

    const mounts = resolveWorkspaceMounts({ fileSystem, workspaceRoot });
    expect(mounts["implementation/generated"]).toEqual({
      logicalPath: "implementation/generated",
      absoluteTargetPath: path.resolve(workspaceRoot, "../shared/generated"),
      source: "explicit",
    });
    expect(mounts["design/current"]).toEqual({
      logicalPath: "design/current",
      absoluteTargetPath: path.normalize("/notes/current"),
      source: "explicit",
    });
  });

  it("supports bare workspace layouts with all buckets mounted externally", () => {
    const workspaceRoot = path.join(path.sep, "repo", "rundown-only");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            design: "../docs/design",
            implementation: "../app/src",
            specs: "../app/specs",
            migrations: "../ops/migrations",
            prediction: "../ops/prediction",
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot })).toEqual({
      design: path.resolve(workspaceRoot, "../docs/design"),
      implementation: path.resolve(workspaceRoot, "../app/src"),
      specs: path.resolve(workspaceRoot, "../app/specs"),
      migrations: path.resolve(workspaceRoot, "../ops/migrations"),
      prediction: path.resolve(workspaceRoot, "../ops/prediction"),
    });
  });

  it("normalizes logical paths for mount lookups", () => {
    expect(normalizeWorkspaceLogicalPath(" implementation\\generated\\schema.ts ")).toBe(
      "implementation/generated/schema.ts",
    );
  });

  it("rejects invalid logical paths for mount lookups", () => {
    expect(() => normalizeWorkspaceLogicalPath("   ")).toThrow("Logical path cannot be empty.");
    expect(() => normalizeWorkspaceLogicalPath("/implementation")).toThrow(
      "Logical path must be a normalized rundown logical path.",
    );
  });

  it("resolves logical paths by deterministic longest-prefix mount matching", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            implementation: "../app",
            "implementation/generated": "../shared/generated",
          },
        },
      }),
    });

    const mounts = resolveWorkspaceMounts({ fileSystem, workspaceRoot });
    expect(resolveWorkspaceMountPath({ mounts, logicalPath: "implementation/foo.ts" })).toEqual({
      logicalPath: "implementation/foo.ts",
      absolutePath: path.resolve(workspaceRoot, "../app", "foo.ts"),
      mount: mounts.implementation,
      mountRelativePath: "foo.ts",
    });
    expect(
      resolveWorkspaceMountPath({ mounts, logicalPath: "implementation/generated/schema.ts" }),
    ).toEqual({
      logicalPath: "implementation/generated/schema.ts",
      absolutePath: path.resolve(workspaceRoot, "../shared/generated", "schema.ts"),
      mount: mounts["implementation/generated"],
      mountRelativePath: "schema.ts",
    });
  });

  it("allows nested mount overrides for design/current under design", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            design: "../design-root",
            "design/current": "../drafts/current-design",
          },
        },
      }),
    });

    const mounts = resolveWorkspaceMounts({ fileSystem, workspaceRoot });
    expect(resolveWorkspaceMountPath({ mounts, logicalPath: "design/current/Target.md" }).absolutePath).toBe(
      path.resolve(workspaceRoot, "../drafts/current-design", "Target.md"),
    );
    expect(resolveWorkspaceMountPath({ mounts, logicalPath: "design/rev.3/Target.md" }).absolutePath).toBe(
      path.resolve(workspaceRoot, "../design-root", "rev.3", "Target.md"),
    );
  });

  it("supports attaching invocation directory as implementation mount target", () => {
    const workspaceRoot = path.join(path.sep, "repo", "workspace");
    const invocationRoot = path.join(path.sep, "repo", "invocation");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            implementation: invocationRoot,
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design"),
      implementation: invocationRoot,
      specs: path.join(workspaceRoot, "specs"),
      migrations: path.join(workspaceRoot, "migrations"),
      prediction: path.join(workspaceRoot, "prediction"),
    });
  });

  it("supports attaching invocation directory as specs mount target", () => {
    const workspaceRoot = path.join(path.sep, "repo", "workspace");
    const invocationRoot = path.join(path.sep, "repo", "invocation");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            specs: invocationRoot,
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design"),
      implementation: path.join(workspaceRoot, "implementation"),
      specs: invocationRoot,
      migrations: path.join(workspaceRoot, "migrations"),
      prediction: path.join(workspaceRoot, "prediction"),
    });
  });

  it("supports invocation-root implementation mounts with selective external subpath overrides", () => {
    const workspaceRoot = path.join(path.sep, "repo", "workspace");
    const invocationRoot = path.join(path.sep, "repo", "invocation");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            implementation: invocationRoot,
            "implementation/migrations": "../shared/migrations",
          },
        },
      }),
    });

    const mounts = resolveWorkspaceMounts({ fileSystem, workspaceRoot, invocationRoot });
    expect(resolveWorkspaceMountPath({ mounts, logicalPath: "implementation/src/main.ts" }).absolutePath).toBe(
      path.resolve(invocationRoot, "src", "main.ts"),
    );
    expect(
      resolveWorkspaceMountPath({ mounts, logicalPath: "implementation/migrations/2026.05.04.md" }).absolutePath,
    ).toBe(path.resolve(workspaceRoot, "../shared/migrations", "2026.05.04.md"));
  });

  it("fails when no mount matches a logical path", () => {
    expect(() => resolveWorkspaceMountPath({ mounts: {}, logicalPath: "implementation/foo.ts" })).toThrow(
      'No workspace mount found for logical path "implementation/foo.ts".',
    );
  });

  it("lets explicit mounts override legacy-normalized mounts", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            implementation: "implementation-src",
          },
          mounts: {
            implementation: "../external-app",
          },
        },
      }),
    });

    expect(resolveWorkspaceMounts({ fileSystem, workspaceRoot }).implementation).toEqual({
      logicalPath: "implementation",
      absoluteTargetPath: path.resolve(workspaceRoot, "../external-app"),
      source: "explicit",
    });
  });

  it("allows intentional overlap for explicit mount targets", () => {
    const workspaceRoot = path.join(path.sep, "repo", "workspace");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            design: "../shared/workspace",
            specs: "../shared/workspace/specs",
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot })).toEqual({
      design: path.resolve(workspaceRoot, "../shared/workspace"),
      implementation: path.join(workspaceRoot, "implementation"),
      specs: path.resolve(workspaceRoot, "../shared/workspace/specs"),
      migrations: path.join(workspaceRoot, "migrations"),
      prediction: path.join(workspaceRoot, "prediction"),
    });
  });

  it("keeps legacy directory and placement behavior when explicit mounts are absent", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source-workspace");
    const invocationRoot = path.join(path.sep, "repo", "linked-invocation");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "design",
            implementation: "implementation",
            specs: "quality/specs",
            migrations: "changesets",
            prediction: "predicted",
          },
          placement: {
            design: "sourcedir",
            implementation: "sourcedir",
            specs: "workdir",
            migrations: "workdir",
            prediction: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design"),
      implementation: path.join(workspaceRoot, "implementation"),
      specs: path.join(invocationRoot, "quality", "specs"),
      migrations: path.join(invocationRoot, "changesets"),
      prediction: path.join(invocationRoot, "predicted"),
    });
  });

  it("normalizes legacy design.currentPath into a design/current mount", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const externalCurrentPath = path.join(path.sep, "repo", "design-current");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          design: {
            currentPath: externalCurrentPath,
          },
        },
      }),
    });

    expect(resolveWorkspaceMounts({ fileSystem, workspaceRoot })["design/current"]).toEqual({
      logicalPath: "design/current",
      absoluteTargetPath: path.normalize(externalCurrentPath),
      source: "legacy",
    });
  });

  it("resolves canonical archive roots from default workspace buckets", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const fileSystem = new InMemoryFileSystem({});

    expect(resolveArchiveWorkspacePaths({ fileSystem, workspaceRoot })).toEqual({
      designRevisionPayloads: path.resolve(workspaceRoot, "design", "archive", "revisions"),
      migrationRootLane: path.resolve(workspaceRoot, "migrations", "archive", "root"),
      migrationThreads: path.resolve(workspaceRoot, "migrations", "archive", "threads"),
    });
  });

  it("resolves canonical archive roots through explicit bucket mounts", () => {
    const workspaceRoot = path.join(path.sep, "repo", "workspace");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            design: "../shared/design-root",
            migrations: "../shared/migrations-root",
          },
        },
      }),
    });

    expect(resolveArchiveWorkspacePaths({ fileSystem, workspaceRoot })).toEqual({
      designRevisionPayloads: path.resolve(workspaceRoot, "../shared/design-root", "archive", "revisions"),
      migrationRootLane: path.resolve(workspaceRoot, "../shared/migrations-root", "archive", "root"),
      migrationThreads: path.resolve(workspaceRoot, "../shared/migrations-root", "archive", "threads"),
    });
  });

  it("resolves canonical migration thread archive paths with normalized slugs", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const fileSystem = new InMemoryFileSystem({});

    expect(resolveMigrationThreadArchivePath({
      fileSystem,
      workspaceRoot,
      threadSlug: " billing\\north-america ",
    })).toBe(path.resolve(workspaceRoot, "migrations", "archive", "threads", "billing", "north-america"));
  });

  it("resolves canonical prediction paths from default workspace buckets", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const fileSystem = new InMemoryFileSystem({});

    expect(resolvePredictionWorkspacePaths({ fileSystem, workspaceRoot })).toEqual({
      latest: path.resolve(workspaceRoot, "prediction", "latest"),
      snapshotsRoot: path.resolve(workspaceRoot, "prediction", "snapshots", "root"),
      snapshotsThreads: path.resolve(workspaceRoot, "prediction", "snapshots", "threads"),
    });
  });

  it("resolves canonical prediction paths through explicit prediction mount", () => {
    const workspaceRoot = path.join(path.sep, "repo", "workspace");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            prediction: "../shared/prediction-root",
          },
        },
      }),
    });

    expect(resolvePredictionWorkspacePaths({ fileSystem, workspaceRoot })).toEqual({
      latest: path.resolve(workspaceRoot, "../shared/prediction-root", "latest"),
      snapshotsRoot: path.resolve(workspaceRoot, "../shared/prediction-root", "snapshots", "root"),
      snapshotsThreads: path.resolve(workspaceRoot, "../shared/prediction-root", "snapshots", "threads"),
    });
  });

  it("resolves canonical prediction thread snapshots paths with normalized slugs", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const fileSystem = new InMemoryFileSystem({});

    expect(resolvePredictionThreadSnapshotsPath({
      fileSystem,
      workspaceRoot,
      threadSlug: " checkout\\north-america ",
    })).toBe(path.resolve(workspaceRoot, "prediction", "snapshots", "threads", "checkout", "north-america"));
  });

  it("resolves canonical implementation snapshot roots from default workspace buckets", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const fileSystem = new InMemoryFileSystem({});

    expect(resolveImplementationSnapshotWorkspacePaths({ fileSystem, workspaceRoot })).toEqual({
      snapshotsRoot: path.resolve(workspaceRoot, "implementation", "snapshots", "root"),
      snapshotsThreads: path.resolve(workspaceRoot, "implementation", "snapshots", "threads"),
    });
  });

  it("resolves canonical implementation snapshot roots through explicit implementation mount", () => {
    const workspaceRoot = path.join(path.sep, "repo", "workspace");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            implementation: "../shared/implementation-root",
          },
        },
      }),
    });

    expect(resolveImplementationSnapshotWorkspacePaths({ fileSystem, workspaceRoot })).toEqual({
      snapshotsRoot: path.resolve(workspaceRoot, "../shared/implementation-root", "snapshots", "root"),
      snapshotsThreads: path.resolve(workspaceRoot, "../shared/implementation-root", "snapshots", "threads"),
    });
  });

  it("resolves canonical implementation root snapshot paths with numeric boundaries", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const fileSystem = new InMemoryFileSystem({});

    expect(resolveImplementationRootSnapshotPath({
      fileSystem,
      workspaceRoot,
      snapshotNumber: 12,
    })).toBe(path.resolve(workspaceRoot, "implementation", "snapshots", "root", "12"));
  });

  it("resolves canonical implementation thread snapshot paths with normalized slugs", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const fileSystem = new InMemoryFileSystem({});

    expect(resolveImplementationThreadSnapshotPath({
      fileSystem,
      workspaceRoot,
      threadSlug: " checkout\\north-america ",
      snapshotNumber: "003",
    })).toBe(
      path.resolve(workspaceRoot, "implementation", "snapshots", "threads", "checkout", "north-america", "003"),
    );
  });

  it("rejects implementation snapshot numbers that are not integer path segments", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const fileSystem = new InMemoryFileSystem({});

    expect(() => resolveImplementationRootSnapshotPath({
      fileSystem,
      workspaceRoot,
      snapshotNumber: "1/2",
    })).toThrow("Snapshot number must be a non-empty integer path segment.");
    expect(() => resolveImplementationThreadSnapshotPath({
      fileSystem,
      workspaceRoot,
      threadSlug: "checkout",
      snapshotNumber: "alpha",
    })).toThrow("Snapshot number must be a non-empty integer path segment.");
  });

  it("rejects invalid workspace.mounts types", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: true,
        },
      }),
    });

    expect(() => resolveWorkspaceMounts({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: "workspace.mounts" must be an object.`,
    );
  });

  it("rejects non-string workspace mount targets", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            implementation: 123,
          },
        },
      }),
    });

    expect(() => resolveWorkspaceMounts({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: "workspace.mounts.implementation" must be a string path target.`,
    );
  });

  it("rejects empty workspace mount keys after normalization", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          mounts: {
            "   ": "implementation",
          },
        },
      }),
    });

    expect(() => resolveWorkspaceMounts({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: "workspace.mounts" cannot contain an empty logical mount key.`,
    );
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
      implementation: "sourcedir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
  });

  it("parses implementation placement override when configured", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo", "work");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            implementation: "implementation-src",
          },
          placement: {
            implementation: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePlacement({ fileSystem, workspaceRoot })).toEqual({
      design: "sourcedir",
      implementation: "workdir",
      specs: "sourcedir",
      migrations: "sourcedir",
      prediction: "sourcedir",
    });
    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design"),
      implementation: path.join(invocationRoot, "implementation-src"),
      specs: path.join(workspaceRoot, "specs"),
      migrations: path.join(workspaceRoot, "migrations"),
      prediction: path.join(workspaceRoot, "prediction"),
    });
  });

  it("falls back implementation directory to default when omitted from config", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "docs",
            specs: "quality/specs",
            migrations: "changesets",
            prediction: "predictions",
          },
        },
      }),
    });

    expect(resolveWorkspaceDirectories({ fileSystem, workspaceRoot })).toEqual({
      design: "docs",
      implementation: "implementation",
      specs: "quality/specs",
      migrations: "changesets",
      prediction: "predictions",
    });
  });

  it("rejects collisions when design and prediction directories are identical", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "shared",
            prediction: "shared",
          },
        },
      }),
    });

    expect(() => resolveWorkspaceDirectories({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: workspace directories "design" and "prediction" both resolve to "shared".`,
    );
  });

  it("rejects collisions when implementation and specs directories are identical", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            implementation: "shared",
            specs: "shared",
          },
        },
      }),
    });

    expect(() => resolveWorkspaceDirectories({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: workspace directories "implementation" and "specs" both resolve to "shared".`,
    );
  });

  it("rejects overlaps when design and prediction directories are nested", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            design: "shared",
            prediction: "shared/inner",
          },
        },
      }),
    });

    expect(() => resolveWorkspaceDirectories({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: workspace directories "design" ("shared") and "prediction" ("shared/inner") overlap.`,
    );
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

  it("rejects non-string workspace directory values for implementation", () => {
    const workspaceRoot = path.join(path.sep, "repo");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          directories: {
            implementation: 123,
          },
        },
      }),
    });

    expect(() => resolveWorkspaceDirectories({ fileSystem, workspaceRoot })).toThrow(
      `Invalid project config at ${configPath}: "workspace.directories.implementation" must be a string.`,
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
      implementation: path.join(workspaceRoot, "implementation"),
      specs: path.join(workspaceRoot, "specs"),
      migrations: path.join(workspaceRoot, "migrations"),
      prediction: path.join(workspaceRoot, "prediction"),
    });
  });

  it("roots prediction path at invocation root when prediction placement is workdir", () => {
    const workspaceRoot = path.join(path.sep, "repo", "source");
    const invocationRoot = path.join(path.sep, "repo", "work");
    const configPath = path.join(workspaceRoot, ".rundown", "config.json");
    const fileSystem = new InMemoryFileSystem({
      [configPath]: JSON.stringify({
        workspace: {
          placement: {
            prediction: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design"),
      implementation: path.join(workspaceRoot, "implementation"),
      specs: path.join(workspaceRoot, "specs"),
      migrations: path.join(workspaceRoot, "migrations"),
      prediction: path.join(invocationRoot, "prediction"),
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
            implementation: "implementation-src",
            specs: "checks/specs",
            migrations: "history",
            prediction: "predicted",
          },
          placement: {
            design: "sourcedir",
            implementation: "sourcedir",
            specs: "workdir",
            migrations: "workdir",
            prediction: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "docs"),
      implementation: path.join(workspaceRoot, "implementation-src"),
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
            implementation: "implementation",
            specs: "quality/specs",
            migrations: "changesets",
            prediction: "predicted",
          },
          placement: {
            design: "sourcedir",
            implementation: "sourcedir",
            specs: "workdir",
            migrations: "workdir",
            prediction: "workdir",
          },
        },
      }),
    });

    expect(resolveWorkspacePaths({ fileSystem, workspaceRoot, invocationRoot })).toEqual({
      design: path.join(workspaceRoot, "design"),
      implementation: path.join(workspaceRoot, "implementation"),
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

  it("returns actionable guidance when a resolved bucket root is missing", () => {
    const workspaceRoot = path.join(path.sep, "repo", "workspace");
    const fileSystem = new InMemoryFileSystem({});
    const workspacePaths = resolveWorkspacePaths({ fileSystem, workspaceRoot });

    const result = validateWorkspaceBucketRootDirectory({
      fileSystem,
      workspacePaths,
      bucket: "implementation",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.absolutePath).toBe(path.join(workspaceRoot, "implementation"));
    expect(result.message).toContain("resolved workspace path does not exist at");
    expect(result.message).toContain("workspace.mounts.implementation");
    expect(result.message).toContain("workspace.directories.implementation");
    expect(result.message).toContain("workspace.placement.implementation");
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
          implementation: "implementation",
          specs: "specs",
          migrations: "migrations",
          prediction: "prediction",
        },
        placement: {
          design: "workdir",
          implementation: "sourcedir",
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
            implementation: "implementation",
            specs: "design",
            migrations: "migrations",
            prediction: "prediction",
          },
          placement: {
            design: "workdir",
            implementation: "sourcedir",
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
            implementation: "implementation",
            specs: "design",
            migrations: "migrations",
            prediction: "prediction",
          },
          placement: {
            design: "workdir",
            implementation: "sourcedir",
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
