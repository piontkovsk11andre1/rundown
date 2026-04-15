import type { SortMode } from "../domain/sorting.js";
import { resolveRunBehavior } from "../domain/run-options.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import {
  buildRundownVarEnv,
  formatTemplateVarsForPrompt,
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
import { parseTasks } from "../domain/parser.js";
import { filterRunnable } from "../domain/task-selection.js";
import {
  afterTaskComplete,
  OnCompleteCommitError,
  finalizeRunArtifacts,
} from "./run-lifecycle.js";
import {
  isGitRepoWithGitClient,
  isWorkingDirectoryClean,
} from "./git-operations.js";
import { runTaskIteration } from "./run-task-iteration.js";
import { extractForceModifier } from "../domain/prefix-chain.js";
import { applyTraceStatisticsDefaults } from "../domain/worker-config.js";
import type { WorkerHealthPolicyConfig } from "../domain/worker-config.js";
import { createCachedCommandExecutor } from "./cached-command-executor.js";
import { formatNoItemsFound, formatNoItemsFoundMatching, pluralize } from "./run-task-utils.js";
import {
  resolvePredictionWorkspaceDirectories,
  resolvePredictionWorkspacePaths,
  resolvePredictionWorkspacePlacement,
} from "./prediction-workspace-paths.js";
import {
  buildWorkspaceContextTemplateVars,
  mergeTemplateVarsWithWorkspaceContext,
  resolveRuntimeWorkspaceContext,
} from "./runtime-workspace-context.js";
import { isParallelGroupTaskText } from "../domain/parallel-group.js";
import {
  getAutomationWorkerCommand,
  isOpenCodeWorkerCommand,
  type RunnerMode,
} from "./run-task-worker-command.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { toRuntimeTaskMetadata } from "./task-context-resolution.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import type { WorkerHealthSnapshot } from "../domain/ports/worker-health-store.js";
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
  MemoryResolverPort,
  ToolResolverPort,
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
  WorkerHealthStore,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import {
  buildWorkerHealthProfileKey,
  WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER,
  WORKER_FAILURE_CLASS_SUCCESS,
  WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
  WORKER_FAILURE_CLASS_USAGE_LIMIT,
  WORKER_HEALTH_STATUS_COOLING_DOWN,
  WORKER_HEALTH_STATUS_HEALTHY,
  WORKER_HEALTH_STATUS_UNAVAILABLE,
  buildWorkerHealthWorkerKey,
  type WorkerFailureClass,
  type WorkerHealthEntry,
} from "../domain/worker-health.js";
import { RUN_REASON_VERIFICATION_FAILED } from "../domain/run-reasons.js";

type ArtifactContext = ArtifactRunContext;
type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

export type TaskSelectionResult = PortTaskSelectionResult;

export type { RuntimeTaskMetadata } from "./task-context-resolution.js";
export { toRuntimeTaskMetadata } from "./task-context-resolution.js";
export { finalizeRunArtifacts } from "./run-lifecycle.js";
export { getAutomationWorkerCommand, isOpenCodeWorkerCommand };
export type { RunnerMode };

function resolvePerTaskFailoverAttemptLimit(healthPolicy: WorkerHealthPolicyConfig | undefined, configuredFallbackCount: number): number {
  if (typeof healthPolicy?.maxFailoverAttemptsPerTask === "number") {
    return healthPolicy.maxFailoverAttemptsPerTask;
  }

  return Math.max(0, configuredFallbackCount);
}

function resolveCooldownSecondsForFailureClass(
  failureClass: WorkerFailureClass,
  healthPolicy: WorkerHealthPolicyConfig | undefined,
): number {
  if (failureClass === WORKER_FAILURE_CLASS_USAGE_LIMIT) {
    return healthPolicy?.cooldownSecondsByFailureClass?.usage_limit ?? 900;
  }

  if (failureClass === WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE) {
    return healthPolicy?.cooldownSecondsByFailureClass?.transport_unavailable ?? 0;
  }

  return healthPolicy?.cooldownSecondsByFailureClass?.execution_failure_other ?? 0;
}

function updateWorkerHealthForAttemptOutcome(params: {
  snapshot: WorkerHealthSnapshot;
  workerCommand: readonly string[];
  profileName?: string;
  failureClass: WorkerFailureClass;
  healthPolicy: WorkerHealthPolicyConfig | undefined;
  now: Date;
}): WorkerHealthSnapshot {
  const { snapshot, workerCommand, profileName, failureClass, healthPolicy, now } = params;
  const workerKey = buildWorkerHealthWorkerKey(workerCommand);
  const normalizedProfileName = typeof profileName === "string"
    ? profileName.trim()
    : "";
  const profileKey = normalizedProfileName.length > 0
    ? buildWorkerHealthProfileKey(normalizedProfileName)
    : "";
  const updateTargets: Array<{ source: WorkerHealthEntry["source"]; key: string }> = [
    { source: "worker", key: workerKey },
  ];
  if (profileKey.length > 0) {
    updateTargets.push({ source: "profile", key: profileKey });
  }

  if (updateTargets.every((target) => target.key.length === 0)) {
    return snapshot;
  }

  const nowIso = now.toISOString();
  const entries = [...snapshot.entries];
  for (const target of updateTargets) {
    if (target.key.length === 0) {
      continue;
    }

    const existingIndex = entries.findIndex((entry) => entry.source === target.source && entry.key === target.key);
    const existingEntry = existingIndex >= 0 ? entries[existingIndex] : undefined;
    const currentFailureCount = existingEntry?.failureCountWindow ?? 0;

    let nextEntry: WorkerHealthEntry = {
      key: target.key,
      source: target.source,
      status: WORKER_HEALTH_STATUS_HEALTHY,
      failureCountWindow: currentFailureCount,
      ...(existingEntry?.lastSuccessAt ? { lastSuccessAt: existingEntry.lastSuccessAt } : {}),
    };

    if (failureClass === WORKER_FAILURE_CLASS_SUCCESS) {
      nextEntry = {
        ...nextEntry,
        status: WORKER_HEALTH_STATUS_HEALTHY,
        cooldownUntil: undefined,
        lastFailureClass: WORKER_FAILURE_CLASS_SUCCESS,
        lastSuccessAt: nowIso,
        lastFailureAt: undefined,
        failureCountWindow: 0,
      };
    } else if (failureClass === WORKER_FAILURE_CLASS_USAGE_LIMIT) {
      const cooldownSeconds = resolveCooldownSecondsForFailureClass(failureClass, healthPolicy);
      nextEntry = {
        ...nextEntry,
        status: cooldownSeconds > 0 ? WORKER_HEALTH_STATUS_COOLING_DOWN : WORKER_HEALTH_STATUS_UNAVAILABLE,
        cooldownUntil: cooldownSeconds > 0
          ? new Date(now.getTime() + (cooldownSeconds * 1000)).toISOString()
          : undefined,
        lastFailureClass: failureClass,
        lastFailureAt: nowIso,
        failureCountWindow: currentFailureCount + 1,
      };
    } else if (failureClass === WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE) {
      const unavailableMode = healthPolicy?.unavailableReevaluation?.mode ?? "manual";
      const probeCooldownSeconds = healthPolicy?.unavailableReevaluation?.probeCooldownSeconds
        ?? healthPolicy?.cooldownSecondsByFailureClass?.transport_unavailable
        ?? 300;
      const shouldUseCooldown = unavailableMode === "cooldown";
      nextEntry = {
        ...nextEntry,
        status: shouldUseCooldown ? WORKER_HEALTH_STATUS_COOLING_DOWN : WORKER_HEALTH_STATUS_UNAVAILABLE,
        cooldownUntil: shouldUseCooldown
          ? new Date(now.getTime() + (probeCooldownSeconds * 1000)).toISOString()
          : undefined,
        lastFailureClass: failureClass,
        lastFailureAt: nowIso,
        failureCountWindow: currentFailureCount + 1,
      };
    } else {
      const cooldownSeconds = resolveCooldownSecondsForFailureClass(failureClass, healthPolicy);
      nextEntry = {
        ...nextEntry,
        status: cooldownSeconds > 0 ? WORKER_HEALTH_STATUS_COOLING_DOWN : WORKER_HEALTH_STATUS_HEALTHY,
        cooldownUntil: cooldownSeconds > 0
          ? new Date(now.getTime() + (cooldownSeconds * 1000)).toISOString()
          : undefined,
        lastFailureClass: failureClass,
        lastFailureAt: nowIso,
        failureCountWindow: currentFailureCount + 1,
      };
    }

    if (existingIndex >= 0) {
      entries[existingIndex] = nextEntry;
    } else {
      entries.push(nextEntry);
    }
  }

  return {
    schemaVersion: snapshot.schemaVersion,
    updatedAt: nowIso,
    entries,
  };
}

function isFailoverRetryableFailureClass(
  failureClass: WorkerFailureClass | undefined,
): failureClass is typeof WORKER_FAILURE_CLASS_USAGE_LIMIT | typeof WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE {
  return failureClass === WORKER_FAILURE_CLASS_USAGE_LIMIT
    || failureClass === WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE;
}

interface RetryBoundaryGitCheckpoint {
  stashHash: string;
  reason: "failover" | "force" | "semantic-reset";
  taskFile: string;
  taskLine: number;
}

async function captureRetryBoundaryBaselineStashHash(params: {
  gitClient: GitClient;
  cwd: string;
  configDir: ConfigDirResult | undefined;
  pathOperations: PathOperationsPort;
  taskFile: string;
  taskLine: number;
}): Promise<string | null> {
  const {
    gitClient,
    cwd,
    configDir,
    pathOperations,
    taskFile,
    taskLine,
  } = params;
  const isClean = await isWorkingDirectoryClean(gitClient, cwd, configDir, pathOperations);
  if (isClean) {
    return null;
  }

  const baselineMessage = "rundown retry-baseline "
    + taskFile
    + ":"
    + taskLine
    + " "
    + new Date().toISOString();
  await gitClient.run([
    "stash",
    "push",
    "--include-untracked",
    "--message",
    baselineMessage,
  ], cwd);
  const baselineStashHash = (await gitClient.run(["rev-parse", "--verify", "stash@{0}"], cwd)).trim();
  if (baselineStashHash.length === 0) {
    throw new Error("Failed to capture retry-boundary baseline stash reference.");
  }

  await gitClient.run(["stash", "apply", baselineStashHash], cwd);
  return baselineStashHash;
}

async function preserveGitStateForRetryBoundary(params: {
  gitClient: GitClient;
  cwd: string;
  configDir: ConfigDirResult | undefined;
  pathOperations: PathOperationsPort;
  taskFile: string;
  taskLine: number;
  reason: RetryBoundaryGitCheckpoint["reason"];
  baselineStashHash?: string;
}): Promise<RetryBoundaryGitCheckpoint | null> {
  const {
    gitClient,
    cwd,
    configDir,
    pathOperations,
    taskFile,
    taskLine,
    reason,
    baselineStashHash,
  } = params;
  const isClean = await isWorkingDirectoryClean(gitClient, cwd, configDir, pathOperations);
  if (isClean) {
    return null;
  }

  const stashMessage = "rundown retry-boundary "
    + reason
    + " "
    + taskFile
    + ":"
    + taskLine
    + " "
    + new Date().toISOString();
  await gitClient.run([
    "stash",
    "push",
    "--include-untracked",
    "--message",
    stashMessage,
  ], cwd);
  const stashHash = (await gitClient.run(["rev-parse", "--verify", "stash@{0}"], cwd)).trim();
  if (stashHash.length === 0) {
    throw new Error("Failed to capture retry-boundary stash reference.");
  }

  const isCleanAfterStash = await isWorkingDirectoryClean(gitClient, cwd, configDir, pathOperations);
  if (!isCleanAfterStash) {
    throw new Error("Retry boundary could not produce a clean working tree after stashing.");
  }

  if (typeof baselineStashHash === "string" && baselineStashHash.length > 0) {
    await gitClient.run(["stash", "apply", baselineStashHash], cwd);
  }

  return {
    stashHash,
    reason,
    taskFile,
    taskLine,
  };
}

async function restoreLatestRetryBoundaryGitState(params: {
  gitClient: GitClient;
  cwd: string;
  checkpoint: RetryBoundaryGitCheckpoint;
}): Promise<void> {
  await params.gitClient.run(["stash", "apply", params.checkpoint.stashHash], params.cwd);
}

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
  workerHealthStore?: WorkerHealthStore;
  memoryResolver?: MemoryResolverPort;
  toolResolver?: ToolResolverPort;
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
  cwd?: string;
  invocationDir?: string;
  workspaceDir?: string;
  workspaceLinkPath?: string;
  isLinkedWorkspace?: boolean;
  mode: RunnerMode;
  workerPattern: ParsedWorkerPattern;
  sortMode: SortMode;
  verify: boolean;
  onlyVerify: boolean;
  forceExecute: boolean;
  forceAttempts: number;
  noRepair: boolean;
  repairAttempts: number;
  resolveRepairAttempts?: number;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  commitAfterComplete: boolean;
  commitMode: "per-task" | "file-done";
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
  traceStats?: boolean;
  traceOnly: boolean;
  forceUnlock: boolean;
  cliBlockTimeoutMs?: number;
  ignoreCliBlock: boolean;
  cacheCliBlocks?: boolean;
  verbose: boolean;
  taskTemplateOverride?: string;
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
  const defaultCliBlockExecutor = dependencies.cliBlockExecutor ?? {
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
      workerPattern,
      sortMode,
      verify,
      onlyVerify,
      forceExecute,
      forceAttempts,
      noRepair,
      repairAttempts,
      resolveRepairAttempts = 1,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      commitAfterComplete,
      commitMode,
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
      traceStats = false,
      traceOnly,
      forceUnlock,
      cliBlockTimeoutMs,
      ignoreCliBlock,
      cacheCliBlocks,
      verbose,
      cwd: overriddenCwd,
      invocationDir,
      workspaceDir,
      workspaceLinkPath,
      isLinkedWorkspace,
      taskTemplateOverride,
    } = options;
    const executionCwd = overriddenCwd ?? dependencies.workingDirectory.cwd();
    const runtimeWorkspaceContext = resolveRuntimeWorkspaceContext(
      {
        executionCwd,
        invocationDir,
        workspaceDir,
        workspaceLinkPath,
        isLinkedWorkspace,
      },
      dependencies.pathOperations,
    );
    const workspaceDirectories = resolvePredictionWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
    });
    const workspacePlacement = resolvePredictionWorkspacePlacement({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
    });
    const workspacePaths = resolvePredictionWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
      invocationRoot: runtimeWorkspaceContext.invocationDir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });
    const workspaceContextTemplateVars = buildWorkspaceContextTemplateVars(
      runtimeWorkspaceContext,
      {
        directories: workspaceDirectories,
        placement: workspacePlacement,
        paths: workspacePaths,
      },
    );

    let cliBlockExecutor = cacheCliBlocks
      ? createCachedCommandExecutor(defaultCliBlockExecutor)
      : defaultCliBlockExecutor;

    // Build optional timeout configuration for template CLI blocks.
    let cliExecutionOptions: CommandExecutionOptions | undefined;
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
        workerPattern,
      });
    }

    // Reject incompatible flags that would conflict with verify-only execution.
    if (onlyVerify && (redo || resetAfter || clean)) {
      emit({
        kind: "error",
        message: "--redo, --reset-after, and --clean cannot be combined with --only-verify.",
      });
      return EXIT_CODE_FAILURE;
    }

    if (!Number.isInteger(rounds) || rounds <= 0) {
      emit({
        kind: "error",
        message: "--rounds must be a positive integer.",
      });
      return EXIT_CODE_FAILURE;
    }

    if (rounds > 1 && !(clean || (redo && resetAfter))) {
      emit({
        kind: "error",
        message: "--rounds > 1 requires --clean or both --redo and --reset-after.",
      });
      return EXIT_CODE_FAILURE;
    }

    // `--redo` and `--clean` imply full-run behavior across all tasks.
    const effectiveRunAll = runAll || redo || clean;
    if (!runAll && (redo || clean)) {
      const impliedByFlag = clean ? "--clean" : "--redo";
      emit({ kind: "info", message: impliedByFlag + " implies --all; running all tasks." });
    }

    // Resolve effective verification/repair behavior from CLI flags.
    const runBehavior = resolveRunBehavior({
      verify,
      onlyVerify,
      noRepair,
      repairAttempts,
      resolveRepairAttempts,
    });
    void forceAttempts;
    const configuredShouldVerify = runBehavior.shouldVerify;
    const configuredOnlyVerify = runBehavior.onlyVerify;
    const allowRepair = runBehavior.allowRepair;
    const maxRepairAttempts = runBehavior.maxRepairAttempts;
    const maxResolveRepairAttempts = runBehavior.maxResolveRepairAttempts;

    // Load template variables from optional file and merge CLI-provided overrides.
    const varsFilePath = resolveTemplateVarsFilePath(varsFileOption, dependencies.configDir?.configDir);
    const fileTemplateVars = varsFilePath
      ? dependencies.templateVarsLoader.load(
        varsFilePath,
        executionCwd,
        dependencies.configDir?.configDir,
      )
      : {};
    const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs);
    const extraTemplateVars: ExtraTemplateVars = mergeTemplateVarsWithWorkspaceContext(
      fileTemplateVars,
      cliTemplateVars,
      workspaceContextTemplateVars,
    );
    const rundownVarEnv = buildRundownVarEnv(extraTemplateVars);
    const templateVarsWithUserVariables: ExtraTemplateVars = {
      ...extraTemplateVars,
      userVariables: formatTemplateVarsForPrompt(extraTemplateVars),
    };
    cliExecutionOptions = cliBlockTimeoutMs === undefined
      ? { env: rundownVarEnv }
      : { timeoutMs: cliBlockTimeoutMs, env: rundownVarEnv };
    // Load worker defaults from config when a config directory is available.
    const rawWorkerConfig = dependencies.configDir?.configDir
      ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
      : undefined;
    const loadedWorkerConfigWithDefaults = applyTraceStatisticsDefaults(rawWorkerConfig, trace || traceStats);
    const loadedWorkerConfig = traceStats
      ? {
        ...(loadedWorkerConfigWithDefaults ?? {}),
        traceStatistics: {
          enabled: true,
          fields: [...(loadedWorkerConfigWithDefaults?.traceStatistics?.fields ?? [])],
        },
      }
      : loadedWorkerConfigWithDefaults;
    const workerHealthStoreBaseDir = dependencies.configDir?.configDir ?? executionCwd;
    let workerHealthSnapshot: WorkerHealthSnapshot = dependencies.workerHealthStore
      ? dependencies.workerHealthStore.read(workerHealthStoreBaseDir)
      : {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        entries: [],
      };
    let workerHealthEntries = workerHealthSnapshot.entries;
    const healthPolicy = loadedWorkerConfig?.healthPolicy;
    const maxFailoverAttemptsPerTask = resolvePerTaskFailoverAttemptLimit(
      healthPolicy,
      loadedWorkerConfig?.workers?.fallbacks?.length ?? 0,
    );
    const maxFailoverAttemptsPerRun = healthPolicy?.maxFailoverAttemptsPerRun;

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
    let completedAllRoundsSuccessfully = false;
    let postRunResetApplied = false;
    let resolvedFiles: string[] = [];
    const pendingPreRunResetTraceEvents: Array<{ file: string; resetCount: number; dryRun: boolean }> = [];
    // Defer commit until post-run lifecycle when reset-after is active or when
    // run-all commit timing is explicitly configured to commit once at file end.
    const deferCommitUntilPostRun = commitAfterComplete
      && (resetAfter || (effectiveRunAll && commitMode === "file-done"));
    let commitRetryBoundaryGitEnabled = false;
    let currentRound = 1;
    let runFailoverAttemptsUsed = 0;
    let runSemanticResetAttemptsUsed = 0;
    // Use an injectable timestamp provider for prompt/template rendering.
    const nowIso = (): string => new Date().toISOString();
    // Create a trace session that aggregates run and task lifecycle events.
    const traceRunSession = createTraceRunSession({
      getTraceWriter: () => state.traceWriter,
      source,
      mode,
      transport: "file",
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
      const failureMetadata = failure
        ? {
          runReason: failure.reason,
          failureExitCode: failure.exitCode,
        }
        : undefined;
      const finalExtra = extra
        ? {
          ...extra,
          ...roundMetadata,
          ...(failureMetadata ?? {}),
        }
        : {
          ...roundMetadata,
          ...(failureMetadata ?? {}),
        };
      traceRunSession.emitRoundCompleted(currentRound, rounds);
      traceRunSession.emitTaskOutcome(status, failure);
      await runTraceEnrichment({
        trace,
        status,
        artifactContext: state.artifactContext,
        traceRunSession,
        traceEnrichmentContext: state.traceEnrichmentContext,
        dependencies,
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
        emit({ kind: "warn", message: formatNoItemsFoundMatching("Markdown files", source) });
        return EXIT_CODE_NO_WORK;
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
          return EXIT_CODE_FAILURE;
        }
        throw error;
      }

      // `--commit` requires a clean git repository before task execution starts.
      if (commitAfterComplete) {
        const cwd = executionCwd;
        const inGitRepo = await isGitRepoWithGitClient(dependencies.gitClient, cwd);
        if (!inGitRepo) {
          emit({ kind: "warn", message: "--commit: not inside a git repository, skipping." });
        } else {
          commitRetryBoundaryGitEnabled = true;
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
            return EXIT_CODE_FAILURE;
          }
        }
      }

    const runTaskLoop = async (
      files: string[],
      emitCompletionMessage: boolean,
    ): Promise<number> => {
      const refreshRunnableSelection = (
        selected: TaskSelectionResult,
      ):
        | { kind: "runnable"; selection: TaskSelectionResult }
        | { kind: "skip"; reason: string } => {
        if (!dependencies.fileSystem.exists(selected.task.file)) {
          return {
            kind: "skip",
            reason: "its source file no longer exists",
          };
        }

        const refreshedSelection = dependencies.taskSelector.selectTaskByLocation(
          selected.task.file,
          selected.task.line,
        );
        if (!refreshedSelection) {
          return {
            kind: "skip",
            reason: "it is no longer present at its original location",
          };
        }

        if (refreshedSelection.task.checked) {
          return {
            kind: "skip",
            reason: "it is already checked",
          };
        }

        const source = dependencies.fileSystem.readText(refreshedSelection.task.file);
        const allTasks = parseTasks(source, refreshedSelection.task.file);
        const stillRunnable = filterRunnable(allTasks)
          .some((candidate) => candidate.line === refreshedSelection.task.line);
        if (!stillRunnable) {
          return {
            kind: "skip",
            reason: "it is no longer runnable",
          };
        }

        return {
          kind: "runnable",
          selection: refreshedSelection,
        };
      };

      const hasParallelGroupAncestor = (task: TaskSelectionResult["task"]): boolean => {
        if (!dependencies.fileSystem.exists(task.file)) {
          return false;
        }

        const source = dependencies.fileSystem.readText(task.file);
        const tasks = parseTasks(source, task.file);
        const taskIndex = tasks.findIndex((candidate) => candidate.line === task.line);
        if (taskIndex < 0) {
          return false;
        }

        const selectedTask = tasks[taskIndex]!;
        let currentDepth = selectedTask.depth;
        for (let index = taskIndex - 1; index >= 0; index -= 1) {
          const candidate = tasks[index]!;
          if (candidate.depth >= currentDepth) {
            continue;
          }

          if (candidate.intent === "parallel-group"
            || isParallelGroupTaskText(candidate.text, dependencies.toolResolver)) {
            return true;
          }
          currentDepth = candidate.depth;
        }

        return false;
      };

      const countUncheckedTasks = (): number => files.reduce((count, file) => {
        if (!dependencies.fileSystem.exists(file)) {
          return count;
        }

        const source = dependencies.fileSystem.readText(file);
        const uncheckedTasks = parseTasks(source, file).filter((task) => !task.checked).length;
        return count + uncheckedTasks;
      }, 0);

      const refreshTotalTasks = (): number => {
        totalTasks = currentTaskIndex + countUncheckedTasks();
        return totalTasks;
      };

      let totalTasks = 0;
      let currentTaskIndex = 0;
      refreshTotalTasks();

      // eslint-disable-next-line no-constant-condition
      while (true) {
          // Select the next available task using the configured sort strategy.
          const selection = dependencies.taskSelector.selectNextTask(files, sortMode);
          if (!selection || selection.length === 0) {
            state.runCompleted = true;
            if (state.tasksCompleted > 0) {
              if (emitCompletionMessage) {
                emit({
                  kind: "success",
                  message: "All tasks completed ("
                    + state.tasksCompleted
                    + " "
                    + pluralize(state.tasksCompleted, "task", "tasks")
                    + " total).",
                });
              }
              return EXIT_CODE_SUCCESS;
            }
            emit({ kind: "info", message: formatNoItemsFound("unchecked tasks") });
            return EXIT_CODE_NO_WORK;
          }

          const shouldRunBatchSequentiallyForTui = selection.length > 1 && mode === "tui";
          if (shouldRunBatchSequentiallyForTui) {
            emit({
              kind: "info",
              message: "Parallel batch selected in TUI mode; executing tasks sequentially.",
            });
          }
          const selectedBatch = shouldRunBatchSequentiallyForTui
            ? selection
            : [selection[0]!];
          const selectedBatchWasParallel = selectedBatch.length > 1;
          const dedupedBatch = selectedBatchWasParallel
            ? selectedBatch.filter((candidate, index, batch) => {
              const firstIndex = batch.findIndex((selected) => selected.task.file === candidate.task.file
                && selected.task.line === candidate.task.line);
              if (firstIndex !== index) {
                emit({
                  kind: "info",
                  message: "Skipping duplicate parallel sibling selection at "
                    + candidate.task.file
                    + ":"
                    + candidate.task.line
                    + ".",
                });
                return false;
              }
              return true;
            })
            : selectedBatch;

          for (const result of dedupedBatch) {
            let batchSelection = result;
            if (selectedBatchWasParallel) {
              const refreshedSelection = refreshRunnableSelection(result);
              if (refreshedSelection.kind === "skip") {
                emit({
                  kind: "info",
                  message: "Skipping parallel sibling at "
                    + result.task.file
                    + ":"
                    + result.task.line
                    + " because "
                    + refreshedSelection.reason
                    + ".",
                });
                continue;
              }
              batchSelection = refreshedSelection.selection;
            }

            const initialForceExtraction = extractForceModifier(batchSelection.task.text, dependencies.toolResolver);
            const maxTaskAttempts = initialForceExtraction.isForce
              ? initialForceExtraction.maxAttempts
              : 1;
            const forceTaskIdentity = {
              filePath: batchSelection.task.file,
              line: batchSelection.task.line,
            };
            let selectedTaskResult = batchSelection;
            let activeForceExtraction = initialForceExtraction;
            let attempt = 0;
            const hasSemanticResetRoute = (loadedWorkerConfig?.run?.workerRouting?.reset?.worker?.length ?? 0) > 0;
            const maxSemanticResetAttemptsPerTask = hasSemanticResetRoute ? 1 : 0;
            let taskSemanticResetAttemptsUsed = 0;
            let usingSemanticResetRoute = false;
            const shouldTrackRetryBoundaryBaseline = deferCommitUntilPostRun
              && state.tasksCompleted > 0
              && (maxTaskAttempts > 1
                || maxFailoverAttemptsPerTask > 0
                || maxSemanticResetAttemptsPerTask > 0);
            let forceRetryMetadata: {
              attemptNumber: number;
              maxAttempts: number;
              previousRunId: string;
              previousExitCode: number;
            } | undefined;
            let iterationResult: Awaited<ReturnType<typeof runTaskIteration>> | undefined;
            let taskFailoverAttemptsUsed = 0;
            const retryBoundaryGitCheckpoints: RetryBoundaryGitCheckpoint[] = [];
            let retryBoundaryBaselineStashHash: string | null = null;
            let retryBoundaryBaselineCaptured = false;

            const maybePreserveGitStateForRetryBoundary = async (
              reason: RetryBoundaryGitCheckpoint["reason"],
            ): Promise<number | null> => {
              if (!commitRetryBoundaryGitEnabled) {
                return null;
              }

              if (shouldTrackRetryBoundaryBaseline && !retryBoundaryBaselineCaptured) {
                try {
                  retryBoundaryBaselineStashHash = await captureRetryBoundaryBaselineStashHash({
                    gitClient: dependencies.gitClient,
                    cwd: executionCwd,
                    configDir: dependencies.configDir,
                    pathOperations: dependencies.pathOperations,
                    taskFile: selectedTaskResult.task.file,
                    taskLine: selectedTaskResult.task.line,
                  });
                  retryBoundaryBaselineCaptured = true;
                } catch (error) {
                  const message = "--commit: failed to capture retry baseline git state: " + String(error);
                  emit({ kind: "error", message });
                  return 1;
                }
              }

              try {
                const checkpoint = await preserveGitStateForRetryBoundary({
                  gitClient: dependencies.gitClient,
                  cwd: executionCwd,
                  configDir: dependencies.configDir,
                  pathOperations: dependencies.pathOperations,
                  taskFile: selectedTaskResult.task.file,
                  taskLine: selectedTaskResult.task.line,
                  reason,
                  baselineStashHash: retryBoundaryBaselineStashHash ?? undefined,
                });
                if (!checkpoint) {
                  return null;
                }

                retryBoundaryGitCheckpoints.push(checkpoint);
                emit({
                  kind: "info",
                  message: "--commit: stashed retry-boundary git state at "
                    + checkpoint.taskFile
                    + ":"
                    + checkpoint.taskLine
                    + " ("
                    + checkpoint.stashHash.slice(0, 12)
                    + ").",
                });
                return null;
              } catch (error) {
                const message = "--commit: failed to preserve git state before retry boundary: " + String(error);
                emit({ kind: "error", message });
                return 1;
              }
            };

            const maybeRestoreGitStateAfterTerminalFailure = async (): Promise<void> => {
              if (!commitRetryBoundaryGitEnabled || retryBoundaryGitCheckpoints.length === 0) {
                return;
              }

              const latestCheckpoint = retryBoundaryGitCheckpoints[retryBoundaryGitCheckpoints.length - 1];
              if (!latestCheckpoint) {
                return;
              }

              try {
                await restoreLatestRetryBoundaryGitState({
                  gitClient: dependencies.gitClient,
                  cwd: executionCwd,
                  checkpoint: latestCheckpoint,
                });
                emit({
                  kind: "warn",
                  message: "--commit: restored stashed retry-boundary git state from "
                    + latestCheckpoint.reason
                    + " attempt ("
                    + latestCheckpoint.stashHash.slice(0, 12)
                    + ").",
                });
              } catch (error) {
                emit({
                  kind: "warn",
                  message: "--commit: retry-boundary stash restore failed; manual recovery may be needed ("
                    + latestCheckpoint.stashHash.slice(0, 12)
                    + "). Error: "
                    + String(error),
                });
              }
            };

            while (attempt < maxTaskAttempts) {
              attempt++;
              const isFinalAttempt = attempt >= maxTaskAttempts;

              if (attempt > 1 && initialForceExtraction.isForce) {
                const refreshedSelection = dependencies.taskSelector.selectTaskByLocation(
                  forceTaskIdentity.filePath,
                  forceTaskIdentity.line,
                );
                if (!refreshedSelection) {
                  emit({
                    kind: "error",
                    message: "Force retry aborted: original task at "
                      + forceTaskIdentity.filePath
                      + ":"
                      + forceTaskIdentity.line
                      + " is no longer selectable.",
                  });
                  return EXIT_CODE_FAILURE;
                }

                selectedTaskResult = refreshedSelection;
                activeForceExtraction = extractForceModifier(
                  refreshedSelection.task.text,
                  dependencies.toolResolver,
                );

                if (selectedTaskResult.task.checked) {
                  emit({
                    kind: "info",
                    message: "Force retry stopped: task is already checked at "
                      + forceTaskIdentity.filePath
                      + ":"
                      + forceTaskIdentity.line
                      + ".",
                  });
                  state.tasksCompleted++;
                  iterationResult = {
                    continueLoop: effectiveRunAll,
                    exitCode: 0,
                    forceRetryableFailure: false,
                  };
                  break;
                }
              }

              // Intermediate `force:` retries intentionally bypass `failRun()` so we
              // do not run `finishRun()`/trace enrichment for attempts that will be
              // discarded. Final attempt failures still flow through `failRun()`.
              const attemptFailRun = initialForceExtraction.isForce && !isFinalAttempt
                ? async (code: number): Promise<number> => code
                : failRun;

              // Execute one full task iteration and inspect control-flow instructions.
              refreshTotalTasks();
              const suppressPerChildCommit = commitAfterComplete
                && commitMode === "per-task"
                && hasParallelGroupAncestor(selectedTaskResult.task);
              iterationResult = await runTaskIteration({
                dependencies,
                emit,
                state,
                context: {
                  source,
                  fileSource: selectedTaskResult.source,
                  taskIndex: currentTaskIndex,
                  totalTasks,
                  files,
                  task: selectedTaskResult.task,
                },
                execution: {
                  mode,
                  verbose,
                  taskIndex: currentTaskIndex,
                  totalTasks,
                  forceAttempts,
                  forceStrippedTaskText: activeForceExtraction.isForce
                    ? activeForceExtraction.strippedText
                    : undefined,
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
                  traceOnly,
                  forceRetryMetadata,
                  persistFailureAnnotation: (!initialForceExtraction.isForce || isFinalAttempt)
                    && (!hasSemanticResetRoute || usingSemanticResetRoute || taskSemanticResetAttemptsUsed >= maxSemanticResetAttemptsPerTask),
                },
                worker: {
                  workerPattern,
                  loadedWorkerConfig,
                  workerHealthEntries,
                  evaluateWorkerHealthAtMs: Date.now(),
                  runWorkerPhaseOverride: usingSemanticResetRoute ? "reset" : undefined,
                },
                verifyConfig: {
                  configuredOnlyVerify,
                  configuredShouldVerify,
                  maxRepairAttempts,
                  maxResolveRepairAttempts,
                  allowRepair,
                },
                completion: {
                  effectiveRunAll,
                  commitAfterComplete: suppressPerChildCommit ? false : commitAfterComplete,
                  deferCommitUntilPostRun,
                  commitMessageTemplate,
                  onCompleteCommand,
                  onFailCommand,
                  extraTemplateVars,
                  traceStatisticsConfig: loadedWorkerConfig?.traceStatistics,
                },
                prompts: {
                  extraTemplateVars: templateVarsWithUserVariables,
                  cliExecutionOptions,
                  cliBlockExecutor,
                  executionEnv: rundownVarEnv,
                  cwd: executionCwd,
                  taskTemplateOverride,
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
                  failRun: attemptFailRun,
                  finishRun,
                  resetArtifacts,
                },
              });

              const exitCode = iterationResult.exitCode ?? 0;
              const didFail = !iterationResult.continueLoop && exitCode !== 0;
              const executedWorkerCommand = iterationResult.executedWorkerCommand ?? [];
              const executedWorkerProfileName = iterationResult.executedWorkerProfileName;

              if (executedWorkerCommand.length > 0) {
                const healthOutcomeClass: WorkerFailureClass = didFail
                  ? (iterationResult.workerFailureClass ?? WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER)
                  : WORKER_FAILURE_CLASS_SUCCESS;
                const applyAttemptOutcomeUpdate = (snapshot: WorkerHealthSnapshot): WorkerHealthSnapshot => {
                  return updateWorkerHealthForAttemptOutcome({
                    snapshot,
                    workerCommand: executedWorkerCommand,
                    profileName: executedWorkerProfileName,
                    failureClass: healthOutcomeClass,
                    healthPolicy,
                    now: new Date(),
                  });
                };

                if (dependencies.workerHealthStore?.update) {
                  workerHealthSnapshot = dependencies.workerHealthStore.update(
                    applyAttemptOutcomeUpdate,
                    workerHealthStoreBaseDir,
                  );
                } else {
                  workerHealthSnapshot = applyAttemptOutcomeUpdate(workerHealthSnapshot);
                }
                workerHealthEntries = workerHealthSnapshot.entries;
                if (dependencies.workerHealthStore && !dependencies.workerHealthStore.update) {
                  dependencies.workerHealthStore.write(workerHealthSnapshot, workerHealthStoreBaseDir);
                }
              }

              const shouldRetryFailover = didFail
                && isFailoverRetryableFailureClass(iterationResult.workerFailureClass)
                && executedWorkerCommand.length > 0;
              if (shouldRetryFailover) {
                const hasTaskBudget = taskFailoverAttemptsUsed < maxFailoverAttemptsPerTask;
                const hasRunBudget = maxFailoverAttemptsPerRun === undefined
                  || runFailoverAttemptsUsed < maxFailoverAttemptsPerRun;

                if (!hasTaskBudget || !hasRunBudget) {
                  const exhaustedReason = !hasTaskBudget
                    ? "per-task failover attempt limit reached"
                    : "per-run failover attempt limit reached";
                  emit({
                    kind: "error",
                    message: "Failover exhausted: " + exhaustedReason + ". Last failure class: " + iterationResult.workerFailureClass + ".",
                  });
                  await maybeRestoreGitStateAfterTerminalFailure();
                  return exitCode;
                }

                taskFailoverAttemptsUsed++;
                runFailoverAttemptsUsed++;
                emit({
                  kind: "warn",
                  message: "Worker attempt failed with "
                    + iterationResult.workerFailureClass
                    + "; retrying with next eligible fallback (task failover "
                    + taskFailoverAttemptsUsed
                    + "/"
                    + maxFailoverAttemptsPerTask
                    + ").",
                });
                const retryBoundaryPreserveExitCode = await maybePreserveGitStateForRetryBoundary("failover");
                if (retryBoundaryPreserveExitCode !== null) {
                  return retryBoundaryPreserveExitCode;
                }
                attempt--;
                runFailed = false;
                state.runCompleted = false;
                dependencies.verificationStore.remove(selectedTaskResult.task);
                state.deferredCommitContext = null;
                resetArtifacts();
                if (cacheCliBlocks) {
                  cliBlockExecutor = createCachedCommandExecutor(defaultCliBlockExecutor);
                }
                continue;
              }

              const shouldRetrySemanticReset = didFail
                && hasSemanticResetRoute
                && iterationResult.runFailureReason === RUN_REASON_VERIFICATION_FAILED;
              if (shouldRetrySemanticReset) {
                if (taskSemanticResetAttemptsUsed >= maxSemanticResetAttemptsPerTask) {
                  emit({
                    kind: "error",
                    message: "Semantic reset exhausted: per-task semantic reset attempt limit reached.",
                  });
                  await maybeRestoreGitStateAfterTerminalFailure();
                  return exitCode;
                }

                taskSemanticResetAttemptsUsed++;
                runSemanticResetAttemptsUsed++;
                usingSemanticResetRoute = true;
                emit({
                  kind: "warn",
                  message: "Verification/repair exhausted; retrying with configured reset worker"
                    + " (semantic reset "
                    + taskSemanticResetAttemptsUsed
                    + "/"
                    + maxSemanticResetAttemptsPerTask
                    + ", run total "
                    + runSemanticResetAttemptsUsed
                    + ").",
                });
                const semanticResetRetryBoundaryPreserveExitCode = await maybePreserveGitStateForRetryBoundary("semantic-reset");
                if (semanticResetRetryBoundaryPreserveExitCode !== null) {
                  return semanticResetRetryBoundaryPreserveExitCode;
                }
                attempt--;
                runFailed = false;
                state.runCompleted = false;
                dependencies.verificationStore.remove(selectedTaskResult.task);
                state.deferredCommitContext = null;
                resetArtifacts();
                if (cacheCliBlocks) {
                  cliBlockExecutor = createCachedCommandExecutor(defaultCliBlockExecutor);
                }
                continue;
              }

                if (
                  didFail
                  && taskFailoverAttemptsUsed > 0
                  && executedWorkerCommand.length === 0
                ) {
                emit({
                  kind: "error",
                  message: "Failover exhausted: no eligible fallback workers remain after health filtering.",
                });
                await maybeRestoreGitStateAfterTerminalFailure();
                return exitCode;
              }

              const shouldRetryForceAttempt = didFail
                && initialForceExtraction.isForce
                && iterationResult.forceRetryableFailure === true
                && !isFinalAttempt;
              if (!shouldRetryForceAttempt) {
                if (!iterationResult.continueLoop) {
                  if (exitCode !== 0) {
                    await maybeRestoreGitStateAfterTerminalFailure();
                  }
                  return exitCode;
                }
                break;
              }

              emit({
                kind: "warn",
                message: "Force retry "
                  + (attempt + 1)
                  + " of "
                  + maxTaskAttempts
                  + " — restarting task iteration from scratch",
              });
              const forceRetryBoundaryPreserveExitCode = await maybePreserveGitStateForRetryBoundary("force");
              if (forceRetryBoundaryPreserveExitCode !== null) {
                return forceRetryBoundaryPreserveExitCode;
              }
              const previousRunId = state.artifactContext?.runId ?? traceRunSession.getRunId();
              forceRetryMetadata = typeof previousRunId === "string" && previousRunId.length > 0
                ? {
                  attemptNumber: attempt + 1,
                  maxAttempts: maxTaskAttempts,
                  previousRunId,
                  previousExitCode: exitCode,
                }
                : undefined;
              runFailed = false;
              state.runCompleted = false;
              dependencies.verificationStore.remove(selectedTaskResult.task);
              state.deferredCommitContext = null;
              resetArtifacts();
              if (cacheCliBlocks) {
                cliBlockExecutor = createCachedCommandExecutor(defaultCliBlockExecutor);
              }
            }

            if (!iterationResult) {
              continue;
            }

            currentTaskIndex++;
            if (!iterationResult.continueLoop) {
              return iterationResult.exitCode ?? 0;
            }
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

      if (state.deferredCommitContext && !runFailed && !unexpectedError) {
        // Reset task checkboxes before committing so git captures the clean state.
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
          postRunResetApplied = true;
        }

        try {
          const deferredCompletionExtra = await afterTaskComplete(
            dependencies,
            state.deferredCommitContext.task,
            state.deferredCommitContext.source,
            true,
            commitMessageTemplate,
            undefined,
            hideHookOutput,
            extraTemplateVars,
          );

          if (deferredCompletionExtra) {
            dependencies.artifactStore.finalize(state.deferredCommitContext.artifactContext, {
              status: "completed",
              preserve: keepArtifacts,
              extra: deferredCompletionExtra,
            });
          }
          state.deferredCommitContext = null;
        } catch (error) {
          if (error instanceof OnCompleteCommitError) {
            emit({ kind: "group-end", status: "failure", message: error.message });
            state.deferredCommitContext = null;
            return await failRun(1, "failed", error.message, 1);
          }
          throw error;
        }
      }

      completedAllRoundsSuccessfully = true;
      return EXIT_CODE_SUCCESS;
    } catch (error) {
      // Preserve unexpected errors so finalization can emit failed trace status.
      unexpectedError = error;
      throw error;
    } finally {
      // Reset task checkboxes after a successful run when post-run reset is requested.
      // Skip if already applied before a deferred commit above.
      if (resetAfter && state.runCompleted && !postRunResetApplied) {
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
