import {
  findSavedRuntimeArtifact,
  latestSavedRuntimeArtifact,
  listFailedRuntimeArtifacts,
  listSavedRuntimeArtifacts,
  removeFailedRuntimeArtifacts,
  removeSavedRuntimeArtifacts,
} from "../infrastructure/runtime-artifacts.js";
import { openDirectory } from "../infrastructure/open-directory.js";
import * as log from "../presentation/log.js";

export interface ManageArtifactsOptions {
  clean: boolean;
  json: boolean;
  failed: boolean;
  open: string;
  cwd?: string;
}

export function manageArtifacts(options: ManageArtifactsOptions): number {
  const shouldClean = options.clean;
  const shouldPrintJson = options.json;
  const onlyFailed = options.failed;
  const runToOpen = options.open;
  const cwd = options.cwd ?? process.cwd();

  if (shouldClean && (shouldPrintJson || runToOpen)) {
    log.error("--clean cannot be combined with --json or --open.");
    return 1;
  }

  if (runToOpen && (shouldPrintJson || onlyFailed)) {
    log.error("--open cannot be combined with --json or --failed.");
    return 1;
  }

  if (runToOpen) {
    const run = runToOpen === "latest"
      ? latestSavedRuntimeArtifact(cwd)
      : findSavedRuntimeArtifact(runToOpen, cwd);
    if (!run) {
      log.error("No saved runtime artifact run found for: " + runToOpen);
      return 3;
    }

    openDirectory(run.rootDir);
    log.success("Opened runtime artifacts: " + run.relativePath);
    return 0;
  }

  if (shouldClean) {
    const removed = onlyFailed
      ? removeFailedRuntimeArtifacts(cwd)
      : removeSavedRuntimeArtifacts(cwd);
    if (removed === 0) {
      log.info(onlyFailed ? "No failed runtime artifacts found." : "No saved runtime artifacts found.");
      return 0;
    }

    log.success(
      "Removed " + removed + " "
      + (onlyFailed ? "failed " : "")
      + "runtime artifact run"
      + (removed === 1 ? "" : "s")
      + ".",
    );
    return 0;
  }

  const runs = onlyFailed
    ? listFailedRuntimeArtifacts(cwd)
    : listSavedRuntimeArtifacts(cwd);

  if (runs.length === 0) {
    log.info(onlyFailed ? "No failed runtime artifacts found." : "No saved runtime artifacts found.");
    return 0;
  }

  if (shouldPrintJson) {
    console.log(JSON.stringify(runs, null, 2));
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

    console.log(summary);
    if (run.task) {
      console.log("  task: " + run.task.text + " — " + run.task.file + ":" + run.task.line);
    }
    console.log("  worker: " + worker);
    console.log("  started: " + run.startedAt);
  }

  return 0;
}
