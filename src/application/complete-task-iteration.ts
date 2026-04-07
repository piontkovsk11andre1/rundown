import { type Task } from "../domain/parser.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import { handleTemplateCliFailure } from "./cli-block-handlers.js";
import {
  checkTaskUsingFileSystem,
  skipRemainingSiblingsUsingFileSystem,
} from "./checkbox-operations.js";
import {
  afterTaskComplete,
  afterTaskFailed,
} from "./run-lifecycle.js";
import { createTraceRunSession } from "./trace-run-session.js";
import { type ProjectTemplates } from "./project-templates.js";
import type {
  ArtifactRunContext,
  ArtifactStoreStatus,
  CommandExecutionOptions,
  CommandExecutor,
  TraceWriterPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ExtraTemplateVars } from "../domain/template-vars.js";
import type { RunTaskDependencies } from "./run-task-execution.js";
import { pluralize } from "./run-task-utils.js";

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
  allowRepair: boolean;
  trace: boolean;
  verbose: boolean;
  cliBlockExecutor: CommandExecutor;
  cliExpansionEnabled: boolean;
  task: Task;
  sourceText: string;
  expandedSource: string;
  expandedContextBefore: string;
  templates: ProjectTemplates;
  templateVarsWithTrace: ExtraTemplateVars;
  executionEnv?: Record<string, string>;
  automationCommand: string[];
  automationWorkerPattern: ParsedWorkerPattern;
  shouldVerify: boolean;
  verificationPrompt: string;
  artifactContext: ArtifactContext;
  cliExecutionOptionsWithVerificationTemplateFailureAbort: CommandExecutionOptions | undefined;
  verificationFailureMessage: string;
  verificationFailureRunReason: string;
  skipRemainingSiblingsReason?: string;
  toolExpansionInsertedChildCount?: number;
}): Promise<{ continueLoop: boolean; exitCode?: number }> {
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
    allowRepair,
    trace,
    verbose,
    cliBlockExecutor,
    cliExpansionEnabled,
    task,
    sourceText,
    expandedSource,
    expandedContextBefore,
    templates,
    templateVarsWithTrace,
    executionEnv,
    automationCommand,
    automationWorkerPattern,
    shouldVerify,
    verificationPrompt,
    artifactContext,
    cliExecutionOptionsWithVerificationTemplateFailureAbort,
    verificationFailureMessage,
    verificationFailureRunReason,
    skipRemainingSiblingsReason,
    toolExpansionInsertedChildCount,
  } = params;

  // Run verification and optional repair before marking the task as complete.
  if (shouldVerify) {
    const verifyPhaseTrace = traceRunSession.beginPhase("verify", automationCommand);
    traceRunSession.emitPromptMetrics(verificationPrompt, expandedContextBefore, "verify.md");
    let valid: boolean;
    let failureReason: string | null;
    try {
      ({ valid, failureReason } = await runVerifyRepairLoop({
        taskVerification: dependencies.taskVerification,
        taskRepair: dependencies.taskRepair,
        verificationStore: dependencies.verificationStore,
        traceWriter: state.traceWriter,
        output: dependencies.output,
      }, {
        task,
        source: expandedSource,
        contextBefore: expandedContextBefore,
        verifyTemplate: templates.verify,
        repairTemplate: templates.repair,
        workerPattern: automationWorkerPattern,
        configDir: dependencies.configDir?.configDir,
        maxRepairAttempts,
        allowRepair,
        templateVars: templateVarsWithTrace,
        executionEnv,
        artifactContext,
        trace,
        verbose,
        cliBlockExecutor,
        cliExecutionOptions: cliExecutionOptionsWithVerificationTemplateFailureAbort,
        cliExpansionEnabled,
      }));
    } catch (error) {
      const failureCode = await handleTemplateCliFailure(
        error,
        emit,
        async () => await afterTaskFailed(
          dependencies,
          task,
          sourceText,
          onFailCommand,
          hideHookOutput,
          extraTemplateVars,
        ),
        async (failureMessage) => await failRun(1, "failed", failureMessage, 1),
      );
      if (failureCode !== null) {
        return { continueLoop: false, exitCode: failureCode };
      }
      throw error;
    }
    // Record verification phase completion for trace consumers.
    traceRunSession.completePhase(verifyPhaseTrace, valid ? 0 : 1, "", "", false);
    if (!valid) {
      const fullVerificationFailureMessage = failureReason
        ? verificationFailureMessage + "\n" + failureReason
        : verificationFailureMessage;
      // Surface verification details, trigger failure hooks, and terminate the run.
      emit({ kind: "error", message: fullVerificationFailureMessage });
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
        exitCode: await failRun(2, "verification-failed", verificationFailureRunReason, 2),
      };
    }
  }

  // Mark the task checkbox in the markdown source once iteration checks pass.
  checkTaskUsingFileSystem(task, dependencies.fileSystem);

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
    return { continueLoop: true };
  }

  const shouldDeferCommit = commitAfterComplete && deferCommitUntilPostRun;

  // Save commit context when commits are deferred to post-run lifecycle handling.
  if (shouldDeferCommit) {
    state.deferredCommitContext = {
      task,
      source: sourceText,
      artifactContext,
    };
  }
  // Run completion hooks and optional immediate commit.
  const taskCompletionExtra = await afterTaskComplete(
    dependencies,
    task,
    sourceText,
    commitAfterComplete && !shouldDeferCommit,
    commitMessageTemplate,
    onCompleteCommand,
    hideHookOutput,
    extraTemplateVars,
  );
  // Persist successful completion state and telemetry.
  await finishRun(0, "completed", keepArtifacts, undefined, taskCompletionExtra);
  state.tasksCompleted++;
  // Stop after the first completed task when not running in run-all mode.
  if (!effectiveRunAll) {
    state.runCompleted = true;
    return { continueLoop: false, exitCode: 0 };
  }
  // Prepare clean artifacts before the next task iteration.
  resetArtifacts();
  return { continueLoop: true };
}
