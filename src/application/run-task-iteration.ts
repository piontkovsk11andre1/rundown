import { type Task } from "../domain/parser.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { requiresWorkerCommand } from "../domain/run-options.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";
import { handleTemplateCliFailure } from "./cli-block-handlers.js";
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
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { RunTaskDependencies } from "./run-task-execution.js";
import type { TraceStatisticsConfig } from "../domain/worker-config.js";
import type { WorkerFailureClass, WorkerHealthEntry } from "../domain/worker-health.js";
import { classifyWorkerFailure } from "./worker-failure-classification.js";
import { RUN_REASON_USAGE_LIMIT_DETECTED } from "../domain/run-reasons.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;
type ArtifactContext = ArtifactRunContext;
const INLINE_CLI_PREFIX = /^cli:\s*/i;

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
  // Zero-based index of the current task within this run.
  taskIndex: number;
  // Cached total unchecked task count resolved before iteration starts.
  totalTasks: number;
  // Related files that may be passed to worker execution.
  files: string[];
  // Parsed task selected for this iteration.
  task: Task;
}

interface IterationExecutionOptions {
  mode: RunnerMode;
  verbose: boolean;
  taskIndex: number;
  totalTasks: number;
  forceAttempts: number;
  forceStrippedTaskText?: string;
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
  traceOnly: boolean;
  forceRetryMetadata?: {
    attemptNumber: number;
    maxAttempts: number;
    previousRunId: string;
    previousExitCode: number;
  };
  persistFailureAnnotation?: boolean;
}

interface IterationWorkerConfig {
  workerPattern: ParsedWorkerPattern;
  loadedWorkerConfig: ReturnType<RunTaskDependencies["workerConfigPort"]["load"]> | undefined;
  workerHealthEntries?: readonly WorkerHealthEntry[];
  evaluateWorkerHealthAtMs?: number;
}

interface IterationVerifyConfig {
  configuredOnlyVerify: boolean;
  configuredShouldVerify: boolean;
  maxRepairAttempts: number;
  maxResolveRepairAttempts?: number;
  allowRepair: boolean;
}

interface IterationCompletionConfig {
  effectiveRunAll: boolean;
  commitAfterComplete: boolean;
  deferCommitUntilPostRun: boolean;
  commitMessageTemplate?: string;
  onCompleteCommand?: string;
  onFailCommand?: string;
  extraTemplateVars: ExtraTemplateVars;
  traceStatisticsConfig?: TraceStatisticsConfig;
}

interface IterationPromptConfig {
  extraTemplateVars: ExtraTemplateVars;
  cliExecutionOptions: CommandExecutionOptions | undefined;
  cliBlockExecutor: CommandExecutor;
  executionEnv?: Record<string, string>;
  cwd: string;
  taskTemplateOverride?: string;
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

function extractPrefixModifierProfile(prefixChain: ReturnType<typeof resolveIterationVerificationMode>["prefixChain"]): string | undefined {
  let resolvedProfile: string | undefined;
  for (const modifier of prefixChain.modifiers) {
    if (modifier.tool.name.toLowerCase() !== "profile") {
      continue;
    }

    const profileName = modifier.payload.trim();
    if (profileName.length > 0) {
      resolvedProfile = profileName;
    }
  }

  return resolvedProfile;
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
  extraTemplateVars: ExtraTemplateVars;
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
    extraTemplateVars,
    failRun,
  } = params;

  emit({ kind: "error", message: dispatchResult.executionFailureMessage });
  return (async (): Promise<number> => {
    await afterTaskFailed(dependencies, task, source, onFailCommand, hideHookOutput, extraTemplateVars);
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
}): Promise<{
  continueLoop: boolean;
  exitCode?: number;
  forceRetryableFailure?: boolean;
  workerFailureClass?: WorkerFailureClass;
  executedWorkerCommand?: string[];
}> {
  const { dependencies, emit, state, context, execution, worker, verifyConfig, completion, prompts, traceConfig, lifecycle } = params;
  const { source, fileSource, files, task } = context;
  const taskTextForExecution = execution.forceStrippedTaskText ?? task.text;
  const initialTaskForIntent = taskTextForExecution === task.text
    ? task
    : {
      ...task,
      text: taskTextForExecution,
    };
  const taskForIntent = !initialTaskForIntent.isInlineCli && INLINE_CLI_PREFIX.test(taskTextForExecution)
    ? {
      ...initialTaskForIntent,
      isInlineCli: true,
      cliCommand: taskTextForExecution.replace(INLINE_CLI_PREFIX, "").trim(),
    }
    : initialTaskForIntent;

  // Decide whether this iteration should execute, verify, or do both.
  const { onlyVerify, shouldVerify, taskIntentDecision, prefixChain } = resolveIterationVerificationMode({
    configuredOnlyVerify: verifyConfig.configuredOnlyVerify,
    configuredShouldVerify: verifyConfig.configuredShouldVerify,
    forceExecute: execution.forceExecute,
    task: taskForIntent,
    toolResolver: dependencies.toolResolver,
    emit,
  });

  // Emit the per-task group boundary before any execution or validation occurs.
  emit({
    kind: "group-start",
    label: formatTaskLabel(task),
    counter: {
      current: execution.taskIndex + 1,
      total: execution.totalTasks,
    },
  });

  if (execution.verbose) {
    emit({ kind: "info", message: "Next task: " + formatTaskLabel(task) });
  }

  let groupEnded = false;
  const emitGroupSuccess = (): void => {
    if (groupEnded) {
      return;
    }
    emit({ kind: "group-end", status: "success" });
    groupEnded = true;
  };
  const emitGroupFailure = (message: string): void => {
    if (groupEnded) {
      return;
    }
    emit({ kind: "group-end", status: "failure", message });
    groupEnded = true;
  };

  try {

  if (taskIntentDecision.intent === "memory-capture" && taskIntentDecision.hasEmptyPayload) {
    const message = "Memory capture task requires payload text after the prefix (memory:, memorize:, remember:, inventory:).";
    emit({
      kind: "error",
      message,
    });
    emitGroupFailure(message);
    return { continueLoop: false, exitCode: 1, forceRetryableFailure: false };
  }

  if (taskIntentDecision.intent === "tool-expansion" && taskIntentDecision.hasEmptyPayload) {
    const message = "Tool task requires payload text after the prefix (<tool-name>:).";
    emit({
      kind: "error",
      message,
    });
    emitGroupFailure(message);
    return { continueLoop: false, exitCode: 1, forceRetryableFailure: false };
  }

  if (taskIntentDecision.intent === "fast-execution" && taskIntentDecision.hasEmptyPayload) {
    const message = "Fast task has no payload text; skipping.";
    emit({
      kind: "warn",
      message,
    });
    emitGroupSuccess();
    return { continueLoop: false, exitCode: 0, forceRetryableFailure: false };
  }

  const taskForExecution = taskIntentDecision.normalizedTaskText === taskForIntent.text
    ? taskForIntent
    : {
      ...taskForIntent,
      text: taskIntentDecision.normalizedTaskText,
    };
  const taskForLifecycle = execution.forceStrippedTaskText === undefined
    ? taskForExecution
    : task;

  const modifierProfile = extractPrefixModifierProfile(prefixChain);
  // Resolve the effective worker command using CLI, config, and task metadata.
  const resolvedWorker = resolveWorkerPatternForInvocation({
    commandName: "run",
    workerConfig: worker.loadedWorkerConfig,
    source: fileSource,
    task: taskForExecution,
    modifierProfile,
    cliWorkerPattern: worker.workerPattern,
    taskIntent: taskIntentDecision.intent,
    toolName: taskIntentDecision.toolName,
    emit,
    mode: execution.mode,
    workerHealthEntries: worker.workerHealthEntries,
    evaluateWorkerHealthAtMs: worker.evaluateWorkerHealthAtMs,
  });
  const resolvedWorkerCommand = resolvedWorker.workerCommand;
  const resolvedWorkerPattern = resolvedWorker.workerPattern;
  // Build the automation command variant used for verification-only execution.
  // Verification always runs in "wait" mode, so when the execution mode is "tui"
  // the worker must be re-resolved with mode "wait" to pick workers.default
  // instead of workers.tui.
  const verificationWorker = execution.mode === "tui"
    ? resolveWorkerPatternForInvocation({
      commandName: "run",
      workerConfig: worker.loadedWorkerConfig,
      source: fileSource,
      task: taskForExecution,
      modifierProfile,
      cliWorkerPattern: worker.workerPattern,
      taskIntent: taskIntentDecision.intent,
      toolName: taskIntentDecision.toolName,
      emit,
      mode: "wait",
      workerHealthEntries: worker.workerHealthEntries,
      evaluateWorkerHealthAtMs: worker.evaluateWorkerHealthAtMs,
    })
    : resolvedWorker;
  const verificationWorkerCommand = verificationWorker.workerCommand;
  const automationCommand = getAutomationWorkerCommand(verificationWorkerCommand, "wait");
  const automationWorkerPattern = verificationWorkerCommand.length === automationCommand.length
    && verificationWorkerCommand.every((token, index) => token === automationCommand[index])
    ? verificationWorker.workerPattern
    : {
      command: [...automationCommand],
      usesBootstrap: automationCommand.some((token) => token.includes("$bootstrap")),
      usesFile: automationCommand.some((token) => token.includes("$file")),
      appendFile: !automationCommand.some((token) => token.includes("$bootstrap") || token.includes("$file")),
    };

  // Abort early when a task requires a worker command but none is available.
  if (requiresWorkerCommand({
    workerCommand: resolvedWorkerCommand,
    hasConfigWorker: resolvedWorkerCommand.length > 0,
    isInlineCli: taskForExecution.isInlineCli,
    shouldVerify,
    onlyVerify,
  })) {
    const message = "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.";
    emit({
      kind: "error",
      message,
    });
    emitGroupFailure(message);
    return { continueLoop: false, exitCode: 1, forceRetryableFailure: false };
  }

  // Initialize artifact and trace context only for real execution modes.
  if (!execution.printPrompt && !execution.dryRun) {
    state.artifactContext = dependencies.artifactStore.createContext({
      cwd: prompts.cwd,
      configDir: dependencies.configDir?.configDir,
      commandName: "run",
      workerCommand: onlyVerify ? automationCommand : resolvedWorkerCommand,
      mode: execution.mode,
      transport: "pattern",
      source,
      task: toRuntimeTaskMetadata(taskForLifecycle, fileSource),
      keepArtifacts: execution.keepArtifacts,
    });
    state.traceWriter = dependencies.createTraceWriter(execution.trace, state.artifactContext);
  }

  // Resolve prompt templates and optional CLI blocks before dispatch.
  const sourceDir = dependencies.pathOperations.dirname(dependencies.pathOperations.resolve(task.file));
  let promptPreparationFailureReason: string | null = null;
  let promptPreparationFailedInTemplateCli = false;
  const preparedPrompts = await prepareTaskPrompts({
    dependencies,
    task: taskForExecution,
    fileSource,
    sourceDir,
    shouldVerify,
    trace: execution.trace,
    extraTemplateVars: prompts.extraTemplateVars,
    cliExpansionEnabled: execution.cliExpansionEnabled,
    ignoreCliBlock: execution.ignoreCliBlock,
    cwd: prompts.cwd,
    taskTemplateOverride: prompts.taskTemplateOverride,
    cliExecutionOptions: prompts.cliExecutionOptions,
    artifactContext: state.artifactContext,
    traceWriter: state.traceWriter,
    cliBlockExecutor: prompts.cliBlockExecutor,
    nowIso: prompts.nowIso,
    emit,
    onTemplateCliFailure: async (error: unknown): Promise<number | null> => await handleTemplateCliFailure(
      error,
        emit,
        async () => await afterTaskFailed(
          dependencies,
          taskForLifecycle,
          source,
          completion.onFailCommand,
          execution.hideHookOutput,
        completion.extraTemplateVars,
      ),
      async (failureMessage) => {
        promptPreparationFailureReason = failureMessage;
        promptPreparationFailedInTemplateCli = true;
        return await lifecycle.failRun(1, "failed", failureMessage, 1);
      },
    ),
  });
  // Respect early exits produced during prompt preparation.
  if ("earlyExitCode" in preparedPrompts) {
      if (preparedPrompts.earlyExitCode !== 0) {
        const failureMessage = promptPreparationFailureReason
          ?? "Task failed during prompt preparation (exit " + preparedPrompts.earlyExitCode + ").";
        emitGroupFailure(failureMessage);
      } else {
        emitGroupSuccess();
      }
    return {
      continueLoop: false,
      exitCode: preparedPrompts.earlyExitCode,
      forceRetryableFailure: preparedPrompts.earlyExitCode !== 0 && promptPreparationFailedInTemplateCli,
    };
  }

  // Handle print and dry-run flows without executing the worker command.
  const dryRunOrPrintPromptExitCode = handleDryRunOrPrintPrompt({
    emit,
    printPrompt: execution.printPrompt,
    dryRun: execution.dryRun,
    dryRunSuppressesCliExpansion: execution.dryRunSuppressesCliExpansion,
    dryRunCliBlockCount: preparedPrompts.dryRunCliBlockCount,
    onlyVerify,
    task: taskForExecution,
    prompt: preparedPrompts.prompt,
    verificationPrompt: preparedPrompts.verificationPrompt,
    automationCommand,
    resolvedWorkerCommand,
  });
  if (dryRunOrPrintPromptExitCode !== null) {
    if (dryRunOrPrintPromptExitCode !== 0) {
      emitGroupFailure(
        "Task failed during dry-run or prompt rendering (exit "
          + dryRunOrPrintPromptExitCode
          + ").",
      );
    } else {
      emitGroupSuccess();
    }
    return { continueLoop: false, exitCode: dryRunOrPrintPromptExitCode };
  }

  // Execution paths require a concrete artifact context for logging and storage.
  if (!state.artifactContext) {
    const message = "Artifact context was not initialized before task execution.";
    emit({ kind: "error", message });
    emitGroupFailure(message);
    await afterTaskFailed(
      dependencies,
      taskForLifecycle,
      source,
      completion.onFailCommand,
      execution.hideHookOutput,
      completion.extraTemplateVars,
    );
      return {
        continueLoop: false,
        exitCode: await lifecycle.failRun(1, "failed", message, 1),
        forceRetryableFailure: false,
      };
  }
  const selectedWorkerCommand = onlyVerify ? automationCommand : resolvedWorkerCommand;
  // Persist expanded prompt context for trace enrichment in later phases.
  state.traceEnrichmentContext = {
    task: taskForLifecycle,
    source: preparedPrompts.expandedSource,
    contextBefore: preparedPrompts.expandedContextBefore,
    worker: selectedWorkerCommand,
    templates: preparedPrompts.templates,
  };

  if (onlyVerify) {
    emit({ kind: "info", message: "Execution phase skipped; entering verification phase." });
  }

  if (execution.verbose) {
    emit({ kind: "info", message: "Starting execute phase..." });
  }

  // Dispatch the task and receive a structured result for completion routing.
  const dispatchResult = await dispatchTaskExecution({
    dependencies,
    emit,
    files,
    selectedWorkerCommand,
    selectedWorkerPattern: onlyVerify ? automationWorkerPattern : resolvedWorkerPattern,
    pendingPreRunResetTraceEvents: traceConfig.pendingPreRunResetTraceEvents,
    traceRunSession: traceConfig.traceRunSession,
    configuredOnlyVerify: verifyConfig.configuredOnlyVerify,
    roundContext: traceConfig.roundContext,
    onlyVerify,
    shouldVerify,
    mode: execution.mode,
    keepArtifacts: execution.keepArtifacts,
    showAgentOutput: execution.showAgentOutput,
    ignoreCliBlock: execution.ignoreCliBlock,
    verify: execution.verify,
    noRepair: execution.noRepair,
    repairAttempts: execution.repairAttempts,
    taskIntent: taskIntentDecision.intent,
    memoryCapturePrefix: taskIntentDecision.memoryCapturePrefix,
    toolName: taskIntentDecision.toolName,
    toolPayload: taskIntentDecision.toolPayload,
    prefixChain,
    task: taskForExecution,
    prompt: preparedPrompts.prompt,
    expandedContextBefore: preparedPrompts.expandedContextBefore,
    artifactContext: state.artifactContext,
    resolvedWorkerCommand,
    resolvedWorkerPattern,
    trace: execution.trace,
    cwd: prompts.cwd,
    executionEnv: prompts.executionEnv,
    cliExecutionOptionsWithVerificationTemplateFailureAbort:
      preparedPrompts.cliExecutionOptionsWithVerificationTemplateFailureAbort,
    cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace:
      preparedPrompts.cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
    forceRetryMetadata: execution.forceRetryMetadata,
  });

  // Convert execution failures into lifecycle failure handling with hooks.
  if (dispatchResult.kind === "execution-failed") {
    emitGroupFailure(dispatchResult.executionFailureRunReason);
    return {
      continueLoop: false,
      forceRetryableFailure: dispatchResult.forceRetryableFailure === true,
      executedWorkerCommand: selectedWorkerCommand,
      workerFailureClass: classifyIterationFailure({
        runReason: dispatchResult.executionFailureRunReason,
        exitCode: dispatchResult.executionFailureExitCode,
        message: dispatchResult.executionFailureMessage,
        stdout: dispatchResult.executionFailureStdout,
        stderr: dispatchResult.executionFailureStderr,
      }),
      exitCode: await handleDispatchFailure({
        dispatchResult,
        emit,
        dependencies,
        task: taskForLifecycle,
        source,
        onFailCommand: completion.onFailCommand,
        hideHookOutput: execution.hideHookOutput,
        extraTemplateVars: completion.extraTemplateVars,
        failRun: lifecycle.failRun,
      }),
    };
  }

  // Detached runs intentionally skip immediate verification and checkbox updates.
  if (dispatchResult.kind === "detached") {
    emit({ kind: "info", message: "Detached mode — skipping immediate verification and leaving the task unchecked." });
    emitGroupSuccess();
    return {
      continueLoop: false,
      forceRetryableFailure: false,
      executedWorkerCommand: selectedWorkerCommand,
      exitCode: await lifecycle.finishRun(0, "detached", true),
    };
  }

  if (execution.verbose) {
    if (dispatchResult.shouldVerify) {
      emit({ kind: "info", message: "Execute phase finished; starting verify/repair phase..." });
    } else {
      emit({ kind: "info", message: "Execute phase finished; verification is disabled for this task." });
    }
  }

  // Finish the iteration by running verification, repair, and completion hooks.
  const completionResult = await completeTaskIteration({
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
    extraTemplateVars: completion.extraTemplateVars,
    hideHookOutput: execution.hideHookOutput,
    maxRepairAttempts: verifyConfig.maxRepairAttempts,
    maxResolveRepairAttempts: verifyConfig.maxResolveRepairAttempts ?? 1,
    allowRepair: verifyConfig.allowRepair,
    trace: execution.trace,
    traceOnly: execution.traceOnly,
    verbose: execution.verbose,
    cliBlockExecutor: prompts.cliBlockExecutor,
    cliExpansionEnabled: execution.cliExpansionEnabled,
    task: taskForLifecycle,
    verificationTask: taskForExecution,
    sourceText: source,
    expandedSource: preparedPrompts.expandedSource,
    expandedContextBefore: preparedPrompts.expandedContextBefore,
    templates: preparedPrompts.templates,
    templateVarsWithTrace: preparedPrompts.templateVarsWithTrace,
    executionEnv: prompts.executionEnv,
    automationCommand,
    automationWorkerPattern,
    shouldVerify: dispatchResult.shouldVerify,
    runMode: execution.mode,
    executionOutputCaptured: dispatchResult.shouldVerify
      ? dispatchResult.executionOutputCaptured
      : undefined,
    verificationPrompt: preparedPrompts.verificationPrompt,
    executionStdout: dispatchResult.shouldVerify
      ? dispatchResult.executionStdout
      : undefined,
    isInlineCliTask: taskForExecution.isInlineCli,
    isToolExpansionTask: taskIntentDecision.intent === "tool-expansion",
    artifactContext: state.artifactContext,
    cliExecutionOptionsWithVerificationTemplateFailureAbort:
      dispatchResult.cliExecutionOptionsForVerification,
    verificationFailureMessage: dispatchResult.verificationFailureMessage,
    verificationFailureRunReason: dispatchResult.verificationFailureRunReason,
    skipRemainingSiblingsReason: dispatchResult.skipRemainingSiblingsReason,
    toolExpansionInsertedChildCount: dispatchResult.toolExpansionInsertedChildCount,
    failOnCompleteHookError: execution.forceStrippedTaskText !== undefined,
    persistFailureAnnotation: execution.persistFailureAnnotation,
    traceStatisticsConfig: completion.traceStatisticsConfig,
    currentRound: traceConfig.roundContext.currentRound,
    totalRounds: traceConfig.roundContext.totalRounds,
  });

  if (completionResult.groupEnded === true) {
    groupEnded = true;
  }

  const normalizedCompletionResult = {
    ...completionResult,
    executedWorkerCommand: selectedWorkerCommand,
    workerFailureClass: completionResult.continueLoop
      ? undefined
      : classifyIterationFailure({
        runReason: dispatchResult.verificationFailureRunReason,
        exitCode: completionResult.exitCode ?? 0,
        message: completionResult.failureMessage ?? dispatchResult.verificationFailureMessage,
        usageLimitDetected: dispatchResult.verificationFailureRunReason === RUN_REASON_USAGE_LIMIT_DETECTED,
        stdout: dispatchResult.executionStdout,
      }),
  };

  if (!completionResult.continueLoop && (completionResult.exitCode ?? 0) !== 0 && !groupEnded) {
    emitGroupFailure(completionResult.failureMessage ?? dispatchResult.verificationFailureRunReason);
  } else if (!completionResult.continueLoop && !groupEnded) {
    emitGroupSuccess();
  }

  return normalizedCompletionResult;
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error);
    emitGroupFailure(message);
    throw error;
  }
}
  const classifyIterationFailure = (input: {
    runReason?: string;
    exitCode?: number | null;
    message?: string;
    usageLimitDetected?: boolean;
    stdout?: string;
    stderr?: string;
  }): WorkerFailureClass => classifyWorkerFailure({
    runReason: input.runReason,
    exitCode: input.exitCode,
    message: input.message,
    usageLimitDetected: input.usageLimitDetected,
    stdout: input.stdout,
    stderr: input.stderr,
  });
