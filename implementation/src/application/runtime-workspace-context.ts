import path from "node:path";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { PathOperationsPort } from "../domain/ports/index.js";
import {
  DEFAULT_WORKSPACE_DIRECTORIES,
  DEFAULT_WORKSPACE_PLACEMENT,
  type WorkspaceDirectories,
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
  "workspaceSpecsDir",
  "workspaceMigrationsDir",
  "workspacePredictionDir",
  "workspaceDesignPlacement",
  "workspaceSpecsPlacement",
  "workspaceMigrationsPlacement",
  "workspacePredictionPlacement",
  "workspaceDesignPath",
  "workspaceSpecsPath",
  "workspaceMigrationsPath",
  "workspacePredictionPath",
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
  },
): ExtraTemplateVars {
  const normalizedWorkspace = normalizeWorkspaceTemplateInput(workspace);
  const directories = normalizedWorkspace.directories ?? DEFAULT_WORKSPACE_DIRECTORIES;
  const placement = normalizedWorkspace.placement ?? DEFAULT_WORKSPACE_PLACEMENT;
  const paths = normalizedWorkspace.paths ?? {
    design: path.join(resolvePlacementRoot(context, placement.design), directories.design),
    specs: path.join(resolvePlacementRoot(context, placement.specs), directories.specs),
    migrations: path.join(resolvePlacementRoot(context, placement.migrations), directories.migrations),
    prediction: path.join(resolvePlacementRoot(context, placement.prediction), directories.prediction),
  };

  return {
    invocationDir: context.invocationDir,
    workspaceDir: context.workspaceDir,
    workspaceLinkPath: context.workspaceLinkPath,
    isLinkedWorkspace: context.isLinkedWorkspace ? "true" : "false",
    workspaceDesignDir: directories.design,
    workspaceSpecsDir: directories.specs,
    workspaceMigrationsDir: directories.migrations,
    workspacePredictionDir: directories.prediction,
    workspaceDesignPlacement: placement.design,
    workspaceSpecsPlacement: placement.specs,
    workspaceMigrationsPlacement: placement.migrations,
    workspacePredictionPlacement: placement.prediction,
    workspaceDesignPath: paths.design,
    workspaceSpecsPath: paths.specs,
    workspaceMigrationsPath: paths.migrations,
    workspacePredictionPath: paths.prediction,
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
  } | undefined,
): {
  directories?: WorkspaceDirectories;
  placement?: WorkspacePlacementMap;
  paths?: WorkspacePaths;
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

  if (!("design" in value) || !("specs" in value) || !("migrations" in value) || !("prediction" in value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return typeof record.design === "string"
    && typeof record.specs === "string"
    && typeof record.migrations === "string"
    && typeof record.prediction === "string";
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
