import type { SortMode } from "../domain/sorting.js";
import { resolveRunBehavior } from "../domain/run-options.js";
import {
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import { runTraceOnlyEnrichment } from "./trace-only-enrichment.js";
import { createTraceRunSession } from "./trace-run-session.js";
import { runTraceEnrichment } from "./trace-enrichment.js";
import {
  checkTaskUsingFileSystem,
  maybeResetFileCheckboxes,
} from "./checkbox-operations.js";
import {
  afterTaskComplete,
  finalizeRunArtifacts,
} from "./run-lifecycle.js";
import {
  isGitRepoWithGitClient,
  isWorkingDirectoryClean,
} from "./git-operations.js";
import { runTaskIteration } from "./run-task-iteration.js";
import {
  getAutomationWorkerCommand,
  isOpenCodeWorkerCommand,
  type RunnerMode,
} from "./run-task-worker-command.js";
import { toRuntimeTaskMetadata } from "./task-context-resolution.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import type {
  ArtifactRunContext,
  ArtifactStoreStatus,
  ArtifactStore,
  CommandExecutionOptions,
  CommandExecutor,
  FileSystem,
  FileLock,
  GitClient,
  PathOperationsPort,
  ProcessRunner,
  PromptTransport as PortPromptTransport,
  MemoryResolverPort,
  MemoryWriterPort,
  SourceResolverPort,
  TaskRepairPort,
  TaskSelectionResult as PortTaskSelectionResult,
  TaskSelectorPort,
  TaskVerificationPort,
  ConfigDirResult,
  TemplateLoader,
  TemplateVarsLoaderPort,
  TraceWriterPort,
  VerificationStore,
  WorkerConfigPort,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

export type PromptTransport = PortPromptTransport;
type ArtifactContext = ArtifactRunContext;
type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

export type TaskSelectionResult = PortTaskSelectionResult;

export type { RuntimeTaskMetadata } from "./task-context-resolution.js";
export { toRuntimeTaskMetadata } from "./task-context-resolution.js";
export { finalizeRunArtifacts } from "./run-lifecycle.js";
export { getAutomationWorkerCommand, isOpenCodeWorkerCommand };
export type { RunnerMode };

/**
 * Dependency bundle required to construct the `run` command execution flow.
 */
export interface RunTaskDependencies {
  sourceResolver: SourceResolverPort;
  taskSelector: TaskSelectorPort;
  workerExecutor: WorkerExecutorPort;
  taskVerification: TaskVerificationPort;
  taskRepair: TaskRepairPort;
  workingDirectory: WorkingDirectoryPort;
  fileSystem: FileSystem;
  fileLock: FileLock;
  templateLoader: TemplateLoader;
  verificationStore: VerificationStore;
  artifactStore: ArtifactStore;
  gitClient: GitClient;
  processRunner: ProcessRunner;
  pathOperations: PathOperationsPort;
  templateVarsLoader: TemplateVarsLoaderPort;
  workerConfigPort: WorkerConfigPort;
  memoryResolver?: MemoryResolverPort;
  memoryWriter?: MemoryWriterPort;
  traceWriter: TraceWriterPort;
  configDir: ConfigDirResult | undefined;
  createTraceWriter: (trace: boolean, artifactContext: ArtifactContext) => TraceWriterPort;
  output: ApplicationOutputPort;
  cliBlockExecutor?: CommandExecutor;
}

/**
 * Runtime options accepted by the `run` command entry point.
 */
export interface RunTaskOptions {
  source: string;
  mode: RunnerMode;
  transport: PromptTransport;
  sortMode: SortMode;
  verify: boolean;
  onlyVerify: boolean;
  forceExecute: boolean;
  noRepair: boolean;
  repairAttempts: number;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
  commitAfterComplete: boolean;
  commitMessageTemplate?: string;
  onCompleteCommand?: string;
  runAll: boolean;
  redo: boolean;
  resetAfter: boolean;
  clean: boolean;
  rounds: number;
  onFailCommand?: string;
  showAgentOutput: boolean;
  trace: boolean;
  traceOnly: boolean;
  forceUnlock: boolean;
  cliBlockTimeoutMs?: number;
  ignoreCliBlock: boolean;
}

/**
 * Creates the run-task executor that processes task selection, execution,
 * verification, repair, artifact lifecycle, tracing, and completion hooks.
 */
export function createRunTaskExecution(
  dependencies: RunTaskDependencies,
): (options: RunTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);
  // Provide a no-op CLI executor when none is injected by the caller.
  const cliBlockExecutor = dependencies.cliBlockExecutor ?? {
    async execute() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
      };
    },
  };

  return async function runTask(options: RunTaskOptions): Promise<number> {
    const {
      source,
      mode,
      transport,
      sortMode,
      verify,
      onlyVerify,
      forceExecute,
      noRepair,
      repairAttempts,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
      commitAfterComplete,
      commitMessageTemplate,
      onCompleteCommand,
      runAll,
      redo,
      resetAfter,
      clean,
      rounds,
      onFailCommand,
      showAgentOutput,
      trace,
      traceOnly,
      forceUnlock,
      cliBlockTimeoutMs,
      ignoreCliBlock,
    } = options;

    // Build optional timeout configuration for template CLI blocks.
    const cliExecutionOptions: CommandExecutionOptions | undefined = cliBlockTimeoutMs === undefined
      ? undefined
      : { timeoutMs: cliBlockTimeoutMs };
    // Suppress CLI expansion in dry runs unless prompt rendering is explicitly requested.
    const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
    // Enable CLI expansion only when globally allowed and not suppressed by dry-run mode.
    const cliExpansionEnabled = !ignoreCliBlock && !dryRunSuppressesCliExpansion;
    // Keep hook output visible by default in the top-level run command.
    const hideHookOutput = false;

    // Trace-only mode enriches existing traces without running normal task flow.
    if (traceOnly) {
      return runTraceOnlyEnrichment({
        workingDirectory: dependencies.workingDirectory,
        configDir: dependencies.configDir,
        artifactStore: dependencies.artifactStore,
        fileSystem: dependencies.fileSystem,
        pathOperations: dependencies.pathOperations,
        templateLoader: dependencies.templateLoader,
        workerExecutor: dependencies.workerExecutor,
        createTraceWriter: dependencies.createTraceWriter,
        emit,
      }, {
        transport,
        workerCommand,
      });
    }

    // Reject incompatible flags that would conflict with verify-only execution.
    if (onlyVerify && (redo || resetAfter || clean)) {
      emit({
        kind: "error",
        message: "--redo, --reset-after, and --clean cannot be combined with --only-verify.",
      });
      return 1;
    }

    if (!Number.isInteger(rounds) || rounds <= 0) {
      emit({
        kind: "error",
        message: "--rounds must be a positive integer.",
      });
      return 1;
    }

    if (rounds > 1 && !(clean || (redo && resetAfter))) {
      emit({
        kind: "error",
        message: "--rounds > 1 requires --clean or both --redo and --reset-after.",
      });
      return 1;
    }

    // `--redo` and `--clean` imply full-run behavior across all tasks.
    const effectiveRunAll = runAll || redo || clean;
    if (!runAll && (redo || clean)) {
      const impliedByFlag = clean ? "--clean" : "--redo";
      emit({ kind: "info", message: impliedByFlag + " implies --all; running all tasks." });
    }

    // Resolve effective verification/repair behavior from CLI flags.
    const runBehavior = resolveRunBehavior({ verify, onlyVerify, noRepair, repairAttempts });
    const configuredShouldVerify = runBehavior.shouldVerify;
    const configuredOnlyVerify = runBehavior.onlyVerify;
    const allowRepair = runBehavior.allowRepair;
    const maxRepairAttempts = runBehavior.maxRepairAttempts;

    // Load template variables from optional file and merge CLI-provided overrides.
    const varsFilePath = resolveTemplateVarsFilePath(varsFileOption, dependencies.configDir?.configDir);
    const fileTemplateVars = varsFilePath
      ? dependencies.templateVarsLoader.load(
        varsFilePath,
        dependencies.workingDirectory.cwd(),
        dependencies.configDir?.configDir,
      )
      : {};
    const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs);
    const extraTemplateVars: ExtraTemplateVars = {
      ...fileTemplateVars,
      ...cliTemplateVars,
    };
    // Load worker defaults from config when a config directory is available.
    const loadedWorkerConfig = dependencies.configDir?.configDir
      ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
      : undefined;

    // Initialize run-scoped mutable state shared across task iterations.
    const state: Parameters<typeof runTaskIteration>[0]["state"] = {
      artifactContext: null,
      traceWriter: dependencies.traceWriter,
      traceEnrichmentContext: null,
      deferredCommitContext: null,
      tasksCompleted: 0,
      runCompleted: false,
    };
    let artifactsFinalized = false;
    let runFailed = false;
    let unexpectedError: unknown;
    let resolvedFiles: string[] = [];
    const pendingPreRunResetTraceEvents: Array<{ file: string; resetCount: number; dryRun: boolean }> = [];
    // Defer commit until all post-run reset actions complete when required.
    const deferCommitUntilPostRun = commitAfterComplete && resetAfter;
    let currentRound = 1;
    // Use an injectable timestamp provider for prompt/template rendering.
    const nowIso = (): string => new Date().toISOString();
    // Create a trace session that aggregates run and task lifecycle events.
    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => state.traceWriter,
      source,
      mode,
      transport,
      traceEnabled: trace,
    });

    // Finalize artifact storage exactly once per run with optional metadata.
    const finalizeArtifacts = (
      status: ArtifactStoreStatus,
      preserve: boolean = keepArtifacts,
      extra?: Record<string, unknown>,
    ): void => {
      if (!state.artifactContext || artifactsFinalized) {
        return;
      }

      state.traceWriter.flush();
      finalizeRunArtifacts(dependencies.artifactStore, state.artifactContext, preserve, status, emit, extra);
      artifactsFinalized = true;
    };

    // Emit final trace events, run enrichment, and return the command exit code.
    const finishRun = async (
      code: number,
      status: ArtifactStoreStatus,
      preserve: boolean = keepArtifacts,
      failure?: { reason: string; exitCode: number | null },
      extra?: Record<string, unknown>,
    ): Promise<number> => {
      const roundMetadata = {
        rounds,
        currentRound,
      };
      const finalExtra = extra
        ? {
          ...extra,
          ...roundMetadata,
        }
        : roundMetadata;
      traceRunSession.emitRoundCompleted(currentRound, rounds);
      traceRunSession.emitTaskOutcome(status, failure);
      await runTraceEnrichment({
        trace,
        status,
        artifactContext: state.artifactContext,
        traceRunSession,
        traceEnrichmentContext: state.traceEnrichmentContext,
        dependencies,
        transport,
        emit,
      });
      traceRunSession.emitDeferredEvents();
      traceRunSession.emitRunCompleted(status);
      finalizeArtifacts(status, preserve, finalExtra);
      return code;
    };

    // Mark the run as failed and delegate shared finalization behavior.
    const failRun = async (
      code: number,
      status: ArtifactStoreStatus,
      reason: string,
      exitCode: number | null,
      preserve: boolean = keepArtifacts,
    ): Promise<number> => {
      state.runCompleted = exitCode !== null;
      runFailed = true;
      return finishRun(code, status, preserve, { reason, exitCode });
    };

    // Clear per-iteration artifacts so the next task starts from a clean context.
    const resetArtifacts = (): void => {
      state.artifactContext = null;
      state.traceWriter = dependencies.traceWriter;
      artifactsFinalized = false;
      state.traceEnrichmentContext = null;
      traceRunSession.reset();
    };

    try {
      // Resolve source globs/files into concrete markdown task files.
      const files = await dependencies.sourceResolver.resolveSources(source);
      resolvedFiles = files;
      if (files.length === 0) {
        emit({ kind: "warn", message: "No Markdown files found matching: " + source });
        return 3;
      }

      // Lock all source files to prevent concurrent rundown workers from colliding.
      const lockTargets = Array.from(new Set(files));
      if (forceUnlock) {
        for (const filePath of lockTargets) {
          if (dependencies.fileLock.isLocked(filePath)) {
            continue;
          }

          dependencies.fileLock.forceRelease(filePath);
          emit({ kind: "info", message: "Force-unlocked stale source lock: " + filePath });
        }
      }

      // Acquire run locks for each source before any task mutation begins.
      try {
        for (const filePath of lockTargets) {
          dependencies.fileLock.acquire(filePath, { command: "run" });
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
              + "). If this lock is stale, rerun with --force-unlock or run `rundown unlock "
              + error.filePath
              + "`.",
          });
          return 1;
        }
        throw error;
      }

      // `--commit` requires a clean git repository before task execution starts.
      if (commitAfterComplete) {
        const cwd = dependencies.workingDirectory.cwd();
        const inGitRepo = await isGitRepoWithGitClient(dependencies.gitClient, cwd);
        if (!inGitRepo) {
          emit({ kind: "warn", message: "--commit: not inside a git repository, skipping." });
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
              message: "--commit: working directory is not clean. Commit or stash changes before using --commit.",
            });
            return 1;
          }
        }
      }

      const runTaskLoop = async (
        files: string[],
        emitCompletionMessage: boolean,
      ): Promise<number> => {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Select the next available task using the configured sort strategy.
          const result = dependencies.taskSelector.selectNextTask(files, sortMode);
          if (!result) {
            state.runCompleted = true;
            if (state.tasksCompleted > 0) {
              if (emitCompletionMessage) {
                emit({ kind: "success", message: "All tasks completed (" + state.tasksCompleted + " total)." });
              }
              return 0;
            }
            emit({ kind: "info", message: "No unchecked tasks found." });
            return 3;
          }

          // Execute one full task iteration and inspect control-flow instructions.
          const iterationResult = await runTaskIteration({
            dependencies,
            emit,
            state,
            context: {
              source,
              fileSource: result.source,
              files,
              task: result.task,
            },
            execution: {
              mode,
              transport,
              keepArtifacts,
              printPrompt,
              dryRun,
              dryRunSuppressesCliExpansion,
              cliExpansionEnabled,
              ignoreCliBlock,
              verify,
              noRepair,
              repairAttempts,
              forceExecute,
              showAgentOutput,
              hideHookOutput,
              trace,
            },
            worker: {
              workerCommand,
              loadedWorkerConfig,
            },
            verifyConfig: {
              configuredOnlyVerify,
              configuredShouldVerify,
              maxRepairAttempts,
              allowRepair,
            },
            completion: {
              effectiveRunAll,
              commitAfterComplete,
              deferCommitUntilPostRun,
              commitMessageTemplate,
              onCompleteCommand,
              onFailCommand,
            },
            prompts: {
              extraTemplateVars,
              cliExecutionOptions,
              cliBlockExecutor,
              nowIso,
            },
            traceConfig: {
              traceRunSession,
              pendingPreRunResetTraceEvents,
              roundContext: {
                currentRound,
                totalRounds: rounds,
              },
            },
            lifecycle: {
              failRun,
              finishRun,
              resetArtifacts,
            },
          });

          if (!iterationResult.continueLoop) {
            return iterationResult.exitCode ?? 0;
          }
        }
      };

      const resetRoundExecutionState = (): void => {
        state.runCompleted = false;
        state.tasksCompleted = 0;
      };

      let totalTasksCompletedAcrossRounds = 0;
      resetRoundExecutionState();
      for (let round = 0; round < rounds; round++) {
        currentRound = round + 1;
        if (round > 0) {
          resetRoundExecutionState();
        }

        if (rounds > 1) {
          emit({
            kind: "info",
            message: "Round " + (round + 1) + "/" + rounds + " - resetting checkboxes and running all tasks...",
          });
        }

        // `--redo` resets checked tasks before selection so they can run again.
        if (redo) {
          for (const filePath of files) {
            const resetCount = maybeResetFileCheckboxes(
              filePath,
              dependencies.fileSystem,
              dryRun,
              emit,
              "pre-run",
            );
            pendingPreRunResetTraceEvents.push({ file: filePath, resetCount, dryRun });
          }
        }

        const shouldEmitRoundCompletion = rounds === 1 || round === rounds - 1;
        const roundExitCode = await runTaskLoop(files, shouldEmitRoundCompletion);
        if (roundExitCode !== 0 || !state.runCompleted) {
          return roundExitCode;
        }

        totalTasksCompletedAcrossRounds += state.tasksCompleted;

        if (round < rounds - 1 && resetAfter && state.runCompleted) {
          for (const filePath of files) {
            const resetCount = maybeResetFileCheckboxes(
              filePath,
              dependencies.fileSystem,
              dryRun,
              emit,
              "post-run",
            );
            traceRunSession.emitResetPhase("post-run-reset", filePath, resetCount, dryRun);
          }
        }
      }

      if (rounds > 1) {
        emit({
          kind: "success",
          message:
            "All "
            + rounds
            + " rounds completed successfully ("
            + totalTasksCompletedAcrossRounds
            + " tasks total).",
        });
      }

      return 0;
    } catch (error) {
      // Preserve unexpected errors so finalization can emit failed trace status.
      unexpectedError = error;
      throw error;
    } finally {
      // Reset task checkboxes after a successful run when post-run reset is requested.
      if (resetAfter && state.runCompleted) {
        for (const filePath of resolvedFiles) {
          const resetCount = maybeResetFileCheckboxes(
            filePath,
            dependencies.fileSystem,
            dryRun,
            emit,
            "post-run",
          );
          traceRunSession.emitResetPhase("post-run-reset", filePath, resetCount, dryRun);
        }
      }

      // Run deferred commit after all iterations and post-run reset actions finish.
      if (state.deferredCommitContext && !runFailed) {
        await afterTaskComplete(
          dependencies,
          state.deferredCommitContext.task,
          state.deferredCommitContext.source,
          true,
          commitMessageTemplate,
          undefined,
          hideHookOutput,
        );
      }

      // Best-effort lock cleanup to avoid stale lock files after command exit.
      try {
        dependencies.fileLock.releaseAll();
      } catch (error) {
        emit({ kind: "warn", message: "Failed to release file locks: " + String(error) });
      }

      // Ensure trace/artifact failure metadata is written for uncaught exceptions.
      if (unexpectedError) {
        traceRunSession.emitTaskOutcome("failed", {
          reason: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
          exitCode: null,
        });
        await runTraceEnrichment({
          trace,
          status: "failed",
          artifactContext: state.artifactContext,
          traceRunSession,
          traceEnrichmentContext: state.traceEnrichmentContext,
          dependencies,
          transport,
          emit,
        });
        traceRunSession.emitDeferredEvents();
        traceRunSession.emitRunCompleted("failed");
        finalizeArtifacts("failed", keepArtifacts || mode === "detached", {
          rounds,
          currentRound,
        });
      }

      // Flush any buffered trace output as the final shutdown step.
      state.traceWriter.flush();
    }
  };
}
