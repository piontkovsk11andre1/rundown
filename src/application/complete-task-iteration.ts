import { type Task } from "../domain/parser.js";
import { parseTasks } from "../domain/parser.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { isParallelGroupTaskText } from "../domain/parallel-group.js";
import { hasUncheckedDescendants } from "../domain/task-selection.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import { handleTemplateCliFailure } from "./cli-block-handlers.js";
import {
  advanceForLoopUsingFileSystem,
  checkTaskUsingFileSystem,
  insertTraceStatisticsUsingFileSystem,
  skipRemainingSiblingsUsingFileSystem,
  syncForLoopMetadataItemsUsingFileSystem,
  writeFixAnnotationToFile,
} from "./checkbox-operations.js";
import {
  afterTaskComplete,
  OnCompleteCommitError,
  afterTaskFailed,
  OnCompleteHookError,
} from "./run-lifecycle.js";
import { createTraceRunSession } from "./trace-run-session.js";
import { type ProjectTemplates } from "./project-templates.js";
import type {
  ArtifactRunContext,
  ArtifactStoreStatus,
  CommandExecutionOptions,
  CommandExecutor,
  ProcessRunMode,
  TraceWriterPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { TraceStatisticsConfig } from "../domain/worker-config.js";
import { formatStatisticsLines } from "../domain/trace-statistics.js";
import type { RunTaskDependencies } from "./run-task-execution.js";
import { pluralize } from "./run-task-utils.js";
import { getForCurrentValue, getForItemValues, isForLoopTaskText } from "../domain/for-loop.js";
import {
  RUN_REASON_VERIFICATION_FAILED,
  RUN_REASON_USAGE_LIMIT_DETECTED,
} from "../domain/run-reasons.js";
import {
  WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
  WORKER_FAILURE_CLASS_USAGE_LIMIT,
  type WorkerFailureClass,
} from "../domain/worker-health.js";
import { classifyWorkerFailure } from "./worker-failure-classification.js";
import {
  normalizeRepairPathForDisplay,
  resolveInlineRundownTargetArtifactPath,
  resolveRepairTemplateForTask,
  resolveResolveTemplateForTask,
  serializeSelectedTaskMetadata,
} from "./repair-template-resolution.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;
type ArtifactContext = ArtifactRunContext;

/**
 * Carries mutable state that persists across task iterations during a run.
 */
export interface CompleteTaskIterationState {
  // Trace writer bound to the current artifact context.
  traceWriter: TraceWriterPort;
  // Deferred commit payload used when commit happens after the run completes.
  deferredCommitContext: { task: Task; source: string; artifactContext: ArtifactContext } | null;
  // Number of tasks completed in the current run session.
  tasksCompleted: number;
  // Marks whether the surrounding run loop has finished.
  runCompleted: boolean;
}

/**
 * Finalizes a single task iteration after execution dispatch succeeds.
 *
 * This handles verification/repair, marks the checkbox in the source task file,
 * executes completion hooks, and decides whether the outer loop continues.
 */
export async function completeTaskIteration(params: {
  dependencies: RunTaskDependencies;
  emit: EmitFn;
  state: CompleteTaskIterationState;
  traceRunSession: ReturnType<typeof createTraceRunSession>;
  failRun: (
    code: number,
    status: ArtifactStoreStatus,
    reason: string,
    exitCode: number | null,
    preserve?: boolean,
    extra?: Record<string, unknown>,
  ) => Promise<number>;
  finishRun: (
    code: number,
    status: ArtifactStoreStatus,
    preserve?: boolean,
    failure?: { reason: string; exitCode: number | null },
    extra?: Record<string, unknown>,
  ) => Promise<number>;
  resetArtifacts: () => void;
  keepArtifacts: boolean;
  effectiveRunAll: boolean;
  commitAfterComplete: boolean;
  deferCommitUntilPostRun: boolean;
  commitMessageTemplate?: string;
  onCompleteCommand?: string;
  onFailCommand?: string;
  extraTemplateVars: ExtraTemplateVars;
  hideHookOutput: boolean;
  maxRepairAttempts: number;
  maxResolveRepairAttempts?: number;
  allowRepair: boolean;
  trace: boolean;
  verbose: boolean;
  cliBlockExecutor: CommandExecutor;
  cliExpansionEnabled: boolean;
  task: Task;
  verificationTask?: Task;
  sourceText: string;
  expandedSource: string;
  expandedContextBefore: string;
  templates: ProjectTemplates;
  templateVarsWithTrace: ExtraTemplateVars;
  executionEnv?: Record<string, string>;
  automationCommand: string[];
  automationWorkerPattern: ParsedWorkerPattern;
  resolveVerifyRepairWorkerPattern?: (input: {
    phase: "verify" | "repair" | "resolve" | "resolveRepair";
    attempt?: number;
  }) => ParsedWorkerPattern;
  shouldVerify: boolean;
  runMode: ProcessRunMode;
  traceOnly?: boolean;
  executionOutputCaptured?: boolean;
  verificationPrompt: string;
  executionStdout?: string;
  isInlineCliTask?: boolean;
  isToolExpansionTask?: boolean;
  artifactContext: ArtifactContext;
  cliExecutionOptionsWithVerificationTemplateFailureAbort: CommandExecutionOptions | undefined;
  verificationFailureMessage: string;
  verificationFailureRunReason: string;
  skipRemainingSiblingsReason?: string;
  toolExpansionInsertedChildCount?: number;
  forLoopAdvanced?: {
    current: string;
    remainingItems: number;
  };
  forLoopCompleted?: boolean;
  forLoopItems?: string[];
  failOnCompleteHookError?: boolean;
  persistFailureAnnotation?: boolean;
  traceStatisticsConfig?: TraceStatisticsConfig;
  currentRound?: number;
  totalRounds?: number;
}): Promise<{
  continueLoop: boolean;
  exitCode?: number;
  forceRetryableFailure?: boolean;
  failureMessage?: string;
  runFailureReason?: string;
  groupEnded?: boolean;
}> {
  const {
    dependencies,
    emit,
    state,
    traceRunSession,
    failRun,
    finishRun,
    resetArtifacts,
    keepArtifacts,
    effectiveRunAll,
    commitAfterComplete,
    deferCommitUntilPostRun,
    commitMessageTemplate,
    onCompleteCommand,
    onFailCommand,
    extraTemplateVars,
    hideHookOutput,
    maxRepairAttempts,
    maxResolveRepairAttempts = 1,
    allowRepair,
    trace,
    verbose,
    cliBlockExecutor,
    cliExpansionEnabled,
    task,
    verificationTask,
    sourceText,
    expandedSource,
    expandedContextBefore,
    templates,
    templateVarsWithTrace,
    executionEnv,
    automationCommand,
    automationWorkerPattern,
    resolveVerifyRepairWorkerPattern,
    shouldVerify,
    runMode,
    traceOnly = false,
    executionOutputCaptured,
    verificationPrompt,
    executionStdout,
    isInlineCliTask,
    isToolExpansionTask,
    artifactContext,
    cliExecutionOptionsWithVerificationTemplateFailureAbort,
    verificationFailureMessage,
    verificationFailureRunReason,
    skipRemainingSiblingsReason,
    toolExpansionInsertedChildCount,
    forLoopAdvanced,
    forLoopCompleted,
    forLoopItems,
    failOnCompleteHookError,
    persistFailureAnnotation = true,
    traceStatisticsConfig,
    currentRound = 1,
    totalRounds = 1,
  } = params;
  const failOnCompleteHookFailure = failOnCompleteHookError ?? false;

  // Run verification and optional repair before marking the task as complete.
  const taskForVerification = verificationTask ?? task;
  if (shouldVerify) {
    const resolvedRepairTemplate = resolveRepairTemplateForTask({
      task: taskForVerification,
      configDir: dependencies.configDir,
      templateLoader: dependencies.templateLoader,
      pathOperations: dependencies.pathOperations,
      defaultRepairTemplate: templates.repair,
    });
    const resolvedResolveTemplate = resolveResolveTemplateForTask({
      task: taskForVerification,
      configDir: dependencies.configDir,
      templateLoader: dependencies.templateLoader,
      pathOperations: dependencies.pathOperations,
      defaultResolveTemplate: templates.resolve,
    });
    const controllingTaskPath = dependencies.pathOperations.resolve(taskForVerification.file);
    const controllingTaskFile = task.file;
    const targetArtifactPath = resolveInlineRundownTargetArtifactPath({
      task: taskForVerification,
      pathOperations: dependencies.pathOperations,
    });
    const cwd = dependencies.workingDirectory.cwd();
    const targetArtifactPathDisplay = targetArtifactPath
      ? normalizeRepairPathForDisplay({
        absolutePath: targetArtifactPath,
        cwd,
        pathOperations: dependencies.pathOperations,
      })
      : undefined;
    const controllingTaskPathDisplay = normalizeRepairPathForDisplay({
      absolutePath: controllingTaskPath,
      cwd,
      pathOperations: dependencies.pathOperations,
    });
    const selectedTaskMetadata = serializeSelectedTaskMetadata({
      task: taskForVerification,
      controllingTaskPath,
    });
    const verifyPhaseTrace = traceRunSession.beginPhase("verify", automationCommand);
    traceRunSession.emitPromptMetrics(verificationPrompt, expandedContextBefore, "verify.md");
    let valid: boolean;
    let failureReason: string | null;
    let usageLimitDetected = false;
    let verificationEfficiency: { verifyAttempts: number; repairAttempts: number } = {
      verifyAttempts: 0,
      repairAttempts: 0,
    };
    try {
      ({
        valid,
        failureReason,
        usageLimitDetected: usageLimitDetected = false,
      } = await runVerifyRepairLoop({
        taskVerification: dependencies.taskVerification,
        taskRepair: dependencies.taskRepair,
        verificationStore: dependencies.verificationStore,
        traceWriter: state.traceWriter,
        output: dependencies.output,
      }, {
        task: taskForVerification,
        source: expandedSource,
        contextBefore: expandedContextBefore,
        verifyTemplate: templates.verify,
        repairTemplate: resolvedRepairTemplate,
        resolveTemplate: resolvedResolveTemplate,
        executionStdout,
        workerPattern: automationWorkerPattern,
        resolveWorkerPattern: resolveVerifyRepairWorkerPattern,
        configDir: dependencies.configDir?.configDir,
        maxRepairAttempts,
        maxResolveRepairAttempts,
        allowRepair,
        templateVars: templateVarsWithTrace,
        executionEnv,
        artifactContext,
        trace,
        verbose,
        cliBlockExecutor,
        cliExecutionOptions: cliExecutionOptionsWithVerificationTemplateFailureAbort,
        cliExpansionEnabled,
        runMode,
        executionOutputCaptured,
        isInlineCliTask,
        isToolExpansionTask,
        targetArtifactPath: targetArtifactPath ?? undefined,
        targetArtifactPathDisplay,
        controllingTaskPath,
        controllingTaskPathDisplay,
        controllingTaskFile,
        selectedTaskMetadata,
        onVerificationEfficiency: (metrics) => {
          verificationEfficiency = metrics;
        },
      }));
    } catch (error) {
      const failureCode = await handleTemplateCliFailure(
        error,
        emit,
        async () => await afterTaskFailed(
          dependencies,
          taskForVerification,
          sourceText,
          onFailCommand,
          hideHookOutput,
          extraTemplateVars,
        ),
        async (failureMessage) => await failRun(1, "failed", failureMessage, 1),
      );
      if (failureCode !== null) {
        return {
          continueLoop: false,
          exitCode: failureCode,
          forceRetryableFailure: true,
          groupEnded: false,
        };
      }
      throw error;
    }
    // Record verification phase completion for trace consumers.
    traceRunSession.completePhase(verifyPhaseTrace, valid ? 0 : 1, "", "", false);
    traceRunSession.setVerificationEfficiency(
      verificationEfficiency.verifyAttempts,
      verificationEfficiency.repairAttempts,
    );
    if (!valid) {
      const usageLimitFailureMessage = failureReason
        ?? "Possible API usage limit detected during verification/repair.";
      const fullVerificationFailureMessage = failureReason
        ? verificationFailureMessage + "\n" + failureReason
        : verificationFailureMessage;
      const surfacedFailureMessage = usageLimitDetected
        ? usageLimitFailureMessage
        : fullVerificationFailureMessage;
      const failureClass = usageLimitDetected
        ? WORKER_FAILURE_CLASS_USAGE_LIMIT
        : classifyWorkerFailure({
          message: surfacedFailureMessage,
          runReason: RUN_REASON_VERIFICATION_FAILED,
          exitCode: 2,
          usageLimitDetected,
        });
      if (persistFailureAnnotation) {
        try {
          writeFixAnnotationToFile(task, failureReason, dependencies.fileSystem);
        } catch (error) {
          emit({ kind: "warn", message: "Failed to write verification fix annotation: " + String(error) });
        }
      }
      // Surface verification details, trigger failure hooks, and terminate the run.
      emit({ kind: "error", message: surfacedFailureMessage });
      await afterTaskFailed(
        dependencies,
        taskForVerification,
        sourceText,
        onFailCommand,
        hideHookOutput,
        extraTemplateVars,
      );
      return {
        continueLoop: false,
        forceRetryableFailure: !usageLimitDetected && failureClass !== WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
        failureMessage: surfacedFailureMessage,
        runFailureReason: usageLimitDetected ? RUN_REASON_USAGE_LIMIT_DETECTED : RUN_REASON_VERIFICATION_FAILED,
        exitCode: await failRun(
          2,
          "verification-failed",
          usageLimitDetected ? RUN_REASON_USAGE_LIMIT_DETECTED : RUN_REASON_VERIFICATION_FAILED,
          2,
        ),
        groupEnded: false,
      };
    }
  }

  const latestSource = dependencies.fileSystem.readText(task.file);
  const latestTasks = parseTasks(latestSource, task.file);
  const latestTask = latestTasks.find((candidate) => candidate.line === task.line && candidate.index === task.index)
    ?? latestTasks.find((candidate) => candidate.line === task.line);

  const isParallelGroupTask = latestTask
    ? latestTask.intent === "parallel-group"
      || isParallelGroupTaskText(latestTask.text, dependencies.toolResolver)
    : task.intent === "parallel-group"
      || isParallelGroupTaskText(task.text, dependencies.toolResolver);

  if (isParallelGroupTask && latestTask && hasUncheckedDescendants(latestTask, latestTasks, { useChildren: true })) {
    const message = "Parallel-group parent cannot auto-complete while unchecked descendants remain.";
    emit({ kind: "error", message });
    await afterTaskFailed(
      dependencies,
      task,
      sourceText,
      onFailCommand,
      hideHookOutput,
      extraTemplateVars,
    );
    return {
      continueLoop: false,
      forceRetryableFailure: false,
      failureMessage: message,
      exitCode: await failRun(1, "failed", message, 1),
      groupEnded: false,
    };
  }

  const latestTaskText = latestTask?.text;
  const isLoopTask = forLoopAdvanced !== undefined
    || forLoopCompleted === true
    || forLoopItems !== undefined
    || isForLoopTaskText(task.text)
    || (latestTaskText !== undefined && isForLoopTaskText(latestTaskText));
  if (isLoopTask) {
    const completedLoopItem = getForCurrentValue(task.subItems);
    const loopItemCount = forLoopItems?.length ?? getForItemValues(task.subItems).length;

    if (forLoopItems && forLoopItems.length > 0) {
      syncForLoopMetadataItemsUsingFileSystem(task, forLoopItems, dependencies.fileSystem);
    }

    if (forLoopAdvanced) {
      if (completedLoopItem) {
        emit({ kind: "info", message: "Loop item completed: " + completedLoopItem + "." });
      }
      emit({
        kind: "info",
        message: "Loop advanced to item: " + forLoopAdvanced.current
          + " (" + forLoopAdvanced.remainingItems + " remaining).",
      });
      state.tasksCompleted++;
      resetArtifacts();
      return { continueLoop: true, groupEnded: false };
    }

    if (forLoopCompleted) {
      if (completedLoopItem) {
        emit({ kind: "info", message: "Loop item completed: " + completedLoopItem + "." });
      }
      emit({
        kind: "info",
        message: "Loop completed after " + loopItemCount + " "
          + pluralize(loopItemCount, "item", "items")
          + "; marking parent task complete.",
      });
    } else {
      const completionTransition = advanceForLoopUsingFileSystem(task, dependencies.fileSystem);
      if (completionTransition.advanced && completionTransition.current) {
        if (completedLoopItem) {
          emit({ kind: "info", message: "Loop item completed: " + completedLoopItem + "." });
        }
        emit({
          kind: "info",
          message: "Loop advanced to item: " + completionTransition.current
            + " (" + completionTransition.remainingItems + " remaining).",
        });
        state.tasksCompleted++;
        resetArtifacts();
        return { continueLoop: true, groupEnded: false };
      }

      if (completionTransition.completed) {
        if (completedLoopItem) {
          emit({ kind: "info", message: "Loop item completed: " + completedLoopItem + "." });
        }
        emit({
          kind: "info",
          message: "Loop completed after " + loopItemCount + " "
            + pluralize(loopItemCount, "item", "items")
            + "; marking parent task complete.",
        });
      }
    }
  }

  // Mark the task checkbox in the markdown source once iteration checks pass.
  checkTaskUsingFileSystem(task, dependencies.fileSystem);

  const shouldInsertTraceStatistics = traceStatisticsConfig?.enabled === true
    && !traceOnly
    && runMode !== "detached"
    && (toolExpansionInsertedChildCount ?? 0) === 0
    && currentRound >= totalRounds;

  if (shouldInsertTraceStatistics) {
    const statisticsSnapshot = traceRunSession.collectStatistics();
    if (statisticsSnapshot) {
      const statisticsLines = formatStatisticsLines(statisticsSnapshot, traceStatisticsConfig.fields);
      if (statisticsLines.length > 0) {
        insertTraceStatisticsUsingFileSystem(task, statisticsLines, dependencies.fileSystem);
      }
    }
  }

  if (skipRemainingSiblingsReason) {
    const skipResult = skipRemainingSiblingsUsingFileSystem(task, skipRemainingSiblingsReason, dependencies.fileSystem);
    emit({
      kind: "info",
      message: "Skipped " + skipResult.skippedSiblingCount + " "
        + pluralize(skipResult.skippedSiblingCount, "sibling task", "sibling tasks")
        + (skipResult.skippedDescendantCount > 0
          ? " and " + skipResult.skippedDescendantCount + " "
            + pluralize(skipResult.skippedDescendantCount, "descendant task", "descendant tasks")
          : "")
        + " because end condition was met.",
    });
    for (const skippedTaskText of skipResult.skippedTaskTexts) {
      emit({
        kind: "info",
        message: "Skipped sibling: " + skippedTaskText + " (reason: " + skipRemainingSiblingsReason + ")",
      });
    }
  }

  emit({ kind: "success", message: "Task checked: " + task.text });
  emit({ kind: "group-end", status: "success" });

  // Tool expansions that inserted children should continue so newly inserted
  // subitems can be selected and executed before ending the run.
  if ((toolExpansionInsertedChildCount ?? 0) > 0) {
    state.tasksCompleted++;
    resetArtifacts();
    return { continueLoop: true, groupEnded: true };
  }

  const shouldDeferCommit = commitAfterComplete && deferCommitUntilPostRun;

  // Save commit context when commits are deferred to post-run lifecycle handling.
  if (shouldDeferCommit) {
    state.deferredCommitContext = {
      task,
      source: dependencies.fileSystem.readText(task.file),
      artifactContext,
    };
  }
  // Run completion hooks and optional immediate commit.
  let taskCompletionExtra: Record<string, unknown> | undefined;
  try {
    taskCompletionExtra = await afterTaskComplete(
      dependencies,
      task,
      sourceText,
      commitAfterComplete && !shouldDeferCommit,
      commitMessageTemplate,
      onCompleteCommand,
      hideHookOutput,
      extraTemplateVars,
      failOnCompleteHookFailure,
    );
  } catch (error) {
    if (error instanceof OnCompleteHookError) {
      await afterTaskFailed(
        dependencies,
        task,
        sourceText,
        onFailCommand,
        hideHookOutput,
        extraTemplateVars,
      );
      return {
        continueLoop: false,
        forceRetryableFailure: false,
        exitCode: await failRun(1, "failed", error.message, error.exitCode),
        groupEnded: true,
      };
    }
    if (error instanceof OnCompleteCommitError) {
      await afterTaskFailed(
        dependencies,
        task,
        sourceText,
        onFailCommand,
        hideHookOutput,
        extraTemplateVars,
      );
      return {
        continueLoop: false,
        forceRetryableFailure: false,
        exitCode: await failRun(1, "failed", error.message, 1),
        groupEnded: true,
      };
    }
    throw error;
  }
  // Persist successful completion state and telemetry.
  await finishRun(0, "completed", keepArtifacts, undefined, taskCompletionExtra);
  state.tasksCompleted++;
  // Stop after the first completed task when not running in run-all mode.
  if (!effectiveRunAll) {
    state.runCompleted = true;
    return { continueLoop: false, exitCode: 0, groupEnded: true };
  }
  // Prepare clean artifacts before the next task iteration.
  resetArtifacts();
  return { continueLoop: true, groupEnded: true };
}
