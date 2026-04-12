import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceContextTemplateVars,
  mergeTemplateVarsWithWorkspaceContext,
  resolveRuntimeWorkspaceContext,
} from "../../src/application/runtime-workspace-context.js";
import { createNodePathOperationsAdapter } from "../../src/infrastructure/adapters/node-path-operations-adapter.js";

describe("resolveRuntimeWorkspaceContext", () => {
  const pathOperations = createNodePathOperationsAdapter();

  it("uses non-linked fallback values when link mode is inactive", () => {
    const context = resolveRuntimeWorkspaceContext(
      {
        executionCwd: "/workspace/invocation",
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/other",
        workspaceLinkPath: ".rundown/workspace.link",
        isLinkedWorkspace: false,
      },
      pathOperations,
    );

    expect(context).toEqual({
      invocationDir: path.resolve("/workspace/invocation"),
      workspaceDir: path.resolve("/workspace/invocation"),
      workspaceLinkPath: "",
      isLinkedWorkspace: false,
    });
  });

  it("resolves linked workspace values when link mode is active", () => {
    const context = resolveRuntimeWorkspaceContext(
      {
        executionCwd: "/workspace/linked",
        invocationDir: "/workspace/linked",
        workspaceDir: "/workspace/real",
        workspaceLinkPath: "/workspace/linked/.rundown/workspace.link",
        isLinkedWorkspace: true,
      },
      pathOperations,
    );

    expect(context).toEqual({
      invocationDir: path.resolve("/workspace/linked"),
      workspaceDir: path.resolve("/workspace/real"),
      workspaceLinkPath: path.resolve("/workspace/linked/.rundown/workspace.link"),
      isLinkedWorkspace: true,
    });
  });

  it("marks linked mode active when workspace.link path is provided", () => {
    const context = resolveRuntimeWorkspaceContext(
      {
        executionCwd: "/workspace/linked",
        invocationDir: "/workspace/linked",
        workspaceDir: "/workspace/linked",
        workspaceLinkPath: "./.rundown/workspace.link",
      },
      pathOperations,
    );

    expect(context).toEqual({
      invocationDir: path.resolve("/workspace/linked"),
      workspaceDir: path.resolve("/workspace/linked"),
      workspaceLinkPath: path.resolve("/workspace/linked/.rundown/workspace.link"),
      isLinkedWorkspace: true,
    });
  });

  it("normalizes invocation/workspace/link paths to absolute values", () => {
    const context = resolveRuntimeWorkspaceContext(
      {
        executionCwd: "/workspace/exec",
        invocationDir: "/workspace/linked/./nested/..",
        workspaceDir: "/workspace/real/./src/..",
        workspaceLinkPath: "./.rundown/../.rundown/workspace.link",
        isLinkedWorkspace: true,
      },
      pathOperations,
    );

    expect(context).toEqual({
      invocationDir: path.resolve("/workspace/linked"),
      workspaceDir: path.resolve("/workspace/real"),
      workspaceLinkPath: path.resolve("/workspace/linked/.rundown/workspace.link"),
      isLinkedWorkspace: true,
    });
  });
});

describe("buildWorkspaceContextTemplateVars", () => {
  it("always emits all fallback template variables", () => {
    expect(buildWorkspaceContextTemplateVars({
      invocationDir: "/workspace/invocation",
      workspaceDir: "/workspace/invocation",
      workspaceLinkPath: "",
      isLinkedWorkspace: false,
    })).toEqual({
      invocationDir: "/workspace/invocation",
      workspaceDir: "/workspace/invocation",
      workspaceLinkPath: "",
      isLinkedWorkspace: "false",
    });
  });
});

describe("mergeTemplateVarsWithWorkspaceContext", () => {
  it("does not allow file or CLI vars to override workspace context keys", () => {
    const merged = mergeTemplateVarsWithWorkspaceContext(
      {
        invocationDir: "/fake/file/invocation",
        workspaceDir: "/fake/file/workspace",
        workspaceLinkPath: "/fake/file/workspace.link",
        isLinkedWorkspace: "false",
        source: "file",
      },
      {
        invocationDir: "/fake/cli/invocation",
        workspaceDir: "/fake/cli/workspace",
        workspaceLinkPath: "/fake/cli/workspace.link",
        isLinkedWorkspace: "false",
        source: "cli",
      },
      {
        invocationDir: "/real/invocation",
        workspaceDir: "/real/workspace",
        workspaceLinkPath: "/real/.rundown/workspace.link",
        isLinkedWorkspace: "true",
      },
    );

    expect(merged).toEqual({
      invocationDir: "/real/invocation",
      workspaceDir: "/real/workspace",
      workspaceLinkPath: "/real/.rundown/workspace.link",
      isLinkedWorkspace: "true",
      source: "cli",
    });
  });

  it("keeps file and CLI precedence for non-protected template vars", () => {
    const merged = mergeTemplateVarsWithWorkspaceContext(
      {
        mode: "file",
        shared: "file",
      },
      {
        shared: "cli",
        cliOnly: "yes",
      },
      {
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/invocation",
        workspaceLinkPath: "",
        isLinkedWorkspace: "false",
      },
    );

    expect(merged).toEqual({
      mode: "file",
      shared: "cli",
      cliOnly: "yes",
      invocationDir: "/workspace/invocation",
      workspaceDir: "/workspace/invocation",
      workspaceLinkPath: "",
      isLinkedWorkspace: "false",
    });
  });
});
