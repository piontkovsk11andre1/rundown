import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type {
  ArtifactStore,
  DirectoryOpenerPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";

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

export interface ManageArtifactsDependencies {
  artifactStore: ArtifactStore;
  directoryOpener: DirectoryOpenerPort;
  workingDirectory: WorkingDirectoryPort;
  output: ApplicationOutputPort;
}

export interface ManageArtifactsOptions {
  clean: boolean;
  json: boolean;
  failed: boolean;
  open: string;
  cwd?: string;
}

export function createManageArtifacts(
  dependencies: ManageArtifactsDependencies,
): (options: ManageArtifactsOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return function manageArtifacts(options: ManageArtifactsOptions): number {
    const shouldClean = options.clean;
    const shouldPrintJson = options.json;
    const onlyFailed = options.failed;
    const runToOpen = options.open;
    const cwd = options.cwd ?? dependencies.workingDirectory.cwd();

    if (shouldClean && (shouldPrintJson || runToOpen)) {
      emit({ kind: "error", message: "--clean cannot be combined with --json or --open." });
      return 1;
    }

    if (runToOpen && (shouldPrintJson || onlyFailed)) {
      emit({ kind: "error", message: "--open cannot be combined with --json or --failed." });
      return 1;
    }

    if (runToOpen) {
      const run = runToOpen === "latest"
        ? dependencies.artifactStore.latest(cwd)
        : dependencies.artifactStore.find(runToOpen, cwd);
      if (!run) {
        emit({ kind: "error", message: "No saved runtime artifact run found for: " + runToOpen });
        return 3;
      }

      dependencies.directoryOpener.openDirectory(run.rootDir);
      emit({ kind: "success", message: "Opened runtime artifacts: " + run.relativePath });
      return 0;
    }

    if (shouldClean) {
      const removed = onlyFailed
        ? dependencies.artifactStore.removeFailed(cwd)
        : dependencies.artifactStore.removeSaved(cwd);
      if (removed === 0) {
        emit({ kind: "info", message: onlyFailed ? "No failed runtime artifacts found." : "No saved runtime artifacts found." });
        return 0;
      }

      emit({
        kind: "success",
        message: "Removed " + removed + " "
          + (onlyFailed ? "failed " : "")
          + "runtime artifact run"
          + (removed === 1 ? "" : "s")
          + ".",
      });
      return 0;
    }

    const runs = onlyFailed
      ? dependencies.artifactStore.listFailed(cwd)
      : dependencies.artifactStore.listSaved(cwd);

    if (runs.length === 0) {
      emit({ kind: "info", message: onlyFailed ? "No failed runtime artifacts found." : "No saved runtime artifacts found." });
      return 0;
    }

    if (shouldPrintJson) {
      emit({ kind: "text", text: JSON.stringify(runs, null, 2) });
      return 0;
    }

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

export const manageArtifacts = createManageArtifacts;
