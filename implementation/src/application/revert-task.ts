import path from "node:path";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import {
  formatNoItemsFound,
  formatNoItemsFoundFor,
  formatSuccessFailureSummary,
  formatTaskLabel,
  pluralize,
} from "./run-task-utils.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import { resolveWorkspacePaths } from "./workspace-paths.js";
import { resolveWorkspaceRootForPathSensitiveCommand } from "./workspace-selection.js";
import type {
  ArtifactRunMetadata,
  ArtifactStore,
  ConfigDirResult,
  FileLock,
  FileSystem,
  GitClient,
  PathOperationsPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";

/**
 * External services required to resolve saved runs, restore snapshots,
 * and persist artifacts for the `revert` command.
 */
export interface RevertTaskDependencies {
  artifactStore: ArtifactStore;
  gitClient: GitClient;
  configDir?: ConfigDirResult;
  workingDirectory: WorkingDirectoryPort;
  fileLock: FileLock;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  output: ApplicationOutputPort;
}

/**
 * User-provided options that control target selection and restore behavior.
 */
export interface RevertTaskOptions {
  runId: string;
  last?: number;
  all?: boolean;
  method: "revert" | "reset";
  dryRun: boolean;
  keepArtifacts: boolean;
  force: boolean;
}

const NO_REVERTABLE_RUNS_BASE_MESSAGE = "No revertable runs found. The original run must be completed with implementation snapshot metadata and a snapshot payload that still exists on disk.";
const REVERTABLE_LOG_HINT = "See `rundown log --revertable` for eligible runs.";

interface SnapshotTarget {
  laneKind: "root" | "thread";
  threadSlug?: string;
  migrationNumber: number;
  snapshotPath: string;
}

interface SnapshotRevertOperation {
  run: ArtifactRunMetadata;
  target: SnapshotTarget;
}

interface RevertProgressDescriptor {
  phaseLabel: string;
  detailPrefix: string;
}

interface RevertOperationGroupDescriptor {
  label: string;
  counter: {
    current: number;
    total: number;
  };
}

export function createRevertTask(
  dependencies: RevertTaskDependencies,
): (options: RevertTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function revertTask(options: RevertTaskOptions): Promise<number> {
    const { runId, last, all, method, dryRun, keepArtifacts, force } = options;
    const hasMultiRunSelection = all === true || last !== undefined;

    if (all && last !== undefined) {
      emit({ kind: "error", message: "Cannot combine --all with --last." });
      return EXIT_CODE_FAILURE;
    }

    if (hasMultiRunSelection && runId !== "latest") {
      emit({ kind: "error", message: "Cannot combine --run <id> with --all or --last." });
      return EXIT_CODE_FAILURE;
    }

    if (last !== undefined && (!Number.isInteger(last) || last < 1)) {
      emit({ kind: "error", message: "--last must be a positive integer." });
      return EXIT_CODE_FAILURE;
    }

    if (force) {
      emit({ kind: "info", message: "--force is ignored for snapshot restores." });
    }

    if (method === "reset") {
      emit({ kind: "info", message: "--method reset is treated as snapshot restore (same behavior as --method revert)." });
    }

    const cwd = dependencies.workingDirectory.cwd();
    const artifactBaseDir = dependencies.configDir?.configDir;

    const workspaceSelection = resolveWorkspaceRootForPathSensitiveCommand({
      fileSystem: dependencies.fileSystem,
      invocationDir: cwd,
    });
    if (!workspaceSelection.ok) {
      emit({ kind: "error", message: workspaceSelection.message });
      return EXIT_CODE_FAILURE;
    }

    const selectedRuns = resolveTargetRuns(dependencies.artifactStore, artifactBaseDir, dependencies.fileSystem, {
      runId,
      last,
      all,
    });
    const completedRuns = resolveCompletedRuns(dependencies.artifactStore, artifactBaseDir);

    if (selectedRuns.length === 0) {
      if (completedRuns.length > 0) {
        emit({ kind: "error", message: buildNoRevertableRunsMessage(true) });
        return EXIT_CODE_NO_WORK;
      }

      if (hasMultiRunSelection) {
        emit({ kind: "error", message: formatNoItemsFound("completed runs") });
        return EXIT_CODE_NO_WORK;
      }

      const target = runId === "latest" ? "latest completed" : runId;
      emit({ kind: "error", message: formatNoItemsFoundFor("saved runtime artifact run", target) });
      return EXIT_CODE_NO_WORK;
    }

    const revertOperations = selectedRuns
      .map((run) => resolveSnapshotRevertOperation(run, dependencies.fileSystem))
      .filter((operation): operation is SnapshotRevertOperation => operation !== null);
    if (revertOperations.length === 0) {
      const selectedRun = selectedRuns[0];
      const selectedRunIsSingleCompletedRunWithoutSnapshot = !hasMultiRunSelection
        && runId !== "latest"
        && selectedRun !== undefined
        && selectedRun.status === "completed"
        && resolveSnapshotRevertOperation(selectedRun, dependencies.fileSystem) === null;
      if (selectedRunIsSingleCompletedRunWithoutSnapshot && selectedRun) {
        emit({ kind: "error", message: buildRunNotSnapshotRevertableMessage(selectedRun, dependencies.fileSystem) });
        return EXIT_CODE_NO_WORK;
      }

      emit({ kind: "error", message: buildNoRevertableRunsMessage(completedRuns.length > 0) });
      return EXIT_CODE_NO_WORK;
    }

    const executionOperations = orderOperationsForRestore(revertOperations);
    const executionRuns = executionOperations.map((operation) => operation.run);

    const workspacePaths = resolveWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: workspaceSelection.workspaceRoot,
      invocationRoot: workspaceSelection.executionContext.invocationDir,
    });
    const implementationRootPath = workspacePaths.implementation;
    const implementationRootStat = dependencies.fileSystem.stat(implementationRootPath);
    if (!implementationRootStat?.isDirectory) {
      emit({ kind: "error", message: "Implementation directory does not exist or is not a directory: " + implementationRootPath });
      return EXIT_CODE_FAILURE;
    }

    const lockTargets = collectRevertLockTargets(executionRuns, cwd, dependencies.pathOperations, implementationRootPath);
    try {
      for (const filePath of lockTargets) {
        dependencies.fileLock.acquire(filePath, { command: "revert" });
      }
    } catch (error) {
      if (error instanceof FileLockError) {
        emit({
          kind: "error",
          message: "Source file is locked by another rundown process: "
            + error.filePath
            + " (pid=" + error.holder.pid
            + ", command=" + error.holder.command
            + ", startTime=" + error.holder.startTime
            + "). If this lock is stale, run `rundown unlock "
            + error.filePath
            + "` before retrying.",
        });
        return EXIT_CODE_FAILURE;
      }
      throw error;
    }

    try {
      if (dryRun) {
        const dryRunProgress = buildRevertProgressDescriptor(true);
        emit({
          kind: "info",
          message: "Dry run - would restore " + executionRuns.length + " "
            + pluralize(executionRuns.length, "run", "runs")
            + " using snapshot-backed history.",
        });

        for (const [index, operation] of executionOperations.entries()) {
          const run = operation.run;
          const current = index + 1;
          emit({
            kind: "progress",
            progress: {
              label: dryRunProgress.phaseLabel,
              current,
              total: executionOperations.length,
              unit: "runs",
              detail: dryRunProgress.detailPrefix + " " + run.runId,
            },
          });
          emit({
            kind: "info",
            message: "[" + current + "/" + executionOperations.length + "] "
              + dryRunProgress.detailPrefix + " " + run.runId + ".",
          });
          emit({
            kind: "info",
            message: "- run=" + run.runId
              + " lane=" + formatSnapshotLane(operation.target)
              + " migration=" + String(operation.target.migrationNumber)
              + " snapshot=" + operation.target.snapshotPath
              + " task=" + formatTaskLabel(run),
          });
          emit({
            kind: "info",
            message: "- restore implementation tree from " + operation.target.snapshotPath,
          });
        }

        return EXIT_CODE_SUCCESS;
      }

      const artifactContext = dependencies.artifactStore.createContext({
        cwd,
        commandName: "revert",
        mode: "wait",
        source: executionRuns[0]?.source,
        task: executionRuns.length === 1 ? executionRuns[0]?.task : undefined,
        keepArtifacts,
      });

      const successfulRunIds: string[] = [];
      const attemptedRunIds: string[] = [];
      let failedRunId: string | null = null;
      let failedSnapshotPath: string | null = null;
      let runFailureCount = 0;
      const emitRevertSummary = (): void => {
        emit({
          kind: "info",
          message: formatSuccessFailureSummary("Revert operation", successfulRunIds.length, runFailureCount),
        });
      };

      try {
        const executionProgress = buildRevertProgressDescriptor(false);
        for (const [index, operation] of executionOperations.entries()) {
          const run = operation.run;
          const current = index + 1;
          const operationGroup = buildRevertOperationGroupDescriptor(run, current, executionOperations.length);
          attemptedRunIds.push(run.runId);
          emit({
            kind: "group-start",
            label: operationGroup.label,
            counter: operationGroup.counter,
          });
          emit({
            kind: "progress",
            progress: {
              label: executionProgress.phaseLabel,
              current,
              total: executionOperations.length,
              unit: "runs",
              detail: executionProgress.detailPrefix + " " + run.runId,
            },
          });
          emit({
            kind: "info",
            message: "[" + current + "/" + executionOperations.length + "] Restoring snapshot "
              + operation.target.snapshotPath + " (run " + run.runId + ").",
          });

          try {
            restoreImplementationTreeFromSnapshot({
              fileSystem: dependencies.fileSystem,
              implementationRootPath,
              snapshotPath: operation.target.snapshotPath,
            });
            successfulRunIds.push(run.runId);
            emit({ kind: "group-end", status: "success" });
          } catch (error) {
            failedRunId = run.runId;
            failedSnapshotPath = operation.target.snapshotPath;
            runFailureCount += 1;
            emit({
              kind: "group-end",
              status: "failure",
              message: "Snapshot restore failed for " + run.runId + ".",
            });
            if (hasMultiRunSelection) {
              emit({
                kind: "error",
                message: "Revert stopped on " + run.runId + " after " + successfulRunIds.length
                  + " successful run(s).",
              });
            }

            emitRevertSummary();

            const failureMessage = error instanceof Error ? error.message : String(error);
            throw new Error("Failed to restore run " + run.runId + " from snapshot " + operation.target.snapshotPath + ": " + failureMessage);
          }
        }

        emitRevertSummary();
        const lastOperation = executionOperations[executionOperations.length - 1];
        dependencies.artifactStore.finalize(artifactContext, {
          status: "reverted",
          preserve: keepArtifacts,
          extra: {
            method: "snapshot-restore",
            requestedMethod: method,
            runIds: executionRuns.map((run) => run.runId),
            revertedRunIds: successfulRunIds,
            revertedCount: successfulRunIds.length,
            restoredSnapshotPath: lastOperation?.target.snapshotPath,
            restoredSnapshotMigrationNumber: lastOperation?.target.migrationNumber,
            restoredSnapshotLaneKind: lastOperation?.target.laneKind,
            ...(lastOperation?.target.threadSlug ? { restoredSnapshotThreadSlug: lastOperation.target.threadSlug } : {}),
            implementationSnapshotTargets: executionOperations.map((operation) => ({
              runId: operation.run.runId,
              laneKind: operation.target.laneKind,
              ...(operation.target.threadSlug ? { threadSlug: operation.target.threadSlug } : {}),
              migrationNumber: operation.target.migrationNumber,
              snapshotPath: operation.target.snapshotPath,
            })),
          },
        });

        if (keepArtifacts) {
          emit({
            kind: "info",
            message: "Runtime artifacts saved at " + dependencies.artifactStore.displayPath(artifactContext) + ".",
          });
        }

        emit({
          kind: "success",
          message: "Reverted " + executionRuns.length + " "
            + pluralize(executionRuns.length, "run", "runs")
            + " successfully.",
        });
        return EXIT_CODE_SUCCESS;
      } catch (error) {
        dependencies.artifactStore.finalize(artifactContext, {
          status: "revert-failed",
          preserve: keepArtifacts,
          extra: {
            method: "snapshot-restore",
            requestedMethod: method,
            runIds: executionRuns.map((run) => run.runId),
            attemptedRunIds,
            revertedRunIds: successfulRunIds,
            revertedCount: successfulRunIds.length,
            failedRunId,
            failedSnapshotPath,
            error: error instanceof Error ? error.message : String(error),
          },
        });

        if (keepArtifacts) {
          emit({
            kind: "info",
            message: "Runtime artifacts saved at " + dependencies.artifactStore.displayPath(artifactContext) + ".",
          });
        }

        emit({ kind: "error", message: "Revert failed: " + String(error) });
        return EXIT_CODE_FAILURE;
      }
    } finally {
      try {
        dependencies.fileLock.releaseAll();
      } catch (error) {
        emit({ kind: "warn", message: "Failed to release file locks: " + String(error) });
      }
    }
  };
}

function buildRevertProgressDescriptor(dryRun: boolean): RevertProgressDescriptor {
  return {
    phaseLabel: dryRun ? "Dry-run restore plan" : "Restoring runs",
    detailPrefix: dryRun ? "Previewing run" : "Restoring run",
  };
}

function buildRevertOperationGroupDescriptor(
  run: ArtifactRunMetadata,
  current: number,
  total: number,
): RevertOperationGroupDescriptor {
  return {
    label: "Revert operation: " + formatTaskLabel(run),
    counter: {
      current,
      total,
    },
  };
}

function resolveTargetRunMetadata(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
  runId: string,
  fileSystem: FileSystem,
): ArtifactRunMetadata | null {
  if (runId === "latest") {
    return resolveRevertableRuns(artifactStore, artifactBaseDir, fileSystem)[0] ?? null;
  }

  return artifactStore.find(runId, artifactBaseDir);
}

function resolveTargetRuns(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
  fileSystem: FileSystem,
  options: Pick<RevertTaskOptions, "runId" | "last" | "all">,
): ArtifactRunMetadata[] {
  const { runId, last, all } = options;

  if (all) {
    return resolveRevertableRuns(artifactStore, artifactBaseDir, fileSystem);
  }

  if (last !== undefined) {
    return resolveRevertableRuns(artifactStore, artifactBaseDir, fileSystem).slice(0, last);
  }

  const selectedRun = resolveTargetRunMetadata(artifactStore, artifactBaseDir, runId, fileSystem);
  return selectedRun ? [selectedRun] : [];
}

function resolveRevertableRuns(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
  fileSystem: FileSystem,
): ArtifactRunMetadata[] {
  return artifactStore.listSaved(artifactBaseDir).filter((run) => resolveSnapshotRevertOperation(run, fileSystem) !== null);
}

function resolveCompletedRuns(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
): ArtifactRunMetadata[] {
  return artifactStore.listSaved(artifactBaseDir).filter((run) => run.status === "completed");
}

function resolveSnapshotRevertOperation(
  run: ArtifactRunMetadata,
  fileSystem: FileSystem,
): SnapshotRevertOperation | null {
  if (run.status !== "completed") {
    return null;
  }

  const snapshotTargets = getSnapshotTargets(run);
  if (snapshotTargets.length === 0) {
    return null;
  }

  const existingTargets = snapshotTargets.filter((target) => {
    const stat = fileSystem.stat(target.snapshotPath);
    return Boolean(stat?.isDirectory);
  });
  if (existingTargets.length === 0) {
    return null;
  }

  const selectedTarget = chooseDeterministicSnapshotTarget(existingTargets);
  if (!selectedTarget) {
    return null;
  }

  return {
    run,
    target: selectedTarget,
  };
}

function getSnapshotTargets(run: ArtifactRunMetadata): SnapshotTarget[] {
  const raw = run.extra?.["implementationSnapshotTargets"];
  if (!Array.isArray(raw)) {
    return [];
  }

  const targets: SnapshotTarget[] = [];
  for (const value of raw) {
    if (!isSnapshotTargetRecord(value)) {
      continue;
    }

    const laneKind = normalizeLaneKind(value["laneKind"]);
    const snapshotPath = normalizeNonEmptyString(value["snapshotPath"]);
    const migrationNumber = normalizeMigrationNumber(value["migrationNumber"]);
    if (!laneKind || !snapshotPath || migrationNumber === null) {
      continue;
    }

    const threadSlug = normalizeOptionalNonEmptyString(value["threadSlug"]);
    if (laneKind === "thread" && !threadSlug) {
      continue;
    }

    targets.push({
      laneKind,
      ...(threadSlug ? { threadSlug } : {}),
      migrationNumber,
      snapshotPath,
    });
  }

  return targets;
}

function chooseDeterministicSnapshotTarget(targets: SnapshotTarget[]): SnapshotTarget | null {
  if (targets.length === 0) {
    return null;
  }

  const sorted = [...targets].sort((left, right) => {
    if (left.laneKind !== right.laneKind) {
      return left.laneKind === "root" ? -1 : 1;
    }
    const leftThread = left.threadSlug ?? "";
    const rightThread = right.threadSlug ?? "";
    if (leftThread !== rightThread) {
      return leftThread.localeCompare(rightThread);
    }
    if (left.migrationNumber !== right.migrationNumber) {
      return right.migrationNumber - left.migrationNumber;
    }
    return left.snapshotPath.localeCompare(right.snapshotPath);
  });

  return sorted[0] ?? null;
}

function orderOperationsForRestore(
  operations: SnapshotRevertOperation[],
): SnapshotRevertOperation[] {
  return [...operations].sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
}

function buildRunNotSnapshotRevertableMessage(run: ArtifactRunMetadata, fileSystem: FileSystem): string {
  const snapshotTargets = getSnapshotTargets(run);
  if (snapshotTargets.length === 0) {
    return "Run " + run.runId + " is not revertable because it does not include implementation snapshot metadata (extra.implementationSnapshotTargets).";
  }

  const hasExistingTarget = snapshotTargets.some((target) => {
    const stat = fileSystem.stat(target.snapshotPath);
    return Boolean(stat?.isDirectory);
  });
  if (!hasExistingTarget) {
    return "Run " + run.runId + " is not revertable because its implementation snapshot payload is missing on disk.";
  }

  return "Run " + run.runId + " is not revertable because it has invalid implementation snapshot metadata.";
}

function isSnapshotTargetRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeLaneKind(value: unknown): "root" | "thread" | null {
  if (value === "root" || value === "thread") {
    return value;
  }

  return null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  return normalized ?? undefined;
}

function normalizeMigrationNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}

function collectRevertLockTargets(
  runs: ArtifactRunMetadata[],
  cwd: string,
  pathOperations: PathOperationsPort,
  implementationRootPath: string,
): string[] {
  const lockTargets = new Set<string>();
  lockTargets.add(implementationRootPath);

  for (const run of runs) {
    const taskFile = run.task?.file;
    if (typeof taskFile === "string" && taskFile.length > 0) {
      const resolvedTaskFile = pathOperations.isAbsolute(taskFile)
        ? taskFile
        : pathOperations.resolve(cwd, taskFile);
      lockTargets.add(resolvedTaskFile);
      continue;
    }

    const sourceFile = run.source;
    if (typeof sourceFile === "string" && sourceFile.length > 0) {
      const resolvedSourceFile = pathOperations.isAbsolute(sourceFile)
        ? sourceFile
        : pathOperations.resolve(cwd, sourceFile);
      lockTargets.add(resolvedSourceFile);
    }
  }

  return Array.from(lockTargets);
}

function restoreImplementationTreeFromSnapshot(input: {
  fileSystem: FileSystem;
  implementationRootPath: string;
  snapshotPath: string;
}): void {
  const { fileSystem, implementationRootPath, snapshotPath } = input;

  const snapshotStat = fileSystem.stat(snapshotPath);
  if (!snapshotStat?.isDirectory) {
    throw new Error("Snapshot payload is missing or not a directory: " + snapshotPath);
  }

  const implementationRootStat = fileSystem.stat(implementationRootPath);
  if (!implementationRootStat?.isDirectory) {
    throw new Error("Implementation directory does not exist or is not a directory: " + implementationRootPath);
  }

  clearImplementationTreeWithoutSnapshots({
    fileSystem,
    implementationRootPath,
  });

  copySnapshotPayloadToImplementation({
    fileSystem,
    implementationRootPath,
    snapshotPath,
  });
}

function clearImplementationTreeWithoutSnapshots(input: {
  fileSystem: FileSystem;
  implementationRootPath: string;
}): void {
  const { fileSystem, implementationRootPath } = input;
  const entries = fileSystem.readdir(implementationRootPath)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "snapshots") {
      continue;
    }

    const entryPath = path.join(implementationRootPath, entry.name);
    fileSystem.rm(entryPath, { recursive: true, force: true });
  }
}

function copySnapshotPayloadToImplementation(input: {
  fileSystem: FileSystem;
  implementationRootPath: string;
  snapshotPath: string;
}): void {
  const { fileSystem, implementationRootPath, snapshotPath } = input;
  const entries = fileSystem.readdir(snapshotPath)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.name === "snapshots") {
      continue;
    }

    const sourcePath = path.join(snapshotPath, entry.name);
    const destinationPath = path.join(implementationRootPath, entry.name);
    copyPathRecursively({
      fileSystem,
      sourcePath,
      destinationPath,
    });
  }
}

function copyPathRecursively(input: {
  fileSystem: FileSystem;
  sourcePath: string;
  destinationPath: string;
}): void {
  const { fileSystem, sourcePath, destinationPath } = input;
  const stat = fileSystem.stat(sourcePath);
  if (!stat) {
    return;
  }

  if (stat.isDirectory) {
    fileSystem.mkdir(destinationPath, { recursive: true });
    const entries = fileSystem.readdir(sourcePath)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const nestedSourcePath = path.join(sourcePath, entry.name);
      const nestedDestinationPath = path.join(destinationPath, entry.name);
      copyPathRecursively({
        fileSystem,
        sourcePath: nestedSourcePath,
        destinationPath: nestedDestinationPath,
      });
    }
    return;
  }

  if (!stat.isFile) {
    return;
  }

  fileSystem.writeText(destinationPath, fileSystem.readText(sourcePath));
}

function formatSnapshotLane(target: SnapshotTarget): string {
  if (target.laneKind === "thread") {
    return "thread:" + (target.threadSlug ?? "unknown");
  }

  return "root";
}

function buildNoRevertableRunsMessage(includeLogHint: boolean): string {
  if (!includeLogHint) {
    return NO_REVERTABLE_RUNS_BASE_MESSAGE;
  }

  return NO_REVERTABLE_RUNS_BASE_MESSAGE + " " + REVERTABLE_LOG_HINT;
}
