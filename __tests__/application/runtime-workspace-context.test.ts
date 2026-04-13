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

  it("uses deterministic non-linked fallback values for stale-link style inputs", () => {
    const context = resolveRuntimeWorkspaceContext(
      {
        executionCwd: "/workspace/invocation",
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/stale-target",
        workspaceLinkPath: "/workspace/invocation/.rundown/workspace.link",
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
      workspaceDesignDir: "design",
      workspaceSpecsDir: "specs",
      workspaceMigrationsDir: "migrations",
      workspaceDesignPath: path.join("/workspace/invocation", "design"),
      workspaceSpecsPath: path.join("/workspace/invocation", "specs"),
      workspaceMigrationsPath: path.join("/workspace/invocation", "migrations"),
    });
  });

  it("emits configured prediction workspace directory variables", () => {
    expect(buildWorkspaceContextTemplateVars(
      {
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/source",
        workspaceLinkPath: "/workspace/invocation/.rundown/workspace.link",
        isLinkedWorkspace: true,
      },
      {
        design: "docs/design",
        specs: "quality/specs",
        migrations: "changesets",
      },
    )).toEqual({
      invocationDir: "/workspace/invocation",
      workspaceDir: "/workspace/source",
      workspaceLinkPath: "/workspace/invocation/.rundown/workspace.link",
      isLinkedWorkspace: "true",
      workspaceDesignDir: "docs/design",
      workspaceSpecsDir: "quality/specs",
      workspaceMigrationsDir: "changesets",
      workspaceDesignPath: path.join("/workspace/source", "docs/design"),
      workspaceSpecsPath: path.join("/workspace/source", "quality/specs"),
      workspaceMigrationsPath: path.join("/workspace/source", "changesets"),
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
        workspaceDesignDir: "design-docs",
        workspaceSpecsDir: "quality/specs",
        workspaceMigrationsDir: "changesets",
        workspaceDesignPath: "/real/workspace/design-docs",
        workspaceSpecsPath: "/real/workspace/quality/specs",
        workspaceMigrationsPath: "/real/workspace/changesets",
      },
    );

    expect(merged).toEqual({
      invocationDir: "/real/invocation",
      workspaceDir: "/real/workspace",
      workspaceLinkPath: "/real/.rundown/workspace.link",
      isLinkedWorkspace: "true",
      workspaceDesignDir: "design-docs",
      workspaceSpecsDir: "quality/specs",
      workspaceMigrationsDir: "changesets",
      workspaceDesignPath: "/real/workspace/design-docs",
      workspaceSpecsPath: "/real/workspace/quality/specs",
      workspaceMigrationsPath: "/real/workspace/changesets",
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
        workspaceDesignDir: "design",
        workspaceSpecsDir: "specs",
        workspaceMigrationsDir: "migrations",
        workspaceDesignPath: "/workspace/invocation/design",
        workspaceSpecsPath: "/workspace/invocation/specs",
        workspaceMigrationsPath: "/workspace/invocation/migrations",
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
      workspaceDesignDir: "design",
      workspaceSpecsDir: "specs",
      workspaceMigrationsDir: "migrations",
      workspaceDesignPath: "/workspace/invocation/design",
      workspaceSpecsPath: "/workspace/invocation/specs",
      workspaceMigrationsPath: "/workspace/invocation/migrations",
    });
  });
});
