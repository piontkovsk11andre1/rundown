import { CONFIG_DIR_NAME } from "./ports/config-dir-port.js";
import type { FileSystem } from "./ports/file-system.js";
import type { PathOperationsPort } from "./ports/path-operations-port.js";

export const WORKSPACE_LINK_FILE_NAME = "workspace.link";
export const WORKSPACE_LINK_RELATIVE_PATH = `${CONFIG_DIR_NAME}/${WORKSPACE_LINK_FILE_NAME}`;

export type WorkspaceLinkInvalidReason =
  | "empty"
  | "absolute"
  | "target-missing"
  | "target-not-directory";

export type WorkspaceLinkResolution =
  | {
    status: "absent";
    linkPath: string;
  }
  | {
    status: "invalid";
    linkPath: string;
    relativeTarget: string;
    reason: WorkspaceLinkInvalidReason;
  }
  | {
    status: "resolved";
    linkPath: string;
    relativeTarget: string;
    workspaceRoot: string;
  };

export interface ResolveWorkspaceLinkInput {
  currentDir: string;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
}

export interface ResolveEffectiveWorkspaceRootInput extends ResolveWorkspaceLinkInput {
  maxHops?: number;
}

/**
 * Resolves a linked workspace root from `.rundown/workspace.link`.
 *
 * The link file stores a relative path from the invocation directory
 * (`currentDir`) to the intended workspace root.
 */
export function resolveWorkspaceLink(input: ResolveWorkspaceLinkInput): WorkspaceLinkResolution {
  const currentDir = input.pathOperations.resolve(input.currentDir);
  const linkPath = input.pathOperations.join(currentDir, CONFIG_DIR_NAME, WORKSPACE_LINK_FILE_NAME);
  const linkStats = input.fileSystem.stat(linkPath);

  if (linkStats === null || !linkStats.isFile) {
    return {
      status: "absent",
      linkPath,
    };
  }

  const relativeTarget = input.fileSystem.readText(linkPath).trim();
  if (relativeTarget.length === 0) {
    return {
      status: "invalid",
      linkPath,
      relativeTarget,
      reason: "empty",
    };
  }

  if (input.pathOperations.isAbsolute(relativeTarget)) {
    return {
      status: "invalid",
      linkPath,
      relativeTarget,
      reason: "absolute",
    };
  }

  const workspaceRoot = input.pathOperations.resolve(currentDir, relativeTarget);
  const workspaceStats = input.fileSystem.stat(workspaceRoot);
  if (workspaceStats === null) {
    return {
      status: "invalid",
      linkPath,
      relativeTarget,
      reason: "target-missing",
    };
  }

  if (!workspaceStats.isDirectory) {
    return {
      status: "invalid",
      linkPath,
      relativeTarget,
      reason: "target-not-directory",
    };
  }

  return {
    status: "resolved",
    linkPath,
    relativeTarget,
    workspaceRoot,
  };
}

/**
 * Resolves the effective workspace root by following workspace.link chains.
 *
 * If the initial directory is not linked (or the link is invalid), this returns
 * the normalized current directory. When links chain through multiple
 * workspaces, traversal stops at the first directory without a valid link.
 */
export function resolveEffectiveWorkspaceRoot(input: ResolveEffectiveWorkspaceRootInput): string {
  const maxHops = Math.max(1, input.maxHops ?? 32);
  let workspaceRoot = input.pathOperations.resolve(input.currentDir);
  const visited = new Set<string>([workspaceRoot]);

  for (let hop = 0; hop < maxHops; hop += 1) {
    const resolution = resolveWorkspaceLink({
      currentDir: workspaceRoot,
      fileSystem: input.fileSystem,
      pathOperations: input.pathOperations,
    });

    if (resolution.status !== "resolved") {
      return workspaceRoot;
    }

    const nextWorkspaceRoot = input.pathOperations.resolve(resolution.workspaceRoot);
    if (visited.has(nextWorkspaceRoot)) {
      return workspaceRoot;
    }

    visited.add(nextWorkspaceRoot);
    workspaceRoot = nextWorkspaceRoot;
  }

  return workspaceRoot;
}
