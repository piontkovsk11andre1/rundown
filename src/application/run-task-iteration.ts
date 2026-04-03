import { type Task } from "../domain/parser.js";
import { requiresWorkerCommand } from "../domain/run-options.js";
import { resolveWorkerForInvocation } from "./resolve-worker.js";
import { handleTemplateCliFailure } from "./cli-block-handlers.js";
import {
  validateRundownTaskArgs,
} from "./rundown-delegation.js";
import { handleDryRunOrPrintPrompt } from "./dry-run-dispatch.js";
import { formatTaskLabel } from "./run-task-utils.js";
import { afterTaskFailed } from "./run-lifecycle.js";
import { toRuntimeTaskMetadata } from "./task-context-resolution.js";
import { prepareTaskPrompts } from "./prepare-task-prompts.js";
import { createTraceRunSession } from "./trace-run-session.js";
import { getAutomationWorkerCommand, type RunnerMode } from "./run-task-worker-command.js";
import {
  dispatchTaskExecution,
  type TaskExecutionDispatchResult,
} from "./task-execution-dispatch.js";
import {
  completeTaskIteration,
  type CompleteTaskIterationState,
} from "./complete-task-iteration.js";
import {
  resolveIterationVerificationMode,
} from "./iteration-mode.js";
import type { TraceEnrichmentContext } from "./trace-enrichment.js";
import type {
  ArtifactRunContext,
  ArtifactStoreStatus,
  CommandExecutionOptions,
  CommandExecutor,
  PromptTransport,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { RunTaskDependencies } from "./run-task-execution.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;
type ArtifactContext = ArtifactRunContext;

/**
 * Tracks mutable execution state that must survive within a single run loop iteration.
 */
export interface RunExecutionState extends CompleteTaskIterationState {
  artifactContext: ArtifactContext | null;
  traceEnrichmentContext: TraceEnrichmentContext | null;
}

interface IterationTaskContext {
  // Original source text for the markdown file that contains the task.
  source: string;
  // File path used when resolving worker and template context.
  fileSource: string;
  // Related files that may be passed to worker execution.
  files: string[];
  // Parsed task selected for this iteration.
  task: Task;
}

interface IterationExecutionOptions {
  mode: RunnerMode;
  transport: PromptTransport;
  keepArtifacts: boolean;
  printPrompt: boolean;
  dryRun: boolean;
  dryRunSuppressesCliExpansion: boolean;
  cliExpansionEnabled: boolean;
  ignoreCliBlock: boolean;
  verify: boolean;
  noRepair: boolean;
  repairAttempts: number;
  forceExecute: boolean;
  showAgentOutput: boolean;
  hideHookOutput: boolean;
  trace: boolean;
}

interface IterationWorkerConfig {
  workerCommand: string[];
  loadedWorkerConfig: ReturnType<RunTaskDependencies["workerConfigPort"]["load"]> | undefined;
}

interface IterationVerifyConfig {
  configuredOnlyVerify: boolean;
  configuredShouldVerify: boolean;
  maxRepairAttempts: number;
  allowRepair: boolean;
}

interface IterationCompletionConfig {
  effectiveRunAll: boolean;
  commitAfterComplete: boolean;
  deferCommitUntilPostRun: boolean;
  commitMessageTemplate?: string;
  onCompleteCommand?: string;
  onFailCommand?: string;
}

interface IterationPromptConfig {
  extraTemplateVars: ExtraTemplateVars;
  cliExecutionOptions: CommandExecutionOptions | undefined;
  cliBlockExecutor: CommandExecutor;
  nowIso: () => string;
}

interface IterationTraceConfig {
  traceRunSession: ReturnType<typeof createTraceRunSession>;
  pendingPreRunResetTraceEvents: Array<{ file: string; resetCount: number; dryRun: boolean }>;
  roundContext: {
    currentRound: number;
    totalRounds: number;
  };
}

interface IterationLifecycle {
  failRun: (
    code: number,
    status: ArtifactStoreStatus,
    reason: string,
    exitCode: number | null,
    preserve?: boolean,
  ) => Promise<number>;
  finishRun: (
    code: number,
    status: ArtifactStoreStatus,
    preserve?: boolean,
    failure?: { reason: string; exitCode: number | null },
    extra?: Record<string, unknown>,
  ) => Promise<number>;
  resetArtifacts: () => void;
}

/**
 * Emits execution failure details, runs failure hooks, and finalizes the run as failed.
 */
function handleDispatchFailure(params: {
  dispatchResult: Extract<TaskExecutionDispatchResult, { kind: "execution-failed" }>;
  emit: EmitFn;
  dependencies: RunTaskDependencies;
  task: Task;
  source: string;
  onFailCommand: string | undefined;
  hideHookOutput: boolean;
  failRun: IterationLifecycle["failRun"];
}): Promise<number> {
  const {
    dispatchResult,
    emit,
    dependencies,
    task,
    source,
    onFailCommand,
    hideHookOutput,
    failRun,
  } = params;

  emit({ kind: "error", message: dispatchResult.executionFailureMessage });
  return (async (): Promise<number> => {
    await afterTaskFailed(dependencies, task, source, onFailCommand, hideHookOutput);
    return failRun(
      1,
      "execution-failed",
      dispatchResult.executionFailureRunReason,
      dispatchResult.executionFailureExitCode,
    );
  })();
}

/**
 * Executes one task iteration from worker resolution through dispatch and completion handling.
 */
export async function runTaskIteration(params: {
  dependencies: RunTaskDependencies;
  emit: EmitFn;
  state: RunExecutionState;
  context: IterationTaskContext;
  execution: IterationExecutionOptions;
  worker: IterationWorkerConfig;
  verifyConfig: IterationVerifyConfig;
  completion: IterationCompletionConfig;
  prompts: IterationPromptConfig;
  traceConfig: IterationTraceConfig;
  lifecycle: IterationLifecycle;
}): Promise<{ continueLoop: boolean; exitCode?: number }> {
  const { dependencies, emit, state, context, execution, worker, verifyConfig, completion, prompts, traceConfig, lifecycle } = params;
  const { source, fileSource, files, task } = context;

  // Announce the next task before any execution or validation occurs.
  emit({ kind: "info", message: "Next task: " + formatTaskLabel(task) });
  // Resolve the effective worker command using CLI, config, and task metadata.
  const resolvedWorkerCommand = resolveWorkerForInvocation({
    commandName: "run",
    workerConfig: worker.loadedWorkerConfig,
    source: fileSource,
    task,
    cliWorkerCommand: worker.workerCommand,
    emit,
  });
  // Build the automation command variant used for verification-only execution.
  const automationCommand = getAutomationWorkerCommand(resolvedWorkerCommand, execution.mode);
  // Decide whether this iteration should execute, verify, or do both.
  const { onlyVerify, shouldVerify } = resolveIterationVerificationMode({
    configuredOnlyVerify: verifyConfig.configuredOnlyVerify,
    configuredShouldVerify: verifyConfig.configuredShouldVerify,
    forceExecute: execution.forceExecute,
    task,
    emit,
  });

  // Abort early when a task requires a worker command but none is available.
  if (requiresWorkerCommand({
    workerCommand: resolvedWorkerCommand,
    hasConfigWorker: resolvedWorkerCommand.length > 0,
    isInlineCli: task.isInlineCli,
    isRundownTask: task.isRundownTask,
    shouldVerify,
    onlyVerify,
  })) {
    emit({
      kind: "error",
      message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <command...> or -- <command>.",
    });
    return { continueLoop: false, exitCode: 1 };
  }

  // Delegated rundown tasks must satisfy subcommand-specific operand requirements.
  if (!onlyVerify && task.isRundownTask) {
    const validation = validateRundownTaskArgs(task.rundownArgs);
    if (!validation.valid) {
      emit({
        kind: "error",
        message: validation.errorMessage ?? "Invalid rundown task delegation arguments.",
      });
      return { continueLoop: false, exitCode: 1 };
    }
  }

  // Initialize artifact and trace context only for real execution modes.
  if (!execution.printPrompt && !execution.dryRun) {
    state.artifactContext = dependencies.artifactStore.createContext({
      cwd: dependencies.workingDirectory.cwd(),
      configDir: dependencies.configDir?.configDir,
      commandName: "run",
      workerCommand: onlyVerify ? automationCommand : resolvedWorkerCommand,
      mode: execution.mode,
      transport: execution.transport,
      source,
      task: toRuntimeTaskMetadata(task, fileSource),
      keepArtifacts: execution.keepArtifacts,
    });
    state.traceWriter = dependencies.createTraceWriter(execution.trace, state.artifactContext);
  }

  // Resolve prompt templates and optional CLI blocks before dispatch.
  const sourceDir = dependencies.pathOperations.dirname(dependencies.pathOperations.resolve(task.file));
  const preparedPrompts = await prepareTaskPrompts({
    dependencies,
    task,
    fileSource,
    sourceDir,
    shouldVerify,
    trace: execution.trace,
    extraTemplateVars: prompts.extraTemplateVars,
    cliExpansionEnabled: execution.cliExpansionEnabled,
    ignoreCliBlock: execution.ignoreCliBlock,
    cliExecutionOptions: prompts.cliExecutionOptions,
    artifactContext: state.artifactContext,
    traceWriter: state.traceWriter,
    cliBlockExecutor: prompts.cliBlockExecutor,
    nowIso: prompts.nowIso,
    emit,
    onTemplateCliFailure: async (error: unknown): Promise<number | null> => await handleTemplateCliFailure(
      error,
      emit,
      async () => await afterTaskFailed(dependencies, task, source, completion.onFailCommand, execution.hideHookOutput),
      async (failureMessage) => await lifecycle.failRun(1, "failed", failureMessage, 1),
    ),
  });
  // Respect early exits produced during prompt preparation.
  if ("earlyExitCode" in preparedPrompts) {
    return { continueLoop: false, exitCode: preparedPrompts.earlyExitCode };
  }

  // Handle print and dry-run flows without executing the worker command.
  const dryRunOrPrintPromptExitCode = handleDryRunOrPrintPrompt({
    emit,
    printPrompt: execution.printPrompt,
    dryRun: execution.dryRun,
    dryRunSuppressesCliExpansion: execution.dryRunSuppressesCliExpansion,
    dryRunCliBlockCount: preparedPrompts.dryRunCliBlockCount,
    onlyVerify,
    task,
    prompt: preparedPrompts.prompt,
    verificationPrompt: preparedPrompts.verificationPrompt,
    automationCommand,
    resolvedWorkerCommand,
    transport: execution.transport,
    keepArtifacts: execution.keepArtifacts,
    showAgentOutput: execution.showAgentOutput,
    ignoreCliBlock: execution.ignoreCliBlock,
    verify: execution.verify,
    noRepair: execution.noRepair,
    repairAttempts: execution.repairAttempts,
  });
  if (dryRunOrPrintPromptExitCode !== null) {
    return { continueLoop: false, exitCode: dryRunOrPrintPromptExitCode };
  }

  // Execution paths require a concrete artifact context for logging and storage.
  if (!state.artifactContext) {
    throw new Error("Artifact context was not initialized before task execution.");
  }
  const selectedWorkerCommand = onlyVerify ? automationCommand : resolvedWorkerCommand;
  // Persist expanded prompt context for trace enrichment in later phases.
  state.traceEnrichmentContext = {
    task,
    source: preparedPrompts.expandedSource,
    contextBefore: preparedPrompts.expandedContextBefore,
    worker: selectedWorkerCommand,
    templates: preparedPrompts.templates,
  };

  // Dispatch the task and receive a structured result for completion routing.
  const dispatchResult = await dispatchTaskExecution({
    dependencies,
    emit,
    files,
    selectedWorkerCommand,
    pendingPreRunResetTraceEvents: traceConfig.pendingPreRunResetTraceEvents,
    traceRunSession: traceConfig.traceRunSession,
    configuredOnlyVerify: verifyConfig.configuredOnlyVerify,
    roundContext: traceConfig.roundContext,
    onlyVerify,
    shouldVerify,
    mode: execution.mode,
    transport: execution.transport,
    keepArtifacts: execution.keepArtifacts,
    showAgentOutput: execution.showAgentOutput,
    ignoreCliBlock: execution.ignoreCliBlock,
    verify: execution.verify,
    noRepair: execution.noRepair,
    repairAttempts: execution.repairAttempts,
    task,
    prompt: preparedPrompts.prompt,
    expandedContextBefore: preparedPrompts.expandedContextBefore,
    artifactContext: state.artifactContext,
    resolvedWorkerCommand,
    trace: execution.trace,
    cliExecutionOptionsWithVerificationTemplateFailureAbort:
      preparedPrompts.cliExecutionOptionsWithVerificationTemplateFailureAbort,
    cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace:
      preparedPrompts.cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
  });

  // Convert execution failures into lifecycle failure handling with hooks.
  if (dispatchResult.kind === "execution-failed") {
    return {
      continueLoop: false,
      exitCode: await handleDispatchFailure({
        dispatchResult,
        emit,
        dependencies,
        task,
        source,
        onFailCommand: completion.onFailCommand,
        hideHookOutput: execution.hideHookOutput,
        failRun: lifecycle.failRun,
      }),
    };
  }

  // Detached runs intentionally skip immediate verification and checkbox updates.
  if (dispatchResult.kind === "detached") {
    emit({ kind: "info", message: "Detached mode — skipping immediate verification and leaving the task unchecked." });
    return {
      continueLoop: false,
      exitCode: await lifecycle.finishRun(0, "detached", true),
    };
  }

  // Finish the iteration by running verification, repair, and completion hooks.
  return completeTaskIteration({
    dependencies,
    emit,
    state,
    traceRunSession: traceConfig.traceRunSession,
    failRun: lifecycle.failRun,
    finishRun: lifecycle.finishRun,
    resetArtifacts: lifecycle.resetArtifacts,
    keepArtifacts: execution.keepArtifacts,
    effectiveRunAll: completion.effectiveRunAll,
    commitAfterComplete: completion.commitAfterComplete,
    deferCommitUntilPostRun: completion.deferCommitUntilPostRun,
    commitMessageTemplate: completion.commitMessageTemplate,
    onCompleteCommand: completion.onCompleteCommand,
    onFailCommand: completion.onFailCommand,
    hideHookOutput: execution.hideHookOutput,
    maxRepairAttempts: verifyConfig.maxRepairAttempts,
    allowRepair: verifyConfig.allowRepair,
    transport: execution.transport,
    trace: execution.trace,
    cliBlockExecutor: prompts.cliBlockExecutor,
    cliExpansionEnabled: execution.cliExpansionEnabled,
    task,
    sourceText: source,
    expandedSource: preparedPrompts.expandedSource,
    expandedContextBefore: preparedPrompts.expandedContextBefore,
    templates: preparedPrompts.templates,
    templateVarsWithTrace: preparedPrompts.templateVarsWithTrace,
    automationCommand,
    shouldVerify: dispatchResult.shouldVerify,
    verificationPrompt: preparedPrompts.verificationPrompt,
    artifactContext: state.artifactContext,
    cliExecutionOptionsWithVerificationTemplateFailureAbort:
      dispatchResult.cliExecutionOptionsForVerification,
    verificationFailureMessage: dispatchResult.verificationFailureMessage,
    verificationFailureRunReason: dispatchResult.verificationFailureRunReason,
  });
}
