import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import type {
  ArtifactRunMetadata,
  ArtifactStore,
  FileLock,
  FileSystem,
  GitClient,
  PathOperationsPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";

export interface RevertTaskDependencies {
  artifactStore: ArtifactStore;
  gitClient: GitClient;
  workingDirectory: WorkingDirectoryPort;
  fileLock: FileLock;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  output: ApplicationOutputPort;
}

export interface RevertTaskOptions {
  runId: string;
  last?: number;
  all?: boolean;
  method: "revert" | "reset";
  dryRun: boolean;
  keepArtifacts: boolean;
  force: boolean;
}

const GIT_ARTIFACT_AND_LOCK_EXCLUDES = [
  ":(exclude).rundown/runs/**",
  ":(exclude).rundown/logs/**",
  ":(exclude).rundown/*.lock",
  ":(glob,exclude)**/.rundown/*.lock",
] as const;

interface RevertOperation {
  run: ArtifactRunMetadata;
  type: "commit" | "pre-reset-ref";
  ref: string;
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
      return 3;
    }

    if (hasMultiRunSelection && runId !== "latest") {
      emit({ kind: "error", message: "Cannot combine --run <id> with --all or --last." });
      return 3;
    }

    if (last !== undefined && (!Number.isInteger(last) || last < 1)) {
      emit({ kind: "error", message: "--last must be a positive integer." });
      return 3;
    }

    const cwd = dependencies.workingDirectory.cwd();
    const selectedRuns = resolveTargetRuns(dependencies.artifactStore, cwd, { runId, last, all });
    const completedRuns = resolveCompletedRuns(dependencies.artifactStore, cwd);

    if (selectedRuns.length === 0) {
      if (completedRuns.length > 0) {
        emit({
          kind: "error",
          message: "No revertable runs found. The original run must be completed with --commit and --keep-artifacts so run.json contains extra.commitSha.",
        });
        return 3;
      }

      if (hasMultiRunSelection) {
        emit({ kind: "error", message: "No completed runs found to revert." });
        return 3;
      }

      const target = runId === "latest"
        ? "latest completed"
        : runId;
      emit({ kind: "error", message: "No saved runtime artifact run found for: " + target });
      return 3;
    }

    const revertOperations = selectedRuns
      .map(resolveRevertOperation)
      .filter((operation): operation is RevertOperation => operation !== null);
    if (revertOperations.length === 0) {
      emit({
        kind: "error",
        message: "No revertable runs found. The original run must be completed with --commit and --keep-artifacts so run.json contains extra.commitSha.",
      });
      return 3;
    }

    const hasPreResetRefTargets = revertOperations.some((operation) => operation.type === "pre-reset-ref");
    if (hasPreResetRefTargets) {
      if (revertOperations.length > 1) {
        emit({
          kind: "error",
          message: "Runs created by a prior --method reset can only be reverted one at a time (use --run <id> --method reset).",
        });
        return 3;
      }

      if (method !== "reset") {
        emit({
          kind: "error",
          message: "Selected run was created by --method reset. Revert it with --method reset to restore its pre-reset ref.",
        });
        return 3;
      }
    }

    const executionOperations = orderOperationsForMethod(revertOperations, method);
    const executionRuns = executionOperations.map((operation) => operation.run);

    const lockTargets = collectRevertLockTargets(executionRuns, cwd, dependencies.pathOperations);
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
        return 1;
      }
      throw error;
    }

    try {
      for (const run of executionRuns) {
        const taskFile = run.task?.file;
        const missingTaskFile = isTaskFileMissing(
          run,
          cwd,
          dependencies.fileSystem,
          dependencies.pathOperations,
        );
        if (!missingTaskFile) {
          continue;
        }

        emit({
          kind: "info",
          message: "Run " + run.runId + " references task file " + taskFile
            + " which no longer exists. Proceeding with commit-based revert; file renames/moves are handled by git history.",
        });
      }

      const inGitRepo = await isGitRepoWithGitClient(dependencies.gitClient, cwd);
      if (!inGitRepo) {
        emit({ kind: "error", message: "Not inside a git repository." });
        return 1;
      }

      if (force) {
        emit({
          kind: "info",
          message: "--force enabled: skipping clean-worktree precondition check.",
        });
      } else {
        const isClean = await isWorkingDirectoryClean(dependencies.gitClient, cwd);
        if (!isClean) {
          emit({
            kind: "error",
            message: "Working directory is not clean. Commit or stash changes before running revert.",
          });
          return 1;
        }
      }

      let resetOldestSha: string | null = null;

      try {
        const commitOperations = executionOperations.filter((operation) => operation.type === "commit");
        if (commitOperations.length > 0) {
          await validateTargetCommitsExistInHistory(dependencies.gitClient, cwd, commitOperations);
        }

        if (method === "reset" && commitOperations.length > 0) {
          if (force) {
            emit({
              kind: "info",
              message: "--force enabled: skipping contiguous-HEAD validation for reset.",
            });
            resetOldestSha = resolveOldestResetTarget(commitOperations);
          } else {
            resetOldestSha = await validateResetTargetsAtHead(dependencies.gitClient, cwd, commitOperations);
          }
        }

        await validatePreResetRefTargetsExistInHistory(dependencies.gitClient, cwd, executionOperations);
      } catch (error) {
        emit({ kind: "error", message: String(error) });
        return 1;
      }

      if (dryRun) {
        emit({
          kind: "info",
          message: "Dry run - would revert " + executionRuns.length + " run"
            + (executionRuns.length === 1 ? "" : "s")
            + " using method=" + method + ".",
        });
        for (const operation of executionOperations) {
          const run = operation.run;
          const refField = operation.type === "commit" ? "commit" : "preResetRef";
          emit({
            kind: "info",
            message: "- run=" + run.runId
              + " method=" + method
              + " " + refField + "=" + operation.ref
              + " task=" + formatTaskLabel(run),
          });

          if (method === "revert" && operation.type === "commit") {
            emit({
              kind: "info",
              message: "- git revert " + operation.ref + " --no-edit",
            });
          }
        }

        if (method === "reset" && hasPreResetRefTargets) {
          const preResetRefTarget = executionOperations[0]?.ref;
          if (preResetRefTarget) {
            emit({
              kind: "info",
              message: "- git reset --hard " + preResetRefTarget,
            });
          }
        } else if (method === "reset" && resetOldestSha) {
          emit({
            kind: "info",
            message: "- git reset --hard " + resetOldestSha + "~1",
          });
        }

        return 0;
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
      let preResetRef: string | null = null;

      try {
        if (method === "revert") {
          for (const operation of executionOperations) {
            if (operation.type !== "commit") {
              continue;
            }

            const run = operation.run;
            const commitSha = operation.ref;
            attemptedRunIds.push(run.runId);
            emit({ kind: "info", message: "Reverting commit " + commitSha + " (run " + run.runId + ")." });
            try {
              await dependencies.gitClient.run(["revert", commitSha, "--no-edit"], cwd);
              successfulRunIds.push(run.runId);
            } catch (error) {
              failedRunId = run.runId;
              if (hasMultiRunSelection) {
                emit({
                  kind: "error",
                  message: "Revert stopped on " + run.runId + " after " + successfulRunIds.length
                    + " successful run(s).",
                });
              }

              const failureMessage = error instanceof Error ? error.message : String(error);
              throw new Error("Failed to revert run " + run.runId + " (" + commitSha + "): " + failureMessage);
            }
          }
        } else {
          preResetRef = (await dependencies.gitClient.run(["rev-parse", "HEAD"], cwd)).trim();
          for (const run of executionRuns) {
            attemptedRunIds.push(run.runId);
          }

          const preResetRefTarget = executionOperations[0]?.type === "pre-reset-ref"
            ? executionOperations[0].ref
            : null;
          if (preResetRefTarget) {
            emit({ kind: "info", message: "Resetting to saved pre-reset ref " + preResetRefTarget + "." });
            await dependencies.gitClient.run(["reset", "--hard", preResetRefTarget], cwd);
          } else {
            const oldestSha = resetOldestSha;
            if (!oldestSha) {
              throw new Error("No commit SHAs available for reset.");
            }
            emit({ kind: "info", message: "Resetting to " + oldestSha + "~1." });
            await dependencies.gitClient.run(["reset", "--hard", `${oldestSha}~1`], cwd);
          }
          successfulRunIds.push(...executionRuns.map((run) => run.runId));
        }

        dependencies.artifactStore.finalize(artifactContext, {
          status: "reverted",
          preserve: keepArtifacts,
          extra: {
            method,
            runIds: executionRuns.map((run) => run.runId),
            commitShas: executionRuns
              .map((run) => getCommitSha(run))
              .filter((sha): sha is string => sha !== null),
            ...(method === "reset" && preResetRef ? { preResetRef } : {}),
            revertedRunIds: successfulRunIds,
            revertedCount: successfulRunIds.length,
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
          message: "Reverted " + executionRuns.length + " run"
            + (executionRuns.length === 1 ? "" : "s")
            + " successfully.",
        });
        return 0;
      } catch (error) {
        dependencies.artifactStore.finalize(artifactContext, {
          status: "revert-failed",
          preserve: keepArtifacts,
          extra: {
            method,
            runIds: executionRuns.map((run) => run.runId),
            attemptedRunIds,
            revertedRunIds: successfulRunIds,
            revertedCount: successfulRunIds.length,
            ...(method === "reset" && preResetRef ? { preResetRef } : {}),
            failedRunId,
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
        return 1;
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

function orderOperationsForMethod(
  operations: RevertOperation[],
  method: RevertTaskOptions["method"],
): RevertOperation[] {
  if (method !== "revert") {
    return operations;
  }

  return [...operations].sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
}

function resolveTargetRunMetadata(
  artifactStore: ArtifactStore,
  cwd: string,
  runId: string,
): ArtifactRunMetadata | null {
  if (runId === "latest") {
    return resolveRevertableRuns(artifactStore, cwd)[0] ?? null;
  }

  return artifactStore.find(runId, cwd);
}

function resolveTargetRuns(
  artifactStore: ArtifactStore,
  cwd: string,
  options: Pick<RevertTaskOptions, "runId" | "last" | "all">,
): ArtifactRunMetadata[] {
  const { runId, last, all } = options;

  if (all) {
    return resolveRevertableRuns(artifactStore, cwd);
  }

  if (last !== undefined) {
    return resolveRevertableRuns(artifactStore, cwd).slice(0, last);
  }

  const selectedRun = resolveTargetRunMetadata(artifactStore, cwd, runId);
  return selectedRun ? [selectedRun] : [];
}

function resolveRevertableRuns(
  artifactStore: ArtifactStore,
  cwd: string,
): ArtifactRunMetadata[] {
  return artifactStore.listSaved(cwd).filter((run) => resolveRevertOperation(run) !== null);
}

function resolveCompletedRuns(
  artifactStore: ArtifactStore,
  cwd: string,
): ArtifactRunMetadata[] {
  return artifactStore.listSaved(cwd).filter((run) => run.status === "completed");
}

function getCommitSha(run: ArtifactRunMetadata): string | null {
  const commitSha = run.extra?.["commitSha"];
  if (typeof commitSha !== "string" || commitSha.trim() === "") {
    return null;
  }

  return commitSha.trim();
}

function getPreResetRef(run: ArtifactRunMetadata): string | null {
  const preResetRef = run.extra?.["preResetRef"];
  if (typeof preResetRef !== "string" || preResetRef.trim() === "") {
    return null;
  }

  return preResetRef.trim();
}

function resolveRevertOperation(run: ArtifactRunMetadata): RevertOperation | null {
  const commitSha = getCommitSha(run);
  if (run.status === "completed" && commitSha) {
    return {
      run,
      type: "commit",
      ref: commitSha,
    };
  }

  const preResetRef = getPreResetRef(run);
  const method = run.extra?.["method"];
  if (
    run.status === "reverted"
    && run.commandName === "revert"
    && method === "reset"
    && preResetRef
  ) {
    return {
      run,
      type: "pre-reset-ref",
      ref: preResetRef,
    };
  }

  return null;
}

async function isGitRepoWithGitClient(gitClient: GitClient, cwd: string): Promise<boolean> {
  try {
    const output = await gitClient.run(["rev-parse", "--is-inside-work-tree"], cwd);
    return output.trim() === "true";
  } catch {
    return false;
  }
}

async function isWorkingDirectoryClean(gitClient: GitClient, cwd: string): Promise<boolean> {
  const output = await gitClient.run(
    ["status", "--porcelain", "--", ".", ...GIT_ARTIFACT_AND_LOCK_EXCLUDES],
    cwd,
  );
  return output.trim().length === 0;
}

async function validateTargetCommitsExistInHistory(
  gitClient: GitClient,
  cwd: string,
  operations: RevertOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.type !== "commit") {
      continue;
    }

    const run = operation.run;
    const commitSha = operation.ref;
    let objectType: string;
    try {
      objectType = await gitClient.run(["cat-file", "-t", commitSha], cwd);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        "Run " + run.runId + " commit " + commitSha + " was not found in git history: " + reason,
      );
    }
    if (objectType.trim() !== "commit") {
      throw new Error("Run " + run.runId + " commit " + commitSha + " is not a commit object.");
    }
  }
}

async function validateResetTargetsAtHead(
  gitClient: GitClient,
  cwd: string,
  operations: RevertOperation[],
): Promise<string> {
  const shas = operations
    .filter((operation) => operation.type === "commit")
    .map((operation) => operation.ref);

  if (shas.length === 0) {
    throw new Error("No commit SHAs available for reset.");
  }

  const uniqueShas = new Set(shas);
  if (uniqueShas.size !== shas.length) {
    throw new Error("Cannot reset: target runs contain duplicate commit SHAs.");
  }

  const hasMultipleTargets = shas.length > 1;

  const headCommitsRaw = await gitClient.run(["rev-list", "--max-count", String(shas.length), "HEAD"], cwd);
  const headCommits = headCommitsRaw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (headCommits.length < shas.length) {
    throw new Error(buildResetNotContiguousMessage({ hasMultipleTargets }));
  }

  for (const headCommit of headCommits) {
    if (!uniqueShas.has(headCommit)) {
      throw new Error(buildResetNotContiguousMessage({ hasMultipleTargets }));
    }
  }

  const oldest = headCommits[headCommits.length - 1];
  if (!oldest) {
    throw new Error("No commit SHAs available for reset.");
  }

  return oldest;
}

function buildResetNotContiguousMessage(options: { hasMultipleTargets: boolean }): string {
  const baseMessage = "Cannot reset: target commits are not a contiguous block at HEAD.";
  if (!options.hasMultipleTargets) {
    return baseMessage;
  }

  return baseMessage
    + " Non-rundown commits may be interleaved with selected runs."
    + " Use --method revert for bulk revert in this history.";
}

function resolveOldestResetTarget(operations: RevertOperation[]): string {
  const commitOperations = operations.filter((operation) => operation.type === "commit");
  if (commitOperations.length === 0) {
    throw new Error("No commit SHAs available for reset.");
  }

  const oldestOperation = [...commitOperations].sort((a, b) => a.run.startedAt.localeCompare(b.run.startedAt))[0];
  if (!oldestOperation) {
    throw new Error("No commit SHAs available for reset.");
  }

  return oldestOperation.ref;
}

async function validatePreResetRefTargetsExistInHistory(
  gitClient: GitClient,
  cwd: string,
  operations: RevertOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.type !== "pre-reset-ref") {
      continue;
    }

    let objectType: string;
    try {
      objectType = await gitClient.run(["cat-file", "-t", operation.ref], cwd);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        "Run " + operation.run.runId + " preResetRef " + operation.ref + " was not found in git history: " + reason,
      );
    }

    if (objectType.trim() !== "commit") {
      throw new Error("Run " + operation.run.runId + " preResetRef " + operation.ref + " is not a commit object.");
    }
  }
}

function formatTaskLabel(run: ArtifactRunMetadata): string {
  if (!run.task) {
    return "(task metadata unavailable)";
  }

  return `${run.task.file}:${run.task.line} [#${run.task.index}] ${run.task.text}`;
}

function isTaskFileMissing(
  run: ArtifactRunMetadata,
  cwd: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): boolean {
  if (!run.task?.file) {
    return false;
  }

  const resolvedTaskFile = pathOperations.isAbsolute(run.task.file)
    ? run.task.file
    : pathOperations.resolve(cwd, run.task.file);

  return !fileSystem.exists(resolvedTaskFile);
}

function collectRevertLockTargets(
  runs: ArtifactRunMetadata[],
  cwd: string,
  pathOperations: PathOperationsPort,
): string[] {
  const lockTargets = new Set<string>();

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

export const revertTask = createRevertTask;
