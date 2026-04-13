import path from "node:path";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { PathOperationsPort } from "../domain/ports/index.js";
import {
  DEFAULT_PREDICTION_WORKSPACE_DIRECTORIES,
  type PredictionWorkspaceDirectories,
} from "./prediction-workspace-paths.js";

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
  "workspaceDesignPath",
  "workspaceSpecsPath",
  "workspaceMigrationsPath",
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
  predictionWorkspaceDirectories: PredictionWorkspaceDirectories = DEFAULT_PREDICTION_WORKSPACE_DIRECTORIES,
): ExtraTemplateVars {
  return {
    invocationDir: context.invocationDir,
    workspaceDir: context.workspaceDir,
    workspaceLinkPath: context.workspaceLinkPath,
    isLinkedWorkspace: context.isLinkedWorkspace ? "true" : "false",
    workspaceDesignDir: predictionWorkspaceDirectories.design,
    workspaceSpecsDir: predictionWorkspaceDirectories.specs,
    workspaceMigrationsDir: predictionWorkspaceDirectories.migrations,
    workspaceDesignPath: path.join(context.workspaceDir, predictionWorkspaceDirectories.design),
    workspaceSpecsPath: path.join(context.workspaceDir, predictionWorkspaceDirectories.specs),
    workspaceMigrationsPath: path.join(context.workspaceDir, predictionWorkspaceDirectories.migrations),
  };
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
