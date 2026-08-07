import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildWorkspaceContextTemplateVars,
  mergeTemplateVarsWithWorkspaceContext,
  resolveRuntimeWorkspaceContext,
} from "../../src/application/runtime-workspace-context.js";
import { createNodePathOperationsAdapter } from "../../src/infrastructure/adapters/node-path-operations-adapter.js";

function buildMountSummary(params: {
  invocationDir: string;
  workspaceDir: string;
  isLinkedWorkspace: boolean;
  designPath: string;
  implementationPath: string;
  specsPath: string;
  migrationsPath: string;
  predictionPath: string;
}): string {
  return JSON.stringify({
    invocationDir: params.invocationDir,
    workspaceDir: params.workspaceDir,
    isLinkedWorkspace: params.isLinkedWorkspace,
    mounts: [
      {
        logicalPath: "design",
        absoluteTargetPath: params.designPath,
        source: "legacy",
      },
      {
        logicalPath: "implementation",
        absoluteTargetPath: params.implementationPath,
        source: "legacy",
      },
      {
        logicalPath: "migrations",
        absoluteTargetPath: params.migrationsPath,
        source: "legacy",
      },
      {
        logicalPath: "prediction",
        absoluteTargetPath: params.predictionPath,
        source: "legacy",
      },
      {
        logicalPath: "specs",
        absoluteTargetPath: params.specsPath,
        source: "legacy",
      },
    ],
  });
}

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
      workspaceImplementationDir: "implementation",
      workspaceSpecsDir: "specs",
      workspaceMigrationsDir: "migrations",
      workspacePredictionDir: "prediction",
      workspaceDesignPlacement: "sourcedir",
      workspaceImplementationPlacement: "sourcedir",
      workspaceSpecsPlacement: "sourcedir",
      workspaceMigrationsPlacement: "sourcedir",
      workspacePredictionPlacement: "sourcedir",
      workspaceDesignPath: path.join("/workspace/invocation", "design"),
      workspaceImplementationPath: path.join("/workspace/invocation", "implementation"),
      workspaceSpecsPath: path.join("/workspace/invocation", "specs"),
      workspaceMigrationsPath: path.join("/workspace/invocation", "migrations"),
      workspacePredictionPath: path.join("/workspace/invocation", "prediction"),
      workspacePredictionLatestPath: path.join("/workspace/invocation", "prediction", "latest"),
      workspacePredictionSnapshotsRootPath: path.join("/workspace/invocation", "prediction", "snapshots", "root"),
      workspacePredictionSnapshotsThreadsPath: path.join("/workspace/invocation", "prediction", "snapshots", "threads"),
      workspaceImplementationSnapshotsRootPath: path.join("/workspace/invocation", "implementation", "snapshots", "root"),
      workspaceImplementationSnapshotsThreadsPath: path.join("/workspace/invocation", "implementation", "snapshots", "threads"),
      workspaceMountSummary: buildMountSummary({
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/invocation",
        isLinkedWorkspace: false,
        designPath: path.join("/workspace/invocation", "design"),
        implementationPath: path.join("/workspace/invocation", "implementation"),
        specsPath: path.join("/workspace/invocation", "specs"),
        migrationsPath: path.join("/workspace/invocation", "migrations"),
        predictionPath: path.join("/workspace/invocation", "prediction"),
      }),
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
        implementation: "source/implementation",
        specs: "quality/specs",
        migrations: "changesets",
        prediction: "predicted",
      },
    )).toEqual({
      invocationDir: "/workspace/invocation",
      workspaceDir: "/workspace/source",
      workspaceLinkPath: "/workspace/invocation/.rundown/workspace.link",
      isLinkedWorkspace: "true",
      workspaceDesignDir: "docs/design",
      workspaceImplementationDir: "source/implementation",
      workspaceSpecsDir: "quality/specs",
      workspaceMigrationsDir: "changesets",
      workspacePredictionDir: "predicted",
      workspaceDesignPlacement: "sourcedir",
      workspaceImplementationPlacement: "sourcedir",
      workspaceSpecsPlacement: "sourcedir",
      workspaceMigrationsPlacement: "sourcedir",
      workspacePredictionPlacement: "sourcedir",
      workspaceDesignPath: path.join("/workspace/source", "docs/design"),
      workspaceImplementationPath: path.join("/workspace/source", "source/implementation"),
      workspaceSpecsPath: path.join("/workspace/source", "quality/specs"),
      workspaceMigrationsPath: path.join("/workspace/source", "changesets"),
      workspacePredictionPath: path.join("/workspace/source", "predicted"),
      workspacePredictionLatestPath: path.join("/workspace/source", "predicted", "latest"),
      workspacePredictionSnapshotsRootPath: path.join("/workspace/source", "predicted", "snapshots", "root"),
      workspacePredictionSnapshotsThreadsPath: path.join("/workspace/source", "predicted", "snapshots", "threads"),
      workspaceImplementationSnapshotsRootPath: path.join("/workspace/source", "source/implementation", "snapshots", "root"),
      workspaceImplementationSnapshotsThreadsPath: path.join("/workspace/source", "source/implementation", "snapshots", "threads"),
      workspaceMountSummary: buildMountSummary({
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/source",
        isLinkedWorkspace: true,
        designPath: path.join("/workspace/source", "docs/design"),
        implementationPath: path.join("/workspace/source", "source/implementation"),
        specsPath: path.join("/workspace/source", "quality/specs"),
        migrationsPath: path.join("/workspace/source", "changesets"),
        predictionPath: path.join("/workspace/source", "predicted"),
      }),
    });
  });

  it("emits configured placement and explicit bucket paths", () => {
    expect(buildWorkspaceContextTemplateVars(
      {
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/source",
        workspaceLinkPath: "/workspace/invocation/.rundown/workspace.link",
        isLinkedWorkspace: true,
      },
      {
        directories: {
          design: "design-docs",
          implementation: "implementation-src",
          specs: "quality/specs",
          migrations: "changesets",
          prediction: "predicted",
        },
        placement: {
          design: "sourcedir",
          implementation: "workdir",
          specs: "workdir",
          migrations: "workdir",
          prediction: "workdir",
        },
        paths: {
          design: "/workspace/source/design-docs",
          implementation: "/workspace/invocation/implementation-src",
          specs: "/workspace/invocation/quality/specs",
          migrations: "/workspace/invocation/changesets",
          prediction: "/workspace/invocation/predicted",
        },
      },
    )).toEqual({
      invocationDir: "/workspace/invocation",
      workspaceDir: "/workspace/source",
      workspaceLinkPath: "/workspace/invocation/.rundown/workspace.link",
      isLinkedWorkspace: "true",
      workspaceDesignDir: "design-docs",
      workspaceImplementationDir: "implementation-src",
      workspaceSpecsDir: "quality/specs",
      workspaceMigrationsDir: "changesets",
      workspacePredictionDir: "predicted",
      workspaceDesignPlacement: "sourcedir",
      workspaceImplementationPlacement: "workdir",
      workspaceSpecsPlacement: "workdir",
      workspaceMigrationsPlacement: "workdir",
      workspacePredictionPlacement: "workdir",
      workspaceDesignPath: "/workspace/source/design-docs",
      workspaceImplementationPath: "/workspace/invocation/implementation-src",
      workspaceSpecsPath: "/workspace/invocation/quality/specs",
      workspaceMigrationsPath: "/workspace/invocation/changesets",
      workspacePredictionPath: "/workspace/invocation/predicted",
      workspacePredictionLatestPath: "/workspace/invocation/predicted/latest",
      workspacePredictionSnapshotsRootPath: "/workspace/invocation/predicted/snapshots/root",
      workspacePredictionSnapshotsThreadsPath: "/workspace/invocation/predicted/snapshots/threads",
      workspaceImplementationSnapshotsRootPath: "/workspace/invocation/implementation-src/snapshots/root",
      workspaceImplementationSnapshotsThreadsPath: "/workspace/invocation/implementation-src/snapshots/threads",
      workspaceMountSummary: buildMountSummary({
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/source",
        isLinkedWorkspace: true,
        designPath: "/workspace/source/design-docs",
        implementationPath: "/workspace/invocation/implementation-src",
        specsPath: "/workspace/invocation/quality/specs",
        migrationsPath: "/workspace/invocation/changesets",
        predictionPath: "/workspace/invocation/predicted",
      }),
    });
  });

  it("derives fallback bucket paths from placement roots", () => {
    expect(buildWorkspaceContextTemplateVars(
      {
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/source",
        workspaceLinkPath: "/workspace/invocation/.rundown/workspace.link",
        isLinkedWorkspace: true,
      },
      {
        directories: {
          design: "design-docs",
          implementation: "implementation-src",
          specs: "quality/specs",
          migrations: "changesets",
          prediction: "predicted",
        },
        placement: {
          design: "sourcedir",
          implementation: "workdir",
          specs: "workdir",
          migrations: "workdir",
          prediction: "workdir",
        },
      },
    )).toEqual({
      invocationDir: "/workspace/invocation",
      workspaceDir: "/workspace/source",
      workspaceLinkPath: "/workspace/invocation/.rundown/workspace.link",
      isLinkedWorkspace: "true",
      workspaceDesignDir: "design-docs",
      workspaceImplementationDir: "implementation-src",
      workspaceSpecsDir: "quality/specs",
      workspaceMigrationsDir: "changesets",
      workspacePredictionDir: "predicted",
      workspaceDesignPlacement: "sourcedir",
      workspaceImplementationPlacement: "workdir",
      workspaceSpecsPlacement: "workdir",
      workspaceMigrationsPlacement: "workdir",
      workspacePredictionPlacement: "workdir",
      workspaceDesignPath: path.join("/workspace/source", "design-docs"),
      workspaceImplementationPath: path.join("/workspace/invocation", "implementation-src"),
      workspaceSpecsPath: path.join("/workspace/invocation", "quality/specs"),
      workspaceMigrationsPath: path.join("/workspace/invocation", "changesets"),
      workspacePredictionPath: path.join("/workspace/invocation", "predicted"),
      workspacePredictionLatestPath: path.join("/workspace/invocation", "predicted", "latest"),
      workspacePredictionSnapshotsRootPath: path.join("/workspace/invocation", "predicted", "snapshots", "root"),
      workspacePredictionSnapshotsThreadsPath: path.join("/workspace/invocation", "predicted", "snapshots", "threads"),
      workspaceImplementationSnapshotsRootPath: path.join("/workspace/invocation", "implementation-src", "snapshots", "root"),
      workspaceImplementationSnapshotsThreadsPath: path.join("/workspace/invocation", "implementation-src", "snapshots", "threads"),
      workspaceMountSummary: buildMountSummary({
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/source",
        isLinkedWorkspace: true,
        designPath: path.join("/workspace/source", "design-docs"),
        implementationPath: path.join("/workspace/invocation", "implementation-src"),
        specsPath: path.join("/workspace/invocation", "quality/specs"),
        migrationsPath: path.join("/workspace/invocation", "changesets"),
        predictionPath: path.join("/workspace/invocation", "predicted"),
      }),
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
        workspaceImplementationDir: "implementation-src",
        workspaceSpecsDir: "quality/specs",
        workspaceMigrationsDir: "changesets",
        workspacePredictionDir: "predicted",
        workspaceDesignPlacement: "sourcedir",
        workspaceImplementationPlacement: "sourcedir",
        workspaceSpecsPlacement: "sourcedir",
        workspaceMigrationsPlacement: "sourcedir",
        workspacePredictionPlacement: "sourcedir",
        workspaceDesignPath: "/real/workspace/design-docs",
        workspaceImplementationPath: "/real/workspace/implementation-src",
        workspaceSpecsPath: "/real/workspace/quality/specs",
        workspaceMigrationsPath: "/real/workspace/changesets",
        workspacePredictionPath: "/real/workspace/predicted",
        workspacePredictionLatestPath: "/real/workspace/predicted/latest",
        workspacePredictionSnapshotsRootPath: "/real/workspace/predicted/snapshots/root",
        workspacePredictionSnapshotsThreadsPath: "/real/workspace/predicted/snapshots/threads",
        workspaceImplementationSnapshotsRootPath: "/real/workspace/implementation-src/snapshots/root",
        workspaceImplementationSnapshotsThreadsPath: "/real/workspace/implementation-src/snapshots/threads",
        workspaceMountSummary: buildMountSummary({
          invocationDir: "/real/invocation",
          workspaceDir: "/real/workspace",
          isLinkedWorkspace: true,
          designPath: "/real/workspace/design-docs",
          implementationPath: "/real/workspace/implementation-src",
          specsPath: "/real/workspace/quality/specs",
          migrationsPath: "/real/workspace/changesets",
          predictionPath: "/real/workspace/predicted",
        }),
      },
    );

    expect(merged).toEqual({
      invocationDir: "/real/invocation",
      workspaceDir: "/real/workspace",
      workspaceLinkPath: "/real/.rundown/workspace.link",
      isLinkedWorkspace: "true",
      workspaceDesignDir: "design-docs",
      workspaceImplementationDir: "implementation-src",
      workspaceSpecsDir: "quality/specs",
      workspaceMigrationsDir: "changesets",
      workspacePredictionDir: "predicted",
      workspaceDesignPlacement: "sourcedir",
      workspaceImplementationPlacement: "sourcedir",
      workspaceSpecsPlacement: "sourcedir",
      workspaceMigrationsPlacement: "sourcedir",
      workspacePredictionPlacement: "sourcedir",
      workspaceDesignPath: "/real/workspace/design-docs",
      workspaceImplementationPath: "/real/workspace/implementation-src",
      workspaceSpecsPath: "/real/workspace/quality/specs",
      workspaceMigrationsPath: "/real/workspace/changesets",
      workspacePredictionPath: "/real/workspace/predicted",
      workspacePredictionLatestPath: "/real/workspace/predicted/latest",
      workspacePredictionSnapshotsRootPath: "/real/workspace/predicted/snapshots/root",
      workspacePredictionSnapshotsThreadsPath: "/real/workspace/predicted/snapshots/threads",
      workspaceImplementationSnapshotsRootPath: "/real/workspace/implementation-src/snapshots/root",
      workspaceImplementationSnapshotsThreadsPath: "/real/workspace/implementation-src/snapshots/threads",
      workspaceMountSummary: buildMountSummary({
        invocationDir: "/real/invocation",
        workspaceDir: "/real/workspace",
        isLinkedWorkspace: true,
        designPath: "/real/workspace/design-docs",
        implementationPath: "/real/workspace/implementation-src",
        specsPath: "/real/workspace/quality/specs",
        migrationsPath: "/real/workspace/changesets",
        predictionPath: "/real/workspace/predicted",
      }),
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
        workspaceImplementationDir: "implementation",
        workspaceSpecsDir: "specs",
        workspaceMigrationsDir: "migrations",
        workspacePredictionDir: "prediction",
        workspaceDesignPlacement: "sourcedir",
        workspaceImplementationPlacement: "sourcedir",
        workspaceSpecsPlacement: "sourcedir",
        workspaceMigrationsPlacement: "sourcedir",
        workspacePredictionPlacement: "sourcedir",
        workspaceDesignPath: "/workspace/invocation/design",
        workspaceImplementationPath: "/workspace/invocation/implementation",
        workspaceSpecsPath: "/workspace/invocation/specs",
        workspaceMigrationsPath: "/workspace/invocation/migrations",
        workspacePredictionPath: "/workspace/invocation/prediction",
        workspacePredictionLatestPath: "/workspace/invocation/prediction/latest",
        workspacePredictionSnapshotsRootPath: "/workspace/invocation/prediction/snapshots/root",
        workspacePredictionSnapshotsThreadsPath: "/workspace/invocation/prediction/snapshots/threads",
        workspaceImplementationSnapshotsRootPath: "/workspace/invocation/implementation/snapshots/root",
        workspaceImplementationSnapshotsThreadsPath: "/workspace/invocation/implementation/snapshots/threads",
        workspaceMountSummary: buildMountSummary({
          invocationDir: "/workspace/invocation",
          workspaceDir: "/workspace/invocation",
          isLinkedWorkspace: false,
          designPath: "/workspace/invocation/design",
          implementationPath: "/workspace/invocation/implementation",
          specsPath: "/workspace/invocation/specs",
          migrationsPath: "/workspace/invocation/migrations",
          predictionPath: "/workspace/invocation/prediction",
        }),
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
      workspaceImplementationDir: "implementation",
      workspaceSpecsDir: "specs",
      workspaceMigrationsDir: "migrations",
      workspacePredictionDir: "prediction",
      workspaceDesignPlacement: "sourcedir",
      workspaceImplementationPlacement: "sourcedir",
      workspaceSpecsPlacement: "sourcedir",
      workspaceMigrationsPlacement: "sourcedir",
      workspacePredictionPlacement: "sourcedir",
      workspaceDesignPath: "/workspace/invocation/design",
      workspaceImplementationPath: "/workspace/invocation/implementation",
      workspaceSpecsPath: "/workspace/invocation/specs",
      workspaceMigrationsPath: "/workspace/invocation/migrations",
      workspacePredictionPath: "/workspace/invocation/prediction",
      workspacePredictionLatestPath: "/workspace/invocation/prediction/latest",
      workspacePredictionSnapshotsRootPath: "/workspace/invocation/prediction/snapshots/root",
      workspacePredictionSnapshotsThreadsPath: "/workspace/invocation/prediction/snapshots/threads",
      workspaceImplementationSnapshotsRootPath: "/workspace/invocation/implementation/snapshots/root",
      workspaceImplementationSnapshotsThreadsPath: "/workspace/invocation/implementation/snapshots/threads",
      workspaceMountSummary: buildMountSummary({
        invocationDir: "/workspace/invocation",
        workspaceDir: "/workspace/invocation",
        isLinkedWorkspace: false,
        designPath: "/workspace/invocation/design",
        implementationPath: "/workspace/invocation/implementation",
        specsPath: "/workspace/invocation/specs",
        migrationsPath: "/workspace/invocation/migrations",
        predictionPath: "/workspace/invocation/prediction",
      }),
    });
  });
});
