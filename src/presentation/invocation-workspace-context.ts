import { resolveWorkspaceLink } from "../domain/workspace-link.js";
import { createNodeFileSystem } from "../infrastructure/adapters/fs-file-system.js";
import { createNodePathOperationsAdapter } from "../infrastructure/adapters/node-path-operations-adapter.js";

export interface InvocationWorkspaceContext {
  invocationDir: string;
  workspaceDir: string;
  workspaceLinkPath: string;
  isLinkedWorkspace: boolean;
}

/**
 * Resolves invocation/workspace directory context once per CLI invocation.
 */
export function resolveInvocationWorkspaceContext(cwd: string = process.cwd()): InvocationWorkspaceContext {
  const fileSystem = createNodeFileSystem();
  const pathOperations = createNodePathOperationsAdapter();
  const invocationDir = pathOperations.resolve(cwd);
  const resolution = resolveWorkspaceLink({
    currentDir: invocationDir,
    fileSystem,
    pathOperations,
  });

  if (resolution.status === "resolved") {
    return {
      invocationDir,
      workspaceDir: resolution.workspaceRoot,
      workspaceLinkPath: resolution.linkPath,
      isLinkedWorkspace: true,
    };
  }

  return createNonLinkedWorkspaceContext(invocationDir);
}

function createNonLinkedWorkspaceContext(invocationDir: string): InvocationWorkspaceContext {
  return {
    invocationDir,
    workspaceDir: invocationDir,
    workspaceLinkPath: "",
    isLinkedWorkspace: false,
  };
}
