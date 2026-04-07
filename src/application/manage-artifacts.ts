import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type {
  ArtifactStore,
  ConfigDirResult,
  DirectoryOpenerPort,
} from "../domain/ports/index.js";
import { formatNoItemsFound, formatNoItemsFoundFor, pluralize } from "./run-task-utils.js";

/**
 * Represents a saved runtime artifact run persisted by the artifact store.
 */
export interface SavedRuntimeArtifactRun {
  runId: string;
  rootDir: string;
  relativePath: string;
  commandName: string;
  workerCommand?: string[];
  mode?: string;
  transport?: string;
  source?: string;
  keepArtifacts?: boolean;
  completedAt?: string;
  task?: {
    text: string;
    file: string;
    line: number;
    index?: number;
    source?: string;
  };
  startedAt: string;
  status?: string;
}

/**
 * Dependencies required to manage runtime artifact runs.
 */
export interface ManageArtifactsDependencies {
  artifactStore: ArtifactStore;
  directoryOpener: DirectoryOpenerPort;
  configDir: ConfigDirResult | undefined;
  output: ApplicationOutputPort;
}

/**
 * CLI options supported by the artifacts management command.
 */
export interface ManageArtifactsOptions {
  clean: boolean;
  json: boolean;
  failed: boolean;
  open: string;
  configDir?: string;
}

/**
 * Creates the artifacts management application use case.
 *
 * Supports listing, opening, JSON rendering, and cleanup operations for
 * saved runtime artifact runs.
 */
export function createManageArtifacts(
  dependencies: ManageArtifactsDependencies,
): (options: ManageArtifactsOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return function manageArtifacts(options: ManageArtifactsOptions): number {
    const shouldClean = options.clean;
    const shouldPrintJson = options.json;
    const onlyFailed = options.failed;
    const runToOpen = options.open;
    const artifactBaseDir = options.configDir ?? dependencies.configDir?.configDir;

    // Guard against mutually exclusive options that would produce ambiguous behavior.
    if (shouldClean && (shouldPrintJson || runToOpen)) {
      emit({ kind: "error", message: "--clean cannot be combined with --json or --open." });
      return 1;
    }

    if (runToOpen && (shouldPrintJson || onlyFailed)) {
      emit({ kind: "error", message: "--open cannot be combined with --json or --failed." });
      return 1;
    }

    // Open a specific run directory and exit early when --open is requested.
    if (runToOpen) {
      const run = runToOpen === "latest"
        ? dependencies.artifactStore.latest(artifactBaseDir)
        : dependencies.artifactStore.find(runToOpen, artifactBaseDir);
      if (!run) {
        emit({ kind: "error", message: formatNoItemsFoundFor("saved runtime artifact run", runToOpen) });
        return 3;
      }

      dependencies.directoryOpener.openDirectory(run.rootDir);
      emit({ kind: "success", message: "Opened runtime artifacts: " + run.relativePath });
      return 0;
    }

    // Remove saved runs when --clean is provided, optionally scoped to failures.
    if (shouldClean) {
      const removed = onlyFailed
        ? dependencies.artifactStore.removeFailed(artifactBaseDir)
        : dependencies.artifactStore.removeSaved(artifactBaseDir);
      if (removed === 0) {
        emit({ kind: "info", message: onlyFailed ? formatNoItemsFound("failed runtime artifacts") : formatNoItemsFound("saved runtime artifacts") });
        return 0;
      }

      emit({
        kind: "success",
        message: "Removed " + removed + " "
          + (onlyFailed ? "failed " : "")
          + pluralize(removed, "runtime artifact run", "runtime artifact runs")
          + ".",
      });
      return 0;
    }

    // Default behavior is listing saved runs, filtered to failed runs when requested.
    const runs = onlyFailed
      ? dependencies.artifactStore.listFailed(artifactBaseDir)
      : dependencies.artifactStore.listSaved(artifactBaseDir);

    if (runs.length === 0) {
      emit({ kind: "info", message: onlyFailed ? formatNoItemsFound("failed runtime artifacts") : formatNoItemsFound("saved runtime artifacts") });
      return 0;
    }

    // Emit machine-readable JSON output for scripting use cases.
    if (shouldPrintJson) {
      emit({ kind: "text", text: JSON.stringify(runs, null, 2) });
      return 0;
    }

    // Emit a human-readable summary followed by key details for each run.
    for (const run of runs) {
      const worker = run.workerCommand?.join(" ") ?? run.commandName;
      const summary = [
        run.runId,
        `[status=${run.status ?? "unknown"}]`,
        `[command=${run.commandName}]`,
        `[mode=${run.mode ?? "n/a"}]`,
        `[transport=${run.transport ?? "n/a"}]`,
        run.relativePath,
      ].join(" ");

      emit({ kind: "text", text: summary });
      if (run.task) {
        emit({ kind: "text", text: "  task: " + run.task.text + " — " + run.task.file + ":" + run.task.line });
      }
      emit({ kind: "text", text: "  worker: " + worker });
      emit({ kind: "text", text: "  started: " + run.startedAt });
    }

    return 0;
  };
}

