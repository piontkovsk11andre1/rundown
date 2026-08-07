import path from "node:path";
import type { FileSystem } from "../domain/ports/index.js";

export interface WorkspaceDirectories {
  design: string;
  implementation: string;
  specs: string;
  migrations: string;
  prediction: string;
}

type WorkspaceBucket = keyof WorkspaceDirectories;

export const WORKSPACE_PLACEMENTS = ["sourcedir", "workdir"] as const;

export type WorkspacePlacement = typeof WORKSPACE_PLACEMENTS[number];

export interface WorkspacePlacementMap {
  design: WorkspacePlacement;
  implementation: WorkspacePlacement;
  specs: WorkspacePlacement;
  migrations: WorkspacePlacement;
  prediction: WorkspacePlacement;
}

export interface WorkspacePaths {
  design: string;
  implementation: string;
  specs: string;
  migrations: string;
  prediction: string;
}

export type WorkspaceBucketRootValidationResult =
  | {
    ok: true;
    bucket: WorkspaceBucket;
    absolutePath: string;
  }
  | {
    ok: false;
    bucket: WorkspaceBucket;
    absolutePath: string;
    message: string;
  };

export interface ArchiveWorkspacePaths {
  designRevisionPayloads: string;
  migrationRootLane: string;
  migrationThreads: string;
}

export interface PredictionWorkspacePaths {
  latest: string;
  snapshotsRoot: string;
  snapshotsThreads: string;
}

export interface ImplementationSnapshotWorkspacePaths {
  snapshotsRoot: string;
  snapshotsThreads: string;
}

export type WorkspaceMountSource = "legacy" | "explicit";

export interface WorkspaceMount {
  logicalPath: string;
  absoluteTargetPath: string;
  source: WorkspaceMountSource;
}

export interface ResolvedWorkspaceMountPath {
  logicalPath: string;
  absolutePath: string;
  mount: WorkspaceMount;
  mountRelativePath: string;
}

export type WorkspaceMountMap = Record<string, WorkspaceMount>;

interface WorkspaceConfig {
  directories: WorkspaceDirectories;
  placement: WorkspacePlacementMap;
  designCurrentPath?: string;
  mounts: WorkspaceMountMap;
}

interface RundownConfigDocument {
  workspace?: {
    directories?: Partial<Record<WorkspaceBucket, unknown>>;
    placement?: Partial<Record<WorkspaceBucket, unknown>>;
    mounts?: Record<string, unknown>;
    design?: {
      currentPath?: unknown;
    };
  };
  [key: string]: unknown;
}

export const DEFAULT_WORKSPACE_DIRECTORIES: WorkspaceDirectories = {
  design: "design",
  implementation: "implementation",
  specs: "specs",
  migrations: "migrations",
  prediction: "prediction",
};

export const DEFAULT_WORKSPACE_PLACEMENT: WorkspacePlacementMap = {
  design: "sourcedir",
  implementation: "sourcedir",
  specs: "sourcedir",
  migrations: "sourcedir",
  prediction: "sourcedir",
};

export function resolveWorkspaceDirectories(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
}): WorkspaceDirectories {
  return resolveWorkspaceConfig(input).directories;
}

export function resolveWorkspacePlacement(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
}): WorkspacePlacementMap {
  return resolveWorkspaceConfig(input).placement;
}

/**
 * Returns the absolute path override configured for `design/current`, if any.
 *
 * When set, the design draft directory does not live under `<design>/current`
 * but rather at this absolute external path. Revisions (`rev.N/`) continue to
 * be stored under the regular design bucket.
 */
export function resolveDesignCurrentPathOverride(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
}): string | undefined {
  return resolveWorkspaceConfig(input).designCurrentPath;
}

export function resolveWorkspaceMounts(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot?: string;
}): WorkspaceMountMap {
  return resolveWorkspaceConfig(input).mounts;
}

export function normalizeWorkspaceLogicalPath(logicalPath: string): string {
  const trimmed = logicalPath.trim();
  if (trimmed.length === 0) {
    throw new Error("Logical path cannot be empty.");
  }

  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized.length === 0 || normalized === ".") {
    throw new Error("Logical path resolves to an empty path.");
  }
  if (normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Logical path must be a normalized rundown logical path.");
  }

  return normalized;
}

export function resolveWorkspaceMountPath(input: {
  mounts: WorkspaceMountMap;
  logicalPath: string;
}): ResolvedWorkspaceMountPath {
  const normalizedLogicalPath = normalizeWorkspaceLogicalPath(input.logicalPath);
  const mount = findLongestPrefixWorkspaceMount({
    mounts: input.mounts,
    logicalPath: normalizedLogicalPath,
  });
  if (!mount) {
    throw new Error(`No workspace mount found for logical path "${normalizedLogicalPath}".`);
  }

  const mountRelativePath =
    normalizedLogicalPath === mount.logicalPath
      ? ""
      : normalizedLogicalPath.slice(mount.logicalPath.length + 1);
  const absolutePath =
    mountRelativePath.length === 0
      ? mount.absoluteTargetPath
      : path.resolve(mount.absoluteTargetPath, ...mountRelativePath.split("/"));

  return {
    logicalPath: normalizedLogicalPath,
    absolutePath,
    mount,
    mountRelativePath,
  };
}

function resolveWorkspaceConfig(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot?: string;
}): WorkspaceConfig {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const configPath = path.join(workspaceRoot, ".rundown", "config.json");
  if (!fileSystem.exists(configPath)) {
    const defaultDirectories = { ...DEFAULT_WORKSPACE_DIRECTORIES };
    const defaultPlacement = { ...DEFAULT_WORKSPACE_PLACEMENT };
    return {
      directories: defaultDirectories,
      placement: defaultPlacement,
      mounts: buildLegacyWorkspaceMounts({
        directories: defaultDirectories,
        placement: defaultPlacement,
        workspaceRoot,
        invocationRoot,
      }),
    };
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(fileSystem.readText(configPath));
  } catch (error) {
    throw new Error(
      `Invalid project config at ${configPath}: failed to parse JSON (${String(error)}).`,
    );
  }

  if (!isPlainObject(parsedConfig)) {
    throw new Error(`Invalid project config at ${configPath}: expected a top-level JSON object.`);
  }

  const workspaceSection = parsedConfig.workspace;
  if (workspaceSection !== undefined && !isPlainObject(workspaceSection)) {
    throw new Error(`Invalid project config at ${configPath}: "workspace" must be an object.`);
  }

  const directoriesSection = workspaceSection?.directories;
  if (directoriesSection !== undefined && !isPlainObject(directoriesSection)) {
    throw new Error(`Invalid project config at ${configPath}: "workspace.directories" must be an object.`);
  }
  const placementSection = workspaceSection?.placement;
  if (placementSection !== undefined && !isPlainObject(placementSection)) {
    throw new Error(`Invalid project config at ${configPath}: "workspace.placement" must be an object.`);
  }
  const mountsSection = workspaceSection?.mounts;
  if (mountsSection !== undefined && !isPlainObject(mountsSection)) {
    throw new Error(`Invalid project config at ${configPath}: "workspace.mounts" must be an object.`);
  }

  const directories = {
    design: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "design",
      value: directoriesSection?.design,
      fallback: DEFAULT_WORKSPACE_DIRECTORIES.design,
    }),
    implementation: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "implementation",
      value: directoriesSection?.implementation,
      fallback: DEFAULT_WORKSPACE_DIRECTORIES.implementation,
    }),
    specs: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "specs",
      value: directoriesSection?.specs,
      fallback: DEFAULT_WORKSPACE_DIRECTORIES.specs,
    }),
    migrations: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "migrations",
      value: directoriesSection?.migrations,
      fallback: DEFAULT_WORKSPACE_DIRECTORIES.migrations,
    }),
    prediction: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "prediction",
      value: directoriesSection?.prediction,
      fallback: DEFAULT_WORKSPACE_DIRECTORIES.prediction,
    }),
  } satisfies WorkspaceDirectories;

  const placement = {
    design: normalizeWorkspacePlacementValue({
      configPath,
      key: "design",
      value: placementSection?.design,
      fallback: DEFAULT_WORKSPACE_PLACEMENT.design,
    }),
    implementation: normalizeWorkspacePlacementValue({
      configPath,
      key: "implementation",
      value: placementSection?.implementation,
      fallback: DEFAULT_WORKSPACE_PLACEMENT.implementation,
    }),
    specs: normalizeWorkspacePlacementValue({
      configPath,
      key: "specs",
      value: placementSection?.specs,
      fallback: DEFAULT_WORKSPACE_PLACEMENT.specs,
    }),
    migrations: normalizeWorkspacePlacementValue({
      configPath,
      key: "migrations",
      value: placementSection?.migrations,
      fallback: DEFAULT_WORKSPACE_PLACEMENT.migrations,
    }),
    prediction: normalizeWorkspacePlacementValue({
      configPath,
      key: "prediction",
      value: placementSection?.prediction,
      fallback: DEFAULT_WORKSPACE_PLACEMENT.prediction,
    }),
  } satisfies WorkspacePlacementMap;

  validateDirectoryConflicts(directories, configPath);

  const designSection = workspaceSection?.design;
  if (designSection !== undefined && !isPlainObject(designSection)) {
    throw new Error(`Invalid project config at ${configPath}: "workspace.design" must be an object.`);
  }
  const designCurrentPath = normalizeDesignCurrentPathValue({
    configPath,
    value: designSection?.currentPath,
  });

  const legacyMounts = buildLegacyWorkspaceMounts({
    directories,
    placement,
    workspaceRoot,
    invocationRoot,
    ...(designCurrentPath ? { designCurrentPath } : {}),
  });
  const explicitMounts = normalizeExplicitWorkspaceMounts({
    configPath,
    workspaceRoot,
    mountsSection,
  });
  const mounts = {
    ...legacyMounts,
    ...explicitMounts,
  };

  return {
    directories,
    placement,
    ...(designCurrentPath ? { designCurrentPath } : {}),
    mounts,
  };
}

function normalizeDesignCurrentPathValue(input: {
  configPath: string;
  value: unknown;
}): string | undefined {
  const { configPath, value } = input;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(
      `Invalid project config at ${configPath}: "workspace.design.currentPath" must be a string.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (!path.isAbsolute(trimmed)) {
    throw new Error(
      `Invalid project config at ${configPath}: "workspace.design.currentPath" must be an absolute path.`,
    );
  }
  return path.normalize(trimmed);
}

function findLongestPrefixWorkspaceMount(input: {
  mounts: WorkspaceMountMap;
  logicalPath: string;
}): WorkspaceMount | undefined {
  const normalizedLogicalPath = normalizeWorkspaceLogicalPath(input.logicalPath);
  let winner: WorkspaceMount | undefined;

  for (const mount of Object.values(input.mounts)) {
    const mountLogicalPath = normalizeWorkspaceLogicalPath(mount.logicalPath);
    if (
      normalizedLogicalPath !== mountLogicalPath
      && !normalizedLogicalPath.startsWith(mountLogicalPath + "/")
    ) {
      continue;
    }
    if (!winner || mountLogicalPath.length > winner.logicalPath.length) {
      winner = mount;
    }
  }

  return winner;
}

export function resolveWorkspacePath(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot?: string;
  bucket: WorkspaceBucket;
  overrideDir?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): string {
  const { workspaceRoot, bucket, overrideDir } = input;
  const trimmedOverride = overrideDir?.trim();
  if (trimmedOverride && trimmedOverride.length > 0) {
    return path.resolve(workspaceRoot, trimmedOverride);
  }

  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem: input.fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  return resolveWorkspaceMountPath({
    mounts,
    logicalPath: bucket,
  }).absolutePath;
}

export function resolveWorkspacePaths(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): WorkspacePaths {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  const resolvedDesignPath = resolveWorkspaceMountPath({ mounts, logicalPath: "design" });
  const resolvedImplementationPath = resolveWorkspaceMountPath({ mounts, logicalPath: "implementation" });
  const resolvedSpecsPath = resolveWorkspaceMountPath({ mounts, logicalPath: "specs" });
  const resolvedMigrationsPath = resolveWorkspaceMountPath({ mounts, logicalPath: "migrations" });
  const resolvedPredictionPath = resolveWorkspaceMountPath({ mounts, logicalPath: "prediction" });

  const resolvedPaths = {
    design: resolvedDesignPath.absolutePath,
    implementation: resolvedImplementationPath.absolutePath,
    specs: resolvedSpecsPath.absolutePath,
    migrations: resolvedMigrationsPath.absolutePath,
    prediction: resolvedPredictionPath.absolutePath,
  } satisfies WorkspacePaths;

  validateResolvedBucketConflicts({
    configPath: path.join(workspaceRoot, ".rundown", "config.json"),
    resolvedBuckets: {
      design: resolvedDesignPath,
      implementation: resolvedImplementationPath,
      specs: resolvedSpecsPath,
      migrations: resolvedMigrationsPath,
      prediction: resolvedPredictionPath,
    },
  });

  return resolvedPaths;
}

export function validateWorkspaceBucketRootDirectory(input: {
  fileSystem: FileSystem;
  workspacePaths: WorkspacePaths;
  bucket: WorkspaceBucket;
}): WorkspaceBucketRootValidationResult {
  const { fileSystem, workspacePaths, bucket } = input;
  const absolutePath = workspacePaths[bucket];

  if (!fileSystem.exists(absolutePath)) {
    return {
      ok: false,
      bucket,
      absolutePath,
      message: "resolved workspace path does not exist at "
        + absolutePath
        + ". Create this directory or update .rundown/config.json"
        + " (workspace.mounts."
        + bucket
        + " or workspace.directories."
        + bucket
        + " / workspace.placement."
        + bucket
        + ").",
    };
  }

  const stat = fileSystem.stat(absolutePath);
  if (!stat?.isDirectory) {
    return {
      ok: false,
      bucket,
      absolutePath,
      message: "resolved workspace path is not a directory at "
        + absolutePath
        + ". Point workspace routing to a directory via .rundown/config.json"
        + " (workspace.mounts."
        + bucket
        + " or workspace.directories."
        + bucket
        + " / workspace.placement."
        + bucket
        + ").",
    };
  }

  return {
    ok: true,
    bucket,
    absolutePath,
  };
}

export function resolveArchiveWorkspacePaths(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): ArchiveWorkspacePaths {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  return {
    designRevisionPayloads: resolveWorkspaceMountPath({
      mounts,
      logicalPath: "design/archive/revisions",
    }).absolutePath,
    migrationRootLane: resolveWorkspaceMountPath({
      mounts,
      logicalPath: "migrations/archive/root",
    }).absolutePath,
    migrationThreads: resolveWorkspaceMountPath({
      mounts,
      logicalPath: "migrations/archive/threads",
    }).absolutePath,
  };
}

export function resolveMigrationThreadArchivePath(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  threadSlug: string;
  invocationRoot?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): string {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  const normalizedThreadSlug = normalizeWorkspaceLogicalPath(input.threadSlug);
  return resolveWorkspaceMountPath({
    mounts,
    logicalPath: `migrations/archive/threads/${normalizedThreadSlug}`,
  }).absolutePath;
}

export function resolvePredictionWorkspacePaths(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): PredictionWorkspacePaths {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  return {
    latest: resolveWorkspaceMountPath({
      mounts,
      logicalPath: "prediction/latest",
    }).absolutePath,
    snapshotsRoot: resolveWorkspaceMountPath({
      mounts,
      logicalPath: "prediction/snapshots/root",
    }).absolutePath,
    snapshotsThreads: resolveWorkspaceMountPath({
      mounts,
      logicalPath: "prediction/snapshots/threads",
    }).absolutePath,
  };
}

export function resolvePredictionThreadSnapshotsPath(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  threadSlug: string;
  invocationRoot?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): string {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  const normalizedThreadSlug = normalizeWorkspaceLogicalPath(input.threadSlug);
  return resolveWorkspaceMountPath({
    mounts,
    logicalPath: `prediction/snapshots/threads/${normalizedThreadSlug}`,
  }).absolutePath;
}

export function resolveImplementationSnapshotWorkspacePaths(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): ImplementationSnapshotWorkspacePaths {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  return {
    snapshotsRoot: resolveWorkspaceMountPath({
      mounts,
      logicalPath: "implementation/snapshots/root",
    }).absolutePath,
    snapshotsThreads: resolveWorkspaceMountPath({
      mounts,
      logicalPath: "implementation/snapshots/threads",
    }).absolutePath,
  };
}

export function resolveImplementationRootSnapshotPath(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  snapshotNumber: string | number;
  invocationRoot?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): string {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  const normalizedSnapshotNumber = normalizeSnapshotNumber(input.snapshotNumber);
  return resolveWorkspaceMountPath({
    mounts,
    logicalPath: `implementation/snapshots/root/${normalizedSnapshotNumber}`,
  }).absolutePath;
}

export function resolveImplementationThreadSnapshotPath(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  threadSlug: string;
  snapshotNumber: string | number;
  invocationRoot?: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): string {
  const { fileSystem, workspaceRoot } = input;
  const invocationRoot = input.invocationRoot ?? workspaceRoot;
  const mounts = resolveWorkspaceMountsForPathHelpers({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    directories: input.directories,
    placement: input.placement,
  });

  const normalizedThreadSlug = normalizeWorkspaceLogicalPath(input.threadSlug);
  const normalizedSnapshotNumber = normalizeSnapshotNumber(input.snapshotNumber);
  return resolveWorkspaceMountPath({
    mounts,
    logicalPath: `implementation/snapshots/threads/${normalizedThreadSlug}/${normalizedSnapshotNumber}`,
  }).absolutePath;
}

function resolveWorkspaceMountsForPathHelpers(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
}): WorkspaceMountMap {
  const { fileSystem, workspaceRoot, invocationRoot } = input;
  const normalizedMounts = resolveWorkspaceMounts({
    fileSystem,
    workspaceRoot,
    invocationRoot,
  });
  const configPath = path.join(workspaceRoot, ".rundown", "config.json");
  const resolvedDirectories = input.directories ?? resolveWorkspaceDirectories({ fileSystem, workspaceRoot });
  const directories = {
    design: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "design",
      value: resolvedDirectories.design,
      fallback: resolvedDirectories.design,
    }),
    implementation: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "implementation",
      value: resolvedDirectories.implementation,
      fallback: resolvedDirectories.implementation,
    }),
    specs: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "specs",
      value: resolvedDirectories.specs,
      fallback: resolvedDirectories.specs,
    }),
    migrations: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "migrations",
      value: resolvedDirectories.migrations,
      fallback: resolvedDirectories.migrations,
    }),
    prediction: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "prediction",
      value: resolvedDirectories.prediction,
      fallback: resolvedDirectories.prediction,
    }),
  } satisfies WorkspaceDirectories;
  validateDirectoryConflicts(directories, configPath);

  const resolvedPlacement = input.placement ?? resolveWorkspacePlacement({ fileSystem, workspaceRoot });
  const placement = {
    design: normalizeWorkspacePlacementValue({
      configPath,
      key: "design",
      value: resolvedPlacement.design,
      fallback: resolvedPlacement.design,
    }),
    implementation: normalizeWorkspacePlacementValue({
      configPath,
      key: "implementation",
      value: resolvedPlacement.implementation,
      fallback: resolvedPlacement.implementation,
    }),
    specs: normalizeWorkspacePlacementValue({
      configPath,
      key: "specs",
      value: resolvedPlacement.specs,
      fallback: resolvedPlacement.specs,
    }),
    migrations: normalizeWorkspacePlacementValue({
      configPath,
      key: "migrations",
      value: resolvedPlacement.migrations,
      fallback: resolvedPlacement.migrations,
    }),
    prediction: normalizeWorkspacePlacementValue({
      configPath,
      key: "prediction",
      value: resolvedPlacement.prediction,
      fallback: resolvedPlacement.prediction,
    }),
  } satisfies WorkspacePlacementMap;

  const designCurrentPath = resolveDesignCurrentPathOverride({
    fileSystem,
    workspaceRoot,
  });
  const legacyMounts = buildLegacyWorkspaceMountsForPathHelpers({
    directories,
    placement,
    workspaceRoot,
    invocationRoot,
    ...(designCurrentPath ? { designCurrentPath } : {}),
  });

  return {
    ...legacyMounts,
    ...extractExplicitWorkspaceMounts({ mounts: normalizedMounts, configPath }),
  };
}

function buildLegacyWorkspaceMountsForPathHelpers(input: {
  directories: WorkspaceDirectories;
  placement: WorkspacePlacementMap;
  workspaceRoot: string;
  invocationRoot: string;
  designCurrentPath?: string;
}): WorkspaceMountMap {
  const { directories, placement, workspaceRoot, invocationRoot, designCurrentPath } = input;
  const legacyMounts: WorkspaceMountMap = {};

  const buckets = Object.keys(DEFAULT_WORKSPACE_DIRECTORIES) as WorkspaceBucket[];
  for (const bucket of buckets) {
    const bucketRoot = resolvePlacementRoot(placement[bucket], workspaceRoot, invocationRoot);
    legacyMounts[bucket] = {
      logicalPath: bucket,
      absoluteTargetPath: path.join(bucketRoot, directories[bucket]),
      source: "legacy",
    };
  }

  if (designCurrentPath) {
    legacyMounts["design/current"] = {
      logicalPath: "design/current",
      absoluteTargetPath: designCurrentPath,
      source: "legacy",
    };
  }

  return legacyMounts;
}

function extractExplicitWorkspaceMounts(input: {
  mounts: WorkspaceMountMap;
  configPath: string;
}): WorkspaceMountMap {
  const explicitMounts: WorkspaceMountMap = {};
  const entries = Object.entries(input.mounts);
  for (const [logicalPath, mount] of entries) {
    if (mount.source !== "explicit") {
      continue;
    }
    if (explicitMounts[logicalPath]) {
      throw new Error(
        `Invalid project config at ${input.configPath}: duplicate explicit workspace mount key "${logicalPath}".`,
      );
    }
    explicitMounts[logicalPath] = mount;
  }

  return explicitMounts;
}

function resolvePlacementRoot(
  placement: WorkspacePlacement,
  workspaceRoot: string,
  invocationRoot: string,
): string {
  return placement === "workdir" ? invocationRoot : workspaceRoot;
}

function normalizeWorkspacePlacementValue(input: {
  configPath: string;
  key: WorkspaceBucket;
  value: unknown;
  fallback: WorkspacePlacement;
}): WorkspacePlacement {
  const { configPath, key, value, fallback } = input;
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid project config at ${configPath}: "workspace.placement.${key}" must be a string.`);
  }
  if (!WORKSPACE_PLACEMENTS.includes(value as WorkspacePlacement)) {
    throw new Error(
      `Invalid project config at ${configPath}: "workspace.placement.${key}" must be "sourcedir" or "workdir".`,
    );
  }

  return value as WorkspacePlacement;
}

function normalizeExplicitWorkspaceMounts(input: {
  configPath: string;
  workspaceRoot: string;
  mountsSection: Record<string, unknown> | undefined;
}): WorkspaceMountMap {
  const { configPath, workspaceRoot, mountsSection } = input;
  if (!mountsSection) {
    return {};
  }

  const normalizedMounts: WorkspaceMountMap = {};
  for (const [rawLogicalPath, rawTarget] of Object.entries(mountsSection)) {
    const logicalPath = normalizeLogicalMountPath({
      configPath,
      key: rawLogicalPath,
    });
    const absoluteTargetPath = normalizeMountTargetPath({
      configPath,
      logicalPath,
      value: rawTarget,
      workspaceRoot,
    });
    if (normalizedMounts[logicalPath]) {
      throw new Error(
        `Invalid project config at ${configPath}: "workspace.mounts" contains duplicate logical mount key "${logicalPath}" after normalization.`,
      );
    }

    normalizedMounts[logicalPath] = {
      logicalPath,
      absoluteTargetPath,
      source: "explicit",
    };
  }

  return normalizedMounts;
}

function buildLegacyWorkspaceMounts(input: {
  directories: WorkspaceDirectories;
  placement: WorkspacePlacementMap;
  workspaceRoot: string;
  invocationRoot: string;
  designCurrentPath?: string;
}): WorkspaceMountMap {
  const { directories, placement, workspaceRoot, invocationRoot, designCurrentPath } = input;
  const legacyMounts: WorkspaceMountMap = {};

  const buckets = Object.keys(DEFAULT_WORKSPACE_DIRECTORIES) as WorkspaceBucket[];
  for (const bucket of buckets) {
    const bucketRoot = resolvePlacementRoot(placement[bucket], workspaceRoot, invocationRoot);
    legacyMounts[bucket] = {
      logicalPath: bucket,
      absoluteTargetPath: path.resolve(bucketRoot, directories[bucket]),
      source: "legacy",
    };
  }

  if (designCurrentPath) {
    legacyMounts["design/current"] = {
      logicalPath: "design/current",
      absoluteTargetPath: designCurrentPath,
      source: "legacy",
    };
  }

  return legacyMounts;
}

function normalizeLogicalMountPath(input: { configPath: string; key: string }): string {
  const { configPath, key } = input;
  try {
    return normalizeWorkspaceLogicalPath(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "Logical path cannot be empty.") {
      throw new Error(
        `Invalid project config at ${configPath}: "workspace.mounts" cannot contain an empty logical mount key.`,
      );
    }
    if (message === "Logical path resolves to an empty path.") {
      throw new Error(
        `Invalid project config at ${configPath}: "workspace.mounts.${key}" resolves to an empty logical path.`,
      );
    }
    throw new Error(
      `Invalid project config at ${configPath}: "workspace.mounts.${key}" must be a normalized rundown logical path.`,
    );
  }
}

function normalizeMountTargetPath(input: {
  configPath: string;
  logicalPath: string;
  value: unknown;
  workspaceRoot: string;
}): string {
  const { configPath, logicalPath, value, workspaceRoot } = input;
  if (typeof value !== "string") {
    throw new Error(
      `Invalid project config at ${configPath}: "workspace.mounts.${logicalPath}" must be a string path target.`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `Invalid project config at ${configPath}: "workspace.mounts.${logicalPath}" cannot be empty.`,
    );
  }

  if (path.isAbsolute(trimmed)) {
    return path.normalize(trimmed);
  }

  return path.resolve(workspaceRoot, trimmed);
}

function normalizeWorkspaceDirectoryValue(input: {
  configPath: string;
  key: WorkspaceBucket;
  value: unknown;
  fallback: string;
}): string {
  const { configPath, key, value, fallback } = input;
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new Error(`Invalid project config at ${configPath}: "workspace.directories.${key}" must be a string.`);
  }

  const trimmedValue = value.trim();
  if (trimmedValue.length === 0) {
    throw new Error(`Invalid project config at ${configPath}: "workspace.directories.${key}" cannot be empty.`);
  }
  if (path.isAbsolute(trimmedValue)) {
    throw new Error(
      `Invalid project config at ${configPath}: "workspace.directories.${key}" must be project-relative, not absolute.`,
    );
  }

  const normalizedPath = path.posix.normalize(trimmedValue.replace(/\\/g, "/"));
  if (normalizedPath.length === 0 || normalizedPath === ".") {
    throw new Error(`Invalid project config at ${configPath}: "workspace.directories.${key}" resolves to the project root.`);
  }
  if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new Error(
      `Invalid project config at ${configPath}: "workspace.directories.${key}" escapes the project root.`,
    );
  }

  return normalizedPath;
}

function validateDirectoryConflicts(directories: WorkspaceDirectories, configPath: string): void {
  const entries = Object.entries(directories) as Array<[WorkspaceBucket, string]>;

  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    if (!current) {
      continue;
    }

    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      const other = entries[otherIndex];
      if (!other) {
        continue;
      }

      if (current[1] === other[1]) {
        throw new Error(
          `Invalid project config at ${configPath}: workspace directories "${current[0]}" and "${other[0]}" both resolve to "${current[1]}".`,
        );
      }

      if (isAncestorOrDescendantPath(current[1], other[1])) {
        throw new Error(
          `Invalid project config at ${configPath}: workspace directories "${current[0]}" ("${current[1]}") and "${other[0]}" ("${other[1]}") overlap.`,
        );
      }
    }
  }
}

function isAncestorOrDescendantPath(left: string, right: string): boolean {
  return left.startsWith(right + "/") || right.startsWith(left + "/");
}

function validateResolvedBucketConflicts(input: {
  configPath: string;
  resolvedBuckets: Record<WorkspaceBucket, ResolvedWorkspaceMountPath>;
}): void {
  const { configPath, resolvedBuckets } = input;
  const entries = Object.entries(resolvedBuckets) as Array<[WorkspaceBucket, ResolvedWorkspaceMountPath]>;

  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    if (!current) {
      continue;
    }

    for (let otherIndex = index + 1; otherIndex < entries.length; otherIndex += 1) {
      const other = entries[otherIndex];
      if (!other) {
        continue;
      }

      const currentPath = normalizeForPathComparison(current[1].absolutePath);
      const otherPath = normalizeForPathComparison(other[1].absolutePath);
      if (currentPath === otherPath) {
        throw new Error(
          `Invalid project config at ${configPath}: workspace directories "${current[0]}" and "${other[0]}" both resolve to "${current[1].absolutePath}".`,
        );
      }

      const currentMountIsLegacy = current[1].mount.source === "legacy";
      const otherMountIsLegacy = other[1].mount.source === "legacy";
      if (currentMountIsLegacy && otherMountIsLegacy && isAncestorOrDescendantPath(currentPath, otherPath)) {
        throw new Error(
          `Invalid project config at ${configPath}: workspace directories "${current[0]}" ("${current[1].absolutePath}") and "${other[0]}" ("${other[1].absolutePath}") overlap.`,
        );
      }
    }
  }
}

function normalizeForPathComparison(targetPath: string): string {
  const normalized = path.normalize(targetPath).replace(/\\/g, "/");
  if (process.platform === "win32") {
    return normalized.toLowerCase();
  }

  return normalized;
}

function normalizeSnapshotNumber(snapshotNumber: string | number): string {
  const normalizedSnapshotNumber = normalizeWorkspaceLogicalPath(String(snapshotNumber));
  if (normalizedSnapshotNumber.includes("/") || !/^\d+$/.test(normalizedSnapshotNumber)) {
    throw new Error("Snapshot number must be a non-empty integer path segment.");
  }

  return normalizedSnapshotNumber;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
