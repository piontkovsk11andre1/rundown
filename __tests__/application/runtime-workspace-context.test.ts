import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceContextTemplateVars,
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
