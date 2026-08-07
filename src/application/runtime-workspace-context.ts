import path from "node:path";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { PathOperationsPort } from "../domain/ports/index.js";
import {
  DEFAULT_WORKSPACE_DIRECTORIES,
  DEFAULT_WORKSPACE_PLACEMENT,
  type ImplementationSnapshotWorkspacePaths,
  type PredictionWorkspacePaths,
  type WorkspaceDirectories,
  type WorkspaceMountMap,
  type WorkspacePaths,
  type WorkspacePlacementMap,
} from "./workspace-paths.js";

/**
 * Workspace location metadata that is injected into prompt templates.
 */
export interface RuntimeWorkspaceContext {
  invocationDir: string;
  workspaceDir: string;
  workspaceLinkPath: string;
  isLinkedWorkspace: boolean;
}

/**
 * Template variable keys reserved for runtime workspace context.
 */
export const WORKSPACE_CONTEXT_TEMPLATE_VAR_KEYS = [
  "invocationDir",
  "workspaceDir",
  "workspaceLinkPath",
  "isLinkedWorkspace",
  "workspaceDesignDir",
  "workspaceImplementationDir",
  "workspaceSpecsDir",
  "workspaceMigrationsDir",
  "workspacePredictionDir",
  "workspaceDesignPlacement",
  "workspaceImplementationPlacement",
  "workspaceSpecsPlacement",
  "workspaceMigrationsPlacement",
  "workspacePredictionPlacement",
  "workspaceDesignPath",
  "workspaceImplementationPath",
  "workspaceSpecsPath",
  "workspaceMigrationsPath",
  "workspacePredictionPath",
  "workspacePredictionLatestPath",
  "workspacePredictionSnapshotsRootPath",
  "workspacePredictionSnapshotsThreadsPath",
  "workspaceImplementationSnapshotsRootPath",
  "workspaceImplementationSnapshotsThreadsPath",
  "workspaceMountSummary",
] as const;

/**
 * Optional invocation/workspace metadata supplied by CLI command actions.
 */
export interface RuntimeWorkspaceContextInput {
  executionCwd: string;
  invocationDir?: string;
  workspaceDir?: string;
  workspaceLinkPath?: string;
  isLinkedWorkspace?: boolean;
}

/**
 * Resolves a deterministic invocation/workspace context for runtime template vars.
 */
export function resolveRuntimeWorkspaceContext(
  input: RuntimeWorkspaceContextInput,
  pathOperations: PathOperationsPort,
): RuntimeWorkspaceContext {
  const invocationDir = pathOperations.resolve(input.invocationDir ?? input.executionCwd);
  const resolvedWorkspaceDir = pathOperations.resolve(input.workspaceDir ?? input.executionCwd);
  const resolvedWorkspaceLinkPath = input.workspaceLinkPath
    ? (pathOperations.isAbsolute(input.workspaceLinkPath)
      ? pathOperations.resolve(input.workspaceLinkPath)
      : pathOperations.resolve(invocationDir, input.workspaceLinkPath))
    : "";
  const inferredLinkedWorkspace = invocationDir !== resolvedWorkspaceDir;
  const isLinkedWorkspace = input.isLinkedWorkspace ?? (inferredLinkedWorkspace || resolvedWorkspaceLinkPath.length > 0);
  const workspaceDir = isLinkedWorkspace ? resolvedWorkspaceDir : invocationDir;
  const workspaceLinkPath = isLinkedWorkspace && resolvedWorkspaceLinkPath
    ? resolvedWorkspaceLinkPath
    : "";

  return {
    invocationDir,
    workspaceDir,
    workspaceLinkPath,
    isLinkedWorkspace,
  };
}

/**
 * Converts workspace context values to stable prompt template variables.
 */
export function buildWorkspaceContextTemplateVars(
  context: RuntimeWorkspaceContext,
  workspace?: WorkspaceDirectories | {
    directories?: WorkspaceDirectories;
    placement?: WorkspacePlacementMap;
    paths?: WorkspacePaths;
    predictionPaths?: PredictionWorkspacePaths;
    implementationSnapshotPaths?: ImplementationSnapshotWorkspacePaths;
    mounts?: WorkspaceMountMap;
  },
): ExtraTemplateVars {
  const normalizedWorkspace = normalizeWorkspaceTemplateInput(workspace);
  const directories = normalizedWorkspace.directories ?? DEFAULT_WORKSPACE_DIRECTORIES;
  const placement = normalizedWorkspace.placement ?? DEFAULT_WORKSPACE_PLACEMENT;
  const paths = normalizedWorkspace.paths ?? {
    design: path.join(resolvePlacementRoot(context, placement.design), directories.design),
    implementation: path.join(resolvePlacementRoot(context, placement.implementation), directories.implementation),
    specs: path.join(resolvePlacementRoot(context, placement.specs), directories.specs),
    migrations: path.join(resolvePlacementRoot(context, placement.migrations), directories.migrations),
    prediction: path.join(resolvePlacementRoot(context, placement.prediction), directories.prediction),
  };
  const predictionPaths = normalizedWorkspace.predictionPaths ?? {
    latest: joinPreservingPathStyle(paths.prediction, "latest"),
    snapshotsRoot: joinPreservingPathStyle(paths.prediction, "snapshots", "root"),
    snapshotsThreads: joinPreservingPathStyle(paths.prediction, "snapshots", "threads"),
  };
  const implementationSnapshotPaths = normalizedWorkspace.implementationSnapshotPaths ?? {
    snapshotsRoot: joinPreservingPathStyle(paths.implementation, "snapshots", "root"),
    snapshotsThreads: joinPreservingPathStyle(paths.implementation, "snapshots", "threads"),
  };
  const workspaceMountSummary = JSON.stringify(buildWorkspaceMountSummary({
    context,
    paths,
    mounts: normalizedWorkspace.mounts,
  }));

  return {
    invocationDir: context.invocationDir,
    workspaceDir: context.workspaceDir,
    workspaceLinkPath: context.workspaceLinkPath,
    isLinkedWorkspace: context.isLinkedWorkspace ? "true" : "false",
    workspaceDesignDir: directories.design,
    workspaceImplementationDir: directories.implementation,
    workspaceSpecsDir: directories.specs,
    workspaceMigrationsDir: directories.migrations,
    workspacePredictionDir: directories.prediction,
    workspaceDesignPlacement: placement.design,
    workspaceImplementationPlacement: placement.implementation,
    workspaceSpecsPlacement: placement.specs,
    workspaceMigrationsPlacement: placement.migrations,
    workspacePredictionPlacement: placement.prediction,
    workspaceDesignPath: paths.design,
    workspaceImplementationPath: paths.implementation,
    workspaceSpecsPath: paths.specs,
    workspaceMigrationsPath: paths.migrations,
    workspacePredictionPath: paths.prediction,
    workspacePredictionLatestPath: predictionPaths.latest,
    workspacePredictionSnapshotsRootPath: predictionPaths.snapshotsRoot,
    workspacePredictionSnapshotsThreadsPath: predictionPaths.snapshotsThreads,
    workspaceImplementationSnapshotsRootPath: implementationSnapshotPaths.snapshotsRoot,
    workspaceImplementationSnapshotsThreadsPath: implementationSnapshotPaths.snapshotsThreads,
    workspaceMountSummary,
  };
}

function resolvePlacementRoot(
  context: RuntimeWorkspaceContext,
  placement: WorkspacePlacementMap[keyof WorkspacePlacementMap],
): string {
  return placement === "workdir" ? context.invocationDir : context.workspaceDir;
}

function normalizeWorkspaceTemplateInput(
  input: WorkspaceDirectories | {
    directories?: WorkspaceDirectories;
    placement?: WorkspacePlacementMap;
    paths?: WorkspacePaths;
    predictionPaths?: PredictionWorkspacePaths;
    implementationSnapshotPaths?: ImplementationSnapshotWorkspacePaths;
    mounts?: WorkspaceMountMap;
  } | undefined,
): {
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
  paths?: WorkspacePaths;
  predictionPaths?: PredictionWorkspacePaths;
  implementationSnapshotPaths?: ImplementationSnapshotWorkspacePaths;
  mounts?: WorkspaceMountMap;
} {
  if (!input) {
    return {};
  }

  if (isWorkspaceDirectories(input)) {
    return { directories: input };
  }

  return input;
}

function isWorkspaceDirectories(value: unknown): value is WorkspaceDirectories {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  if (!("design" in value) || !("implementation" in value) || !("specs" in value) || !("migrations" in value) || !("prediction" in value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.design === "string"
    && typeof record.implementation === "string"
    && typeof record.specs === "string"
    && typeof record.migrations === "string"
    && typeof record.prediction === "string";
}

function buildWorkspaceMountSummary(input: {
  context: RuntimeWorkspaceContext;
  paths: WorkspacePaths;
  mounts?: WorkspaceMountMap;
}): {
  invocationDir: string;
  workspaceDir: string;
  isLinkedWorkspace: boolean;
  mounts: Array<{
    logicalPath: string;
    absoluteTargetPath: string;
    source: "legacy" | "explicit";
  }>;
} {
  const { context, paths } = input;
  const mounts = input.mounts ?? {
    design: {
      logicalPath: "design",
      absoluteTargetPath: paths.design,
      source: "legacy",
    },
    implementation: {
      logicalPath: "implementation",
      absoluteTargetPath: paths.implementation,
      source: "legacy",
    },
    specs: {
      logicalPath: "specs",
      absoluteTargetPath: paths.specs,
      source: "legacy",
    },
    migrations: {
      logicalPath: "migrations",
      absoluteTargetPath: paths.migrations,
      source: "legacy",
    },
    prediction: {
      logicalPath: "prediction",
      absoluteTargetPath: paths.prediction,
      source: "legacy",
    },
  } satisfies WorkspaceMountMap;

  const sortedMounts = Object.values(mounts)
    .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath))
    .map((mount) => ({
      logicalPath: mount.logicalPath,
      absoluteTargetPath: mount.absoluteTargetPath,
      source: mount.source,
    }));

  return {
    invocationDir: context.invocationDir,
    workspaceDir: context.workspaceDir,
    isLinkedWorkspace: context.isLinkedWorkspace,
    mounts: sortedMounts,
  };
}

function joinPreservingPathStyle(basePath: string, ...segments: string[]): string {
  if (basePath.includes("/") && !basePath.includes("\\")) {
    return path.posix.join(basePath, ...segments);
  }

  return path.join(basePath, ...segments);
}

/**
 * Merges vars while preserving authoritative runtime workspace context keys.
 */
export function mergeTemplateVarsWithWorkspaceContext(
  fileTemplateVars: ExtraTemplateVars,
  cliTemplateVars: ExtraTemplateVars,
  workspaceContextTemplateVars: ExtraTemplateVars,
): ExtraTemplateVars {
  const merged: ExtraTemplateVars = {
    ...fileTemplateVars,
    ...cliTemplateVars,
  };

  for (const key of WORKSPACE_CONTEXT_TEMPLATE_VAR_KEYS) {
    const value = workspaceContextTemplateVars[key];
    if (typeof value === "string") {
      merged[key] = value;
    }
  }

  return merged;
}
