import path from "node:path";
import type { FileSystem } from "../domain/ports/index.js";

export interface WorkspaceDirectories {
  design: string;
  specs: string;
  migrations: string;
  prediction: string;
}

type WorkspaceBucket = keyof WorkspaceDirectories;

export const WORKSPACE_PLACEMENTS = ["sourcedir", "workdir"] as const;

export type WorkspacePlacement = typeof WORKSPACE_PLACEMENTS[number];

export interface WorkspacePlacementMap {
  design: WorkspacePlacement;
  specs: WorkspacePlacement;
  migrations: WorkspacePlacement;
  prediction: WorkspacePlacement;
}

export interface WorkspacePaths {
  design: string;
  specs: string;
  migrations: string;
  prediction: string;
}

interface WorkspaceConfig {
  directories: WorkspaceDirectories;
  placement: WorkspacePlacementMap;
}

interface RundownConfigDocument {
  workspace?: {
    directories?: Partial<Record<WorkspaceBucket, unknown>>;
    placement?: Partial<Record<WorkspaceBucket, unknown>>;
  };
  [key: string]: unknown;
}

export const DEFAULT_WORKSPACE_DIRECTORIES: WorkspaceDirectories = {
  design: "design",
  specs: "specs",
  migrations: "migrations",
  prediction: "prediction",
};

export const DEFAULT_WORKSPACE_PLACEMENT: WorkspacePlacementMap = {
  design: "sourcedir",
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

function resolveWorkspaceConfig(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
}): WorkspaceConfig {
  const { fileSystem, workspaceRoot } = input;
  const configPath = path.join(workspaceRoot, ".rundown", "config.json");
  if (!fileSystem.exists(configPath)) {
    return {
      directories: { ...DEFAULT_WORKSPACE_DIRECTORIES },
      placement: { ...DEFAULT_WORKSPACE_PLACEMENT },
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

  const directories = {
    design: normalizeWorkspaceDirectoryValue({
      configPath,
      key: "design",
      value: directoriesSection?.design,
      fallback: DEFAULT_WORKSPACE_DIRECTORIES.design,
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
  return {
    directories,
    placement,
  };
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

  return resolveWorkspacePaths(input)[bucket];
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
  const directories = input.directories ?? resolveWorkspaceDirectories({ fileSystem, workspaceRoot });
  const placement = input.placement ?? resolveWorkspacePlacement({ fileSystem, workspaceRoot });

  const resolvedPaths = {
    design: resolveBucketPath({
      configPath: path.join(workspaceRoot, ".rundown", "config.json"),
      bucket: "design",
      root: resolvePlacementRoot(placement.design, workspaceRoot, invocationRoot),
      relativeDirectory: directories.design,
    }),
    specs: resolveBucketPath({
      configPath: path.join(workspaceRoot, ".rundown", "config.json"),
      bucket: "specs",
      root: resolvePlacementRoot(placement.specs, workspaceRoot, invocationRoot),
      relativeDirectory: directories.specs,
    }),
    migrations: resolveBucketPath({
      configPath: path.join(workspaceRoot, ".rundown", "config.json"),
      bucket: "migrations",
      root: resolvePlacementRoot(placement.migrations, workspaceRoot, invocationRoot),
      relativeDirectory: directories.migrations,
    }),
  } satisfies WorkspacePaths;

  validateResolvedBucketConflicts({
    configPath: path.join(workspaceRoot, ".rundown", "config.json"),
    paths: resolvedPaths,
  });

  return resolvedPaths;
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

function resolveBucketPath(input: {
  configPath: string;
  bucket: WorkspaceBucket;
  root: string;
  relativeDirectory: string;
}): string {
  const { configPath, bucket, root, relativeDirectory } = input;
  const normalizedRelativeDirectory = normalizeWorkspaceDirectoryValue({
    configPath,
    key: bucket,
    value: relativeDirectory,
    fallback: relativeDirectory,
  });

  return path.join(root, normalizedRelativeDirectory);
}

function validateResolvedBucketConflicts(input: { configPath: string; paths: WorkspacePaths }): void {
  const { configPath, paths } = input;
  const entries = Object.entries(paths) as Array<[WorkspaceBucket, string]>;

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

      const currentPath = normalizeForPathComparison(current[1]);
      const otherPath = normalizeForPathComparison(other[1]);
      if (currentPath === otherPath) {
        throw new Error(
          `Invalid project config at ${configPath}: workspace directories "${current[0]}" and "${other[0]}" both resolve to "${current[1]}".`,
        );
      }

      if (isAncestorOrDescendantPath(currentPath, otherPath)) {
        throw new Error(
          `Invalid project config at ${configPath}: workspace directories "${current[0]}" ("${current[1]}") and "${other[0]}" ("${other[1]}") overlap.`,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
