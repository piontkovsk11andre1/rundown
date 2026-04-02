import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import {
  isGitRepoWithGitClient,
  isPathInsideRepo,
  isWorkingDirectoryClean,
  resolveGitArtifactAndLockExcludes,
} from "./git-operations.js";
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
 * External services required to resolve saved runs, perform git operations,
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
 * User-provided options that control target selection and revert strategy.
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

// Base explanation shown when no run can be reverted from saved artifacts.
const NO_REVERTABLE_RUNS_BASE_MESSAGE = "No revertable runs found. The original run must be completed with --commit and --keep-artifacts so run.json contains extra.commitSha.";
// Extra discovery hint appended when there are runs that can be inspected in logs.
const REVERTABLE_LOG_HINT = "See `rundown log --revertable` for eligible runs.";

/**
 * Normalized git target resolved from a saved run.
 *
 * - `commit`: a completed run with a commit SHA to revert/reset.
 * - `pre-reset-ref`: a prior reset revert run that recorded the original HEAD.
 */
interface RevertOperation {
  run: ArtifactRunMetadata;
  type: "commit" | "pre-reset-ref";
  ref: string;
}

/**
 * Builds the application-level `revert` command handler.
 *
 * The returned function resolves target runs from artifacts, validates git
 * preconditions, performs either `git revert` or `git reset --hard`, and then
 * records the terminal result in a new runtime artifact entry.
 */
export function createRevertTask(
  dependencies: RevertTaskDependencies,
): (options: RevertTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function revertTask(options: RevertTaskOptions): Promise<number> {
    const { runId, last, all, method, dryRun, keepArtifacts, force } = options;
    // Multi-run mode is enabled when `--all` or `--last` is supplied.
    const hasMultiRunSelection = all === true || last !== undefined;

    // Guard incompatible selectors early to keep behavior predictable.
    if (all && last !== undefined) {
      emit({ kind: "error", message: "Cannot combine --all with --last." });
      return 3;
    }

    // Explicit run ids cannot be mixed with bulk selectors.
    if (hasMultiRunSelection && runId !== "latest") {
      emit({ kind: "error", message: "Cannot combine --run <id> with --all or --last." });
      return 3;
    }

    // `--last` accepts only positive integer counts.
    if (last !== undefined && (!Number.isInteger(last) || last < 1)) {
      emit({ kind: "error", message: "--last must be a positive integer." });
      return 3;
    }

    const cwd = dependencies.workingDirectory.cwd();
    const artifactBaseDir = dependencies.configDir?.configDir;
    // Selected runs can include non-revertable runs (for example metadata-only entries).
    const selectedRuns = resolveTargetRuns(dependencies.artifactStore, artifactBaseDir, { runId, last, all });
    // Completed runs are used only to provide clearer diagnostics.
    const completedRuns = resolveCompletedRuns(dependencies.artifactStore, artifactBaseDir);

    // Report selection failures with context-sensitive guidance.
    if (selectedRuns.length === 0) {
      if (completedRuns.length > 0) {
        emit({
          kind: "error",
          message: buildNoRevertableRunsMessage(true),
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

    // Convert saved runs into executable git targets.
    const revertOperations = selectedRuns
      .map(resolveRevertOperation)
      .filter((operation): operation is RevertOperation => operation !== null);
    if (revertOperations.length === 0) {
      emit({
        kind: "error",
        message: buildNoRevertableRunsMessage(completedRuns.length > 0),
      });
      return 3;
    }

    // `pre-reset-ref` entries represent prior reset reverts and must be replayed one-at-a-time.
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

    // Revert mode processes newest-first to reduce conflict risk.
    const executionOperations = orderOperationsForMethod(revertOperations, method);
    const executionRuns = executionOperations.map((operation) => operation.run);

    // Lock every referenced task/source file before mutating git state.
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
      // Missing task files are informational only; git history still provides commit references.
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

      // Revert/reset requires repository context and optionally a clean worktree.
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
        const isClean = await isWorkingDirectoryClean(
          dependencies.gitClient,
          cwd,
          dependencies.configDir,
          dependencies.pathOperations,
        );
        if (!isClean) {
          emit({
            kind: "error",
            message: "Working directory is not clean. Commit or stash changes before running revert.",
          });
          return 1;
        }
      }

      // For reset mode, this tracks the oldest selected commit used to compute `<sha>~1`.
      let resetOldestSha: string | null = null;

      try {
        // Validate commit-backed targets first so failures are reported before execution.
        const commitOperations = executionOperations.filter((operation) => operation.type === "commit");
        if (commitOperations.length > 0) {
          await validateTargetCommitsExistInHistory(dependencies.gitClient, cwd, commitOperations);
        }

        // Reset mode must target a contiguous HEAD block unless force bypasses that safety check.
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

        // Validate pre-reset refs when reverting a prior reset operation.
        await validatePreResetRefTargetsExistInHistory(dependencies.gitClient, cwd, executionOperations);
      } catch (error) {
        emit({ kind: "error", message: String(error) });
        return 1;
      }

      // Dry-run prints planned actions without mutating git history.
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

      // Create a fresh artifact context for this revert invocation.
      const artifactContext = dependencies.artifactStore.createContext({
        cwd,
        commandName: "revert",
        mode: "wait",
        source: executionRuns[0]?.source,
        task: executionRuns.length === 1 ? executionRuns[0]?.task : undefined,
        keepArtifacts,
      });

      // Keep detailed progress for robust artifact finalization on success/failure.
      const successfulRunIds: string[] = [];
      const attemptedRunIds: string[] = [];
      let failedRunId: string | null = null;
      // Captures HEAD before reset so follow-up operations can be reverted later.
      let preResetRef: string | null = null;

      try {
        if (method === "revert") {
          // Replay `git revert --no-edit` per selected commit.
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
          // Record current HEAD before destructive reset to preserve rollback metadata.
          preResetRef = (await dependencies.gitClient.run(["rev-parse", "HEAD"], cwd)).trim();
          for (const run of executionRuns) {
            attemptedRunIds.push(run.runId);
          }

          // When reverting a prior reset, use the saved pre-reset ref directly.
          const preResetRefTarget = executionOperations[0]?.type === "pre-reset-ref"
            ? executionOperations[0].ref
            : null;
          if (preResetRefTarget) {
            emit({ kind: "info", message: "Resetting to saved pre-reset ref " + preResetRefTarget + "." });
            await dependencies.gitClient.run(["reset", "--hard", preResetRefTarget], cwd);
          } else {
            // Standard reset mode moves HEAD to one commit before the oldest target.
            const oldestSha = resetOldestSha;
            if (!oldestSha) {
              throw new Error("No commit SHAs available for reset.");
            }
            emit({ kind: "info", message: "Resetting to " + oldestSha + "~1." });
            await dependencies.gitClient.run(["reset", "--hard", `${oldestSha}~1`], cwd);
          }
          successfulRunIds.push(...executionRuns.map((run) => run.runId));
        }

        // Persist success metadata so this revert can itself be audited/reverted later.
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

        // Optionally expose artifact location for follow-up inspection.
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
        // Persist partial progress for debuggability when execution fails mid-stream.
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
      // Always release locks, even after early returns or thrown errors.
      try {
        dependencies.fileLock.releaseAll();
      } catch (error) {
        emit({ kind: "warn", message: "Failed to release file locks: " + String(error) });
      }
    }
  };
}

/**
 * Orders operations according to execution method requirements.
 *
 * Revert mode processes newest-first so each inverse commit is applied on top of
 * current HEAD in natural reverse chronological order.
 */
function orderOperationsForMethod(
  operations: RevertOperation[],
  method: RevertTaskOptions["method"],
): RevertOperation[] {
  if (method !== "revert") {
    return operations;
  }

  return [...operations].sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt));
}

/**
 * Resolves a single target run from user selection semantics.
 */
function resolveTargetRunMetadata(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
  runId: string,
): ArtifactRunMetadata | null {
  if (runId === "latest") {
    return resolveRevertableRuns(artifactStore, artifactBaseDir)[0] ?? null;
  }

  return artifactStore.find(runId, artifactBaseDir);
}

/**
 * Resolves all runs targeted by `--run`, `--last`, or `--all`.
 */
function resolveTargetRuns(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
  options: Pick<RevertTaskOptions, "runId" | "last" | "all">,
): ArtifactRunMetadata[] {
  const { runId, last, all } = options;

  if (all) {
    return resolveRevertableRuns(artifactStore, artifactBaseDir);
  }

  if (last !== undefined) {
    return resolveRevertableRuns(artifactStore, artifactBaseDir).slice(0, last);
  }

  const selectedRun = resolveTargetRunMetadata(artifactStore, artifactBaseDir, runId);
  return selectedRun ? [selectedRun] : [];
}

/**
 * Returns saved runs that can currently be transformed into revert operations.
 */
function resolveRevertableRuns(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
): ArtifactRunMetadata[] {
  return artifactStore.listSaved(artifactBaseDir).filter((run) => resolveRevertOperation(run) !== null);
}

/**
 * Returns saved runs with `completed` status for diagnostics and selection UX.
 */
function resolveCompletedRuns(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
): ArtifactRunMetadata[] {
  return artifactStore.listSaved(artifactBaseDir).filter((run) => run.status === "completed");
}

/**
 * Reads and normalizes `extra.commitSha` from run metadata.
 */
function getCommitSha(run: ArtifactRunMetadata): string | null {
  const commitSha = run.extra?.["commitSha"];
  if (typeof commitSha !== "string" || commitSha.trim() === "") {
    return null;
  }

  return commitSha.trim();
}

/**
 * Reads and normalizes `extra.preResetRef` from run metadata.
 */
function getPreResetRef(run: ArtifactRunMetadata): string | null {
  const preResetRef = run.extra?.["preResetRef"];
  if (typeof preResetRef !== "string" || preResetRef.trim() === "") {
    return null;
  }

  return preResetRef.trim();
}

/**
 * Converts saved run metadata into an executable git target.
 *
 * A run is revertable when either:
 * - it is `completed` and recorded `extra.commitSha`, or
 * - it is a prior `revert --method reset` run that recorded `extra.preResetRef`.
 */
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

/**
 * Ensures every commit target exists and resolves to a commit object.
 */
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

/**
 * Validates reset safety by ensuring target commits are exactly the top `N`
 * commits at HEAD, then returns the oldest commit in that contiguous block.
 */
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

/**
 * Builds a reset-contiguity failure message with optional multi-target guidance.
 */
function buildResetNotContiguousMessage(options: { hasMultipleTargets: boolean }): string {
  const baseMessage = "Cannot reset: target commits are not a contiguous block at HEAD.";
  if (!options.hasMultipleTargets) {
    return baseMessage;
  }

  return baseMessage
    + " Non-rundown commits may be interleaved with selected runs."
    + " Use --method revert for bulk revert in this history.";
}

/**
 * Resolves the oldest commit target by run start time for force-reset fallback.
 */
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

/**
 * Ensures every `pre-reset-ref` target exists and points to a commit object.
 */
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

/**
 * Formats task metadata for user-facing diagnostics.
 */
function formatTaskLabel(run: ArtifactRunMetadata): string {
  if (!run.task) {
    return "(task metadata unavailable)";
  }

  return `${run.task.file}:${run.task.line} [#${run.task.index}] ${run.task.text}`;
}

/**
 * Detects whether the task file referenced by a run still exists on disk.
 */
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

/**
 * Collects unique absolute file paths that must be locked for this revert.
 *
 * Task file paths are preferred; source file paths are used as a fallback when
 * task metadata is unavailable.
 */
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

/**
 * Builds the user-facing message when no revertable runs are available.
 */
function buildNoRevertableRunsMessage(includeLogHint: boolean): string {
  if (!includeLogHint) {
    return NO_REVERTABLE_RUNS_BASE_MESSAGE;
  }

  return NO_REVERTABLE_RUNS_BASE_MESSAGE + " " + REVERTABLE_LOG_HINT;
}
