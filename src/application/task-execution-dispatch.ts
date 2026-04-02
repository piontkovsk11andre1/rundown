import { type Task } from "../domain/parser.js";
import type {
  ArtifactRunContext,
  CommandExecutionOptions,
  PromptTransport,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import {
  delegatedTargetExists,
  parseRundownTaskArgs,
  resolveDelegatedRundownTargetArg,
} from "./rundown-delegation.js";
import { isSameFilePath } from "./run-task-utils.js";
import type { RunTaskDependencies } from "./run-task-execution.js";
import { type RunnerMode } from "./run-task-worker-command.js";
import {
  computeTaskContextMetrics,
  type TaskContextMetrics,
} from "./task-context-resolution.js";
import { createTraceRunSession } from "./trace-run-session.js";

// Normalized emitter signature used across dispatch helpers.
type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

/**
 * Describes the control-flow outcome after dispatching task execution.
 *
 * `ready-for-completion` indicates execution finished and caller may continue.
 * `execution-failed` carries an error message and optional exit code.
 * `detached` indicates the worker was started in detached mode.
 */
export type TaskExecutionDispatchResult =
  | {
    kind: "ready-for-completion";
    shouldVerify: boolean;
    verificationFailureMessage: string;
    verificationFailureRunReason: string;
    cliExecutionOptionsForVerification: CommandExecutionOptions | undefined;
  }
  | {
    kind: "execution-failed";
    executionFailureMessage: string;
    executionFailureRunReason: string;
    executionFailureExitCode: number | null;
  }
  | {
    kind: "detached";
  };

/**
 * Executes the appropriate task runner branch and returns a normalized outcome
 * used by task-iteration completion, verification, and failure handling.
 */
export async function dispatchTaskExecution(params: {
  dependencies: RunTaskDependencies;
  emit: EmitFn;
  files: string[];
  selectedWorkerCommand: string[];
  pendingPreRunResetTraceEvents: Array<{ file: string; resetCount: number; dryRun: boolean }>;
  traceRunSession: ReturnType<typeof createTraceRunSession>;
  configuredOnlyVerify: boolean;
  onlyVerify: boolean;
  shouldVerify: boolean;
  mode: RunnerMode;
  transport: PromptTransport;
  keepArtifacts: boolean;
  showAgentOutput: boolean;
  ignoreCliBlock: boolean;
  verify: boolean;
  noRepair: boolean;
  repairAttempts: number;
  task: Task;
  prompt: string;
  expandedContextBefore: string;
  artifactContext: ArtifactRunContext;
  resolvedWorkerCommand: string[];
  trace: boolean;
  cliExecutionOptionsWithVerificationTemplateFailureAbort: CommandExecutionOptions | undefined;
  cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: CommandExecutionOptions | undefined;
}): Promise<TaskExecutionDispatchResult> {
  const {
    dependencies,
    emit,
    files,
    selectedWorkerCommand,
    pendingPreRunResetTraceEvents,
    traceRunSession,
    configuredOnlyVerify,
    onlyVerify,
    shouldVerify,
    mode,
    transport,
    keepArtifacts,
    showAgentOutput,
    ignoreCliBlock,
    verify,
    noRepair,
    repairAttempts,
    task,
    prompt,
    expandedContextBefore,
    artifactContext,
    resolvedWorkerCommand,
    trace,
    cliExecutionOptionsWithVerificationTemplateFailureAbort,
    cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
  } = params;

  // Compute richer task context metrics only when trace collection is enabled.
  const taskContextMetrics: TaskContextMetrics = trace
    ? computeTaskContextMetrics(files, task, dependencies.fileSystem)
    : {
      sourceFilesScanned: files.length,
      totalUncheckedTasks: 0,
      taskPositionInFile: task.index + 1,
      hasSubtasks: false,
    };
  // Open the run trace entry before execution branches begin.
  traceRunSession.startRun({
    artifactContext,
    task,
    worker: selectedWorkerCommand,
    metrics: taskContextMetrics,
    isVerifyOnly: onlyVerify,
    contextBefore: expandedContextBefore,
  });
  // Flush queued pre-run reset trace events into the active run.
  if (pendingPreRunResetTraceEvents.length > 0) {
    for (const resetEvent of pendingPreRunResetTraceEvents) {
      traceRunSession.emitResetPhase("pre-run-reset", resetEvent.file, resetEvent.resetCount, resetEvent.dryRun);
    }
    pendingPreRunResetTraceEvents.length = 0;
  }

  // Forward worker stdout/stderr only when agent output is explicitly enabled.
  const emitExecutionWorkerOutput = (stdout: string, stderr: string): void => {
    if (!showAgentOutput) {
      return;
    }

    if (stdout) {
      emit({ kind: "text", text: stdout });
    }

    if (stderr) {
      emit({ kind: "stderr", text: stderr });
    }
  };

  // Verify-only mode skips execution and returns verification-only settings.
  if (onlyVerify) {
    emit({ kind: "info", message: configuredOnlyVerify
      ? "Only verify mode — skipping task execution."
      : "Verify-only task mode — skipping task execution."
    });
    return {
      kind: "ready-for-completion",
      shouldVerify: true,
      cliExecutionOptionsForVerification: cliExecutionOptionsWithVerificationTemplateFailureAbort,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
    };
  }

  // Inline CLI tasks execute directly from the task file's directory.
  if (task.isInlineCli) {
    const inlineCliCwd = dependencies.pathOperations.dirname(dependencies.pathOperations.resolve(task.file));
    emit({ kind: "info", message: "Executing inline CLI: " + task.cliCommand! + " [cwd=" + inlineCliCwd + "]" });
    const inlineCliPhaseTrace = traceRunSession.beginPhase("execute", [task.cliCommand!]);
    const cliResult = await dependencies.workerExecutor.executeInlineCli(task.cliCommand!, inlineCliCwd, {
      artifactContext,
      keepArtifacts,
      artifactExtra: { taskType: "inline-cli" },
    });
    traceRunSession.completePhase(inlineCliPhaseTrace, cliResult.exitCode, cliResult.stdout, cliResult.stderr, true);
    emitExecutionWorkerOutput(cliResult.stdout, cliResult.stderr);

    // Abort the iteration when the inline command exits non-zero.
    if (cliResult.exitCode !== 0) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Inline CLI exited with code " + cliResult.exitCode,
        executionFailureRunReason: "Inline CLI exited with a non-zero code.",
        executionFailureExitCode: cliResult.exitCode,
      };
    }

    // Continue to completion/verification path after successful inline CLI execution.
    return {
      kind: "ready-for-completion",
      shouldVerify,
      cliExecutionOptionsForVerification: cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
      verificationFailureMessage: "Verification failed. Task not checked.",
      verificationFailureRunReason: "Verification failed after inline CLI execution.",
    };
  }

  // Rundown tasks delegate execution to a nested `rundown run` invocation.
  if (task.isRundownTask) {
    const rundownTaskCwd = dependencies.pathOperations.dirname(dependencies.pathOperations.resolve(task.file));
    const rundownTaskArgs = parseRundownTaskArgs(task.rundownArgs);
    const delegatedTargetArg = resolveDelegatedRundownTargetArg(rundownTaskArgs);
    const delegatedTarget = delegatedTargetArg
      ? dependencies.pathOperations.resolve(rundownTaskCwd, delegatedTargetArg)
      : null;
    const sourcePath = dependencies.pathOperations.resolve(task.file);
    // Guard against self-targeting delegation to avoid infinite recursion.
    if (delegatedTarget && isSameFilePath(delegatedTarget, sourcePath)) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Rundown task target resolves to the current source file; aborting to avoid infinite recursion.",
        executionFailureRunReason: "Rundown task target resolves to the current source file.",
        executionFailureExitCode: 1,
      };
    }
    // Validate delegated target existence before spawning nested rundown execution.
    if (
      delegatedTarget
      && delegatedTargetArg
      && !delegatedTargetExists(
        delegatedTarget,
        delegatedTargetArg,
        task.file,
        dependencies.fileSystem,
        dependencies.pathOperations,
      )
    ) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Rundown task target file not found: " + delegatedTarget
          + ". Update the path or create the file before running again.",
        executionFailureRunReason: "Rundown task target file not found.",
        executionFailureExitCode: 1,
      };
    }
    // Execute delegated rundown task and inherit parent execution settings.
    emit({ kind: "info", message: "Delegating to rundown: rundown run " + rundownTaskArgs.join(" ") });
    const rundownTaskPhaseTrace = traceRunSession.beginPhase("rundown-delegate", ["rundown", "run", ...rundownTaskArgs]);
    const rundownTaskResult = await dependencies.workerExecutor.executeRundownTask(rundownTaskArgs, rundownTaskCwd, {
      artifactContext,
      keepArtifacts,
      artifactExtra: { taskType: "rundown-task" },
      parentWorkerCommand: resolvedWorkerCommand,
      parentTransport: transport,
      parentKeepArtifacts: keepArtifacts,
      parentShowAgentOutput: showAgentOutput,
      parentIgnoreCliBlock: ignoreCliBlock,
      parentVerify: verify,
      parentNoRepair: noRepair,
      parentRepairAttempts: repairAttempts,
    });
    traceRunSession.completePhase(
      rundownTaskPhaseTrace,
      rundownTaskResult.exitCode,
      rundownTaskResult.stdout,
      rundownTaskResult.stderr,
      true,
    );
    emitExecutionWorkerOutput(rundownTaskResult.stdout, rundownTaskResult.stderr);

    // Surface delegated command failure with a consistent execution-failed payload.
    if (rundownTaskResult.exitCode !== 0) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Rundown task exited with code " + rundownTaskResult.exitCode,
        executionFailureRunReason: "Rundown task exited with a non-zero code.",
        executionFailureExitCode: rundownTaskResult.exitCode,
      };
    }

    // Continue to completion/verification path after successful rundown delegation.
    return {
      kind: "ready-for-completion",
      shouldVerify,
      cliExecutionOptionsForVerification: cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
      verificationFailureMessage: "Verification failed. Task not checked.",
      verificationFailureRunReason: "Verification failed after rundown task execution.",
    };
  }

  // Default branch executes the configured worker command for standard tasks.
  emit({ kind: "info", message: "Running: " + resolvedWorkerCommand.join(" ") + " [mode=" + mode + ", transport=" + transport + "]" });
  const executePhaseTrace = traceRunSession.beginPhase("execute", resolvedWorkerCommand);
  traceRunSession.emitPromptMetrics(prompt, expandedContextBefore, "execute.md");
  const runResult = await dependencies.workerExecutor.runWorker({
    command: resolvedWorkerCommand,
    prompt,
    mode,
    transport,
    trace,
    cwd: dependencies.workingDirectory.cwd(),
    configDir: dependencies.configDir?.configDir,
    artifactContext,
    artifactPhase: "execute",
  });
  traceRunSession.completePhase(
    executePhaseTrace,
    runResult.exitCode,
    runResult.stdout,
    runResult.stderr,
    mode === "wait",
  );

  // Stream worker output only when execution is blocking.
  if (mode === "wait") {
    emitExecutionWorkerOutput(runResult.stdout, runResult.stderr);
  }

  // Detached mode returns early because completion continues out-of-process.
  if (mode === "detached") {
    return { kind: "detached" };
  }

  // Non-zero worker exit codes are treated as execution failures.
  if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
    return {
      kind: "execution-failed",
      executionFailureMessage: "Worker exited with code " + runResult.exitCode + ".",
      executionFailureRunReason: "Worker exited with a non-zero code.",
      executionFailureExitCode: runResult.exitCode,
    };
  }

  // Success path returns verification options for downstream completion flow.
  return {
    kind: "ready-for-completion",
    shouldVerify,
    cliExecutionOptionsForVerification: cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
    verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
    verificationFailureRunReason: "Verification failed after all repair attempts.",
  };
}
