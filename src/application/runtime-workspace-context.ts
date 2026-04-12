import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { PathOperationsPort } from "../domain/ports/index.js";

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
  const inferredLinkedWorkspace = invocationDir !== resolvedWorkspaceDir;
  const isLinkedWorkspace = input.isLinkedWorkspace ?? inferredLinkedWorkspace;
  const workspaceDir = isLinkedWorkspace ? resolvedWorkspaceDir : invocationDir;
  const workspaceLinkPath = isLinkedWorkspace && input.workspaceLinkPath
    ? pathOperations.resolve(input.workspaceLinkPath)
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
): ExtraTemplateVars {
  return {
    invocationDir: context.invocationDir,
    workspaceDir: context.workspaceDir,
    workspaceLinkPath: context.workspaceLinkPath,
    isLinkedWorkspace: context.isLinkedWorkspace ? "true" : "false",
  };
}
