import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import type { FileSystem } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import {
  discoverDesignRevisionDirectories,
  findLowestUnplannedRevision,
  formatDesignRevisionUnifiedDiff,
  prepareDesignRevisionDiffContext,
} from "./design-context.js";
import {
  resolvePredictionWorkspaceDirectories,
  resolvePredictionWorkspacePath,
  resolvePredictionWorkspacePlacement,
} from "./prediction-workspace-paths.js";
import { resolveWorkspaceRootForPathSensitiveCommand } from "./workspace-selection.js";

export interface DesignDiffTaskOptions {
  dir?: string;
  workspace?: string;
  target?: string;
  from?: string;
}

export interface DesignDiffTaskDependencies {
  fileSystem: FileSystem;
  output: ApplicationOutputPort;
}

export function createDesignDiffTask(
  dependencies: DesignDiffTaskDependencies,
): (options: DesignDiffTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function designDiffTask(options: DesignDiffTaskOptions): Promise<number> {
    const invocationDir = process.cwd();
    const workspaceSelection = resolveWorkspaceRootForPathSensitiveCommand({
      fileSystem: dependencies.fileSystem,
      invocationDir,
      workspaceOption: options.workspace,
    });
    if (!workspaceSelection.ok) {
      emit({ kind: "error", message: workspaceSelection.message });
      return EXIT_CODE_FAILURE;
    }

    const workspaceRoot = workspaceSelection.workspaceRoot;
    const executionContext = workspaceSelection.executionContext;
    const workspaceDirectories = resolvePredictionWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const workspacePlacement = resolvePredictionWorkspacePlacement({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const migrationsDir = resolvePredictionWorkspacePath({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
      bucket: "migrations",
      overrideDir: options.dir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });

    if (!dependencies.fileSystem.exists(migrationsDir)) {
      emit({ kind: "error", message: "Migrations directory does not exist: " + migrationsDir });
      return EXIT_CODE_FAILURE;
    }

    const target = resolveTargetRevision({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
      explicitTarget: options.target,
    });
    if (!target.ok) {
      emit({ kind: "error", message: target.message });
      return EXIT_CODE_FAILURE;
    }

    const diff = prepareDesignRevisionDiffContext(dependencies.fileSystem, workspaceRoot, {
      invocationRoot: executionContext.invocationDir,
      target: target.targetRevision,
    });

    if (!dependencies.fileSystem.exists(diff.toTarget.absolutePath)) {
      emit({ kind: "error", message: "Design diff unavailable: target directory does not exist for " + diff.toTarget.name + "." });
      return EXIT_CODE_FAILURE;
    }

    const resolvedFrom = options.from ?? diff.fromRevision?.name ?? "nothing";
    if (options.from && options.from !== (diff.fromRevision?.name ?? "nothing")) {
      emit({
        kind: "error",
        message:
          "Unsupported --from override for target "
          + diff.toTarget.name
          + ": expected "
          + (diff.fromRevision?.name ?? "nothing")
          + ", received "
          + options.from
          + ".",
      });
      return EXIT_CODE_FAILURE;
    }

    emit({
      kind: "text",
      text:
        `${resolvedFrom} → ${diff.toTarget.name}  (${diff.addedCount} added, ${diff.modifiedCount} modified, ${diff.removedCount} removed)\n`,
    });

    const unifiedDiff = formatDesignRevisionUnifiedDiff(dependencies.fileSystem, diff);
    if (unifiedDiff.length > 0) {
      emit({ kind: "text", text: unifiedDiff + "\n" });
    }

    return EXIT_CODE_SUCCESS;
  };
}

function resolveTargetRevision(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  explicitTarget: string | undefined;
}): { ok: true; targetRevision: string } | { ok: false; message: string } {
  if (input.explicitTarget) {
    return { ok: true, targetRevision: input.explicitTarget };
  }

  const lowestUnplanned = findLowestUnplannedRevision(input.fileSystem, input.workspaceRoot, {
    invocationRoot: input.invocationRoot,
  });
  if (lowestUnplanned) {
    return { ok: true, targetRevision: lowestUnplanned.name };
  }

  const revisions = discoverDesignRevisionDirectories(input.fileSystem, input.workspaceRoot, {
    invocationRoot: input.invocationRoot,
  });
  if (revisions.length === 0) {
    return {
      ok: false,
      message: "No released design revisions yet. Run rundown design release to create rev.0.",
    };
  }

  const highestRevision = revisions
    .slice()
    .sort((left, right) => right.index - left.index)
    .at(0);
  if (!highestRevision) {
    return {
      ok: false,
      message: "No released design revisions yet. Run rundown design release to create rev.0.",
    };
  }

  return { ok: true, targetRevision: highestRevision.name };
}
