import path from "node:path";
import {
  parseWorkspaceLinkSchema,
  resolveEffectiveWorkspaceRoot,
  resolveWorkspaceLink,
} from "../domain/workspace-link.js";
import type { FileSystem } from "../domain/ports/index.js";

export type WorkspaceSelectionResult =
  | {
    ok: true;
    workspaceRoot: string;
    executionContext: {
      invocationDir: string;
      workspaceDir: string;
      workspaceLinkPath: string;
      isLinkedWorkspace: boolean;
    };
  }
  | {
    ok: false;
    message: string;
  };

export function resolveWorkspaceRootForPathSensitiveCommand(input: {
  fileSystem: FileSystem;
  invocationDir: string;
  workspaceOption?: string;
}): WorkspaceSelectionResult {
  const invocationDir = path.resolve(input.invocationDir);
  const invocationWorkspaceLinkPath = resolveWorkspaceLinkPathForInvocation(input.fileSystem, invocationDir);

  if (typeof input.workspaceOption === "string" && input.workspaceOption.trim().length > 0) {
    const selectedWorkspaceDir = path.resolve(invocationDir, input.workspaceOption);
    const selectedWorkspaceStat = input.fileSystem.stat(selectedWorkspaceDir);
    if (selectedWorkspaceStat === null) {
      return {
        ok: false,
        message: `Selected workspace does not exist: ${selectedWorkspaceDir}`,
      };
    }

    if (!selectedWorkspaceStat.isDirectory) {
      return {
        ok: false,
        message: `Selected workspace is not a directory: ${selectedWorkspaceDir}`,
      };
    }

    const workspaceRoot = resolveEffectiveWorkspaceRoot({
      currentDir: selectedWorkspaceDir,
      fileSystem: input.fileSystem,
      pathOperations: path,
    });

    return {
      ok: true,
      workspaceRoot,
      executionContext: {
        invocationDir,
        workspaceDir: workspaceRoot,
        workspaceLinkPath: invocationWorkspaceLinkPath,
        isLinkedWorkspace: invocationDir !== workspaceRoot || invocationWorkspaceLinkPath.length > 0,
      },
    };
  }

  const workspaceLinkResolution = resolveWorkspaceLink({
    currentDir: invocationDir,
    fileSystem: input.fileSystem,
    pathOperations: path,
  });

  if (workspaceLinkResolution.status === "invalid") {
    if (workspaceLinkResolution.reason === "ambiguous") {
      return {
        ok: false,
        message: buildAmbiguousWorkspaceSelectionMessage({
          fileSystem: input.fileSystem,
          invocationDir,
          workspaceLinkPath: workspaceLinkResolution.linkPath,
        }),
      };
    }

    return {
      ok: false,
      message: buildInvalidWorkspaceLinkMessage(workspaceLinkResolution),
    };
  }

  const workspaceRoot = resolveEffectiveWorkspaceRoot({
    currentDir: invocationDir,
    fileSystem: input.fileSystem,
    pathOperations: path,
  });

  return {
    ok: true,
    workspaceRoot,
    executionContext: {
      invocationDir,
      workspaceDir: workspaceRoot,
      workspaceLinkPath: workspaceLinkResolution.status === "resolved"
        ? path.resolve(workspaceLinkResolution.linkPath)
        : invocationWorkspaceLinkPath,
      isLinkedWorkspace: invocationDir !== workspaceRoot || invocationWorkspaceLinkPath.length > 0,
    },
  };
}

function resolveWorkspaceLinkPathForInvocation(fileSystem: FileSystem, invocationDir: string): string {
  const candidateLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
  const candidateLinkStats = fileSystem.stat(candidateLinkPath);
  return candidateLinkStats?.isFile ? candidateLinkPath : "";
}

function buildAmbiguousWorkspaceSelectionMessage(input: {
  fileSystem: FileSystem;
  invocationDir: string;
  workspaceLinkPath: string;
}): string {
  const { fileSystem, invocationDir, workspaceLinkPath } = input;
  const parsedSchema = parseWorkspaceLinkSchema(fileSystem.readText(workspaceLinkPath));
  if (parsedSchema.status !== "ok") {
    return [
      `Workspace selection is ambiguous for ${invocationDir}.`,
      `workspace.link is invalid: ${workspaceLinkPath}.`,
      "Provide --workspace <dir> to select the workspace explicitly.",
    ].join("\n");
  }

  const candidates = parsedSchema.schema.records
    .map((record) => {
      const absoluteWorkspacePath = path.resolve(invocationDir, record.workspacePath);
      return `- ${record.id}: ${absoluteWorkspacePath} (use --workspace ${record.workspacePath})`;
    })
    .join("\n");

  return [
    `Workspace selection is ambiguous for ${invocationDir}.`,
    `Multiple workspace records are configured in ${workspaceLinkPath} and no default is defined.`,
    "Re-run the command with --workspace <dir> to select the workspace explicitly.",
    "Candidates:",
    candidates,
  ].join("\n");
}

function buildInvalidWorkspaceLinkMessage(input: {
  linkPath: string;
  relativeTarget: string;
  reason: "empty" | "absolute" | "malformed" | "ambiguous" | "target-missing" | "target-not-directory";
}): string {
  if (input.reason === "target-missing") {
    return [
      `workspace.link target does not exist: ${input.relativeTarget}`,
      `Link file: ${input.linkPath}`,
      "Fix the link metadata or provide --workspace <dir> to override workspace selection.",
    ].join("\n");
  }

  if (input.reason === "target-not-directory") {
    return [
      `workspace.link target is not a directory: ${input.relativeTarget}`,
      `Link file: ${input.linkPath}`,
      "Fix the link metadata or provide --workspace <dir> to override workspace selection.",
    ].join("\n");
  }

  if (input.reason === "empty") {
    return [
      `workspace.link is empty: ${input.linkPath}`,
      "Fix the link metadata or provide --workspace <dir> to override workspace selection.",
    ].join("\n");
  }

  if (input.reason === "absolute") {
    return [
      `workspace.link contains an absolute workspace path: ${input.linkPath}`,
      "Fix the link metadata or provide --workspace <dir> to override workspace selection.",
    ].join("\n");
  }

  return [
    `workspace.link is malformed: ${input.linkPath}`,
    "Fix the link metadata or provide --workspace <dir> to override workspace selection.",
  ].join("\n");
}
