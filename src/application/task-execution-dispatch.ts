import { type Task } from "../domain/parser.js";
import type { TaskIntent } from "../domain/task-intent.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { parsePlannerOutput, insertSubitems } from "../domain/planner.js";
import { buildTaskHierarchyTemplateVars, renderTemplate, type TemplateVars } from "../domain/template.js";
import type {
  ArtifactRunContext,
  CommandExecutionOptions,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
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
    toolExpansionInsertedChildCount?: number;
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
  selectedWorkerPattern: ParsedWorkerPattern;
  pendingPreRunResetTraceEvents: Array<{ file: string; resetCount: number; dryRun: boolean }>;
  traceRunSession: ReturnType<typeof createTraceRunSession>;
  roundContext: {
    currentRound: number;
    totalRounds: number;
  };
  configuredOnlyVerify: boolean;
  onlyVerify: boolean;
  shouldVerify: boolean;
  mode: RunnerMode;
  keepArtifacts: boolean;
  showAgentOutput: boolean;
  ignoreCliBlock: boolean;
  verify: boolean;
  noRepair: boolean;
  repairAttempts: number;
  taskIntent?: TaskIntent;
  memoryCapturePrefix?: "memory" | "memorize" | "remember" | "inventory";
  toolName?: string;
  toolPayload?: string;
  task: Task;
  prompt: string;
  expandedContextBefore: string;
  artifactContext: ArtifactRunContext;
  resolvedWorkerCommand: string[];
  resolvedWorkerPattern: ParsedWorkerPattern;
  trace: boolean;
  executionEnv?: Record<string, string>;
  cliExecutionOptionsWithVerificationTemplateFailureAbort: CommandExecutionOptions | undefined;
  cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: CommandExecutionOptions | undefined;
}): Promise<TaskExecutionDispatchResult> {
  const {
    dependencies,
    emit,
    files,
    selectedWorkerCommand,
    selectedWorkerPattern,
    pendingPreRunResetTraceEvents,
    traceRunSession,
    roundContext,
    configuredOnlyVerify,
    onlyVerify,
    shouldVerify,
    mode,
    keepArtifacts,
    showAgentOutput,
    ignoreCliBlock,
    verify,
    noRepair,
    repairAttempts,
    taskIntent,
    memoryCapturePrefix,
    toolName,
    toolPayload,
    task,
    prompt,
    expandedContextBefore,
    artifactContext,
    resolvedWorkerCommand,
    resolvedWorkerPattern,
    trace,
    executionEnv,
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
  traceRunSession.emitRoundStarted(roundContext.currentRound, roundContext.totalRounds);
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

  const isMemoryCaptureTask = taskIntent === "memory-capture";
  const isToolExpansionTask = taskIntent === "tool-expansion";

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
      env: executionEnv,
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

  if (isToolExpansionTask) {
    if (mode === "detached") {
      return {
        kind: "execution-failed",
        executionFailureMessage:
          "Tool expansion tasks do not support detached mode because worker output is required for TODO insertion.",
        executionFailureRunReason: "Tool expansion task cannot insert children in detached mode.",
        executionFailureExitCode: 1,
      };
    }

    if (!toolName) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Tool expansion task is missing a resolved tool name.",
        executionFailureRunReason: "Tool expansion task intent is missing tool metadata.",
        executionFailureExitCode: 1,
      };
    }

    const resolvedTool = dependencies.toolResolver?.resolve(toolName);
    if (!resolvedTool) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Unable to resolve tool template: " + toolName,
        executionFailureRunReason: "Tool expansion template could not be resolved.",
        executionFailureExitCode: 1,
      };
    }

    const source = dependencies.fileSystem.readText(task.file);
    const renderedToolPrompt = renderTemplate(resolvedTool.template, {
      task: task.text,
      payload: toolPayload ?? "",
      file: task.file,
      context: expandedContextBefore,
      taskIndex: task.index,
      taskLine: task.line,
      source,
      ...buildTaskHierarchyTemplateVars(task),
    } satisfies TemplateVars);

    emit({ kind: "info", message: "Running tool expansion: " + resolvedTool.name + " [template=" + resolvedTool.templatePath + "]" });
    const executePhaseTrace = traceRunSession.beginPhase("execute", selectedWorkerCommand);
    traceRunSession.emitPromptMetrics(renderedToolPrompt, expandedContextBefore, "execute.md");
    const runResult = await dependencies.workerExecutor.runWorker({
      workerPattern: selectedWorkerPattern,
      prompt: renderedToolPrompt,
      mode,
      trace,
      cwd: dependencies.workingDirectory.cwd(),
      env: executionEnv,
      configDir: dependencies.configDir?.configDir,
      artifactContext,
      artifactPhase: "execute",
    });
    traceRunSession.completePhase(
      executePhaseTrace,
      runResult.exitCode,
      runResult.stdout,
      runResult.stderr,
      true,
    );
    emitExecutionWorkerOutput(runResult.stdout, runResult.stderr);

    if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Tool expansion worker exited with code " + runResult.exitCode + ".",
        executionFailureRunReason: "Tool expansion worker exited with a non-zero code.",
        executionFailureExitCode: runResult.exitCode,
      };
    }

    const subitemLines = parsePlannerOutput(runResult.stdout);
    if (subitemLines.length > 0) {
      const updatedSource = insertSubitems(source, task, subitemLines);
      dependencies.fileSystem.writeText(task.file, updatedSource);
      emit({
        kind: "info",
        message: "Inserted " + subitemLines.length + " tool-generated child TODO item"
          + (subitemLines.length === 1 ? "" : "s") + ".",
      });
    } else {
      emit({ kind: "info", message: "Tool expansion produced no child TODO items." });
    }

    return {
      kind: "ready-for-completion",
      shouldVerify: false,
      cliExecutionOptionsForVerification: cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
      verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
      verificationFailureRunReason: "Verification failed after all repair attempts.",
      toolExpansionInsertedChildCount: subitemLines.length,
    };
  }

  // Default branch executes the configured worker command for standard tasks.
  emit({ kind: "info", message: "Running: " + resolvedWorkerCommand.join(" ") + " [mode=" + mode + "]" });
  const executePhaseTrace = traceRunSession.beginPhase("execute", resolvedWorkerCommand);
  traceRunSession.emitPromptMetrics(prompt, expandedContextBefore, "execute.md");
  const runResult = await dependencies.workerExecutor.runWorker({
    workerPattern: selectedWorkerPattern,
    prompt,
    mode,
    trace,
    cwd: dependencies.workingDirectory.cwd(),
    env: executionEnv,
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
    if (isMemoryCaptureTask) {
      return {
        kind: "execution-failed",
        executionFailureMessage:
          "Memory capture tasks do not support detached mode because worker output is required for persistence.",
        executionFailureRunReason: "Memory capture task cannot persist memory in detached mode.",
        executionFailureExitCode: 1,
      };
    }

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

  if (isMemoryCaptureTask) {
    const persistenceResult = persistMemoryCaptureOutput({
      sourcePath: task.file,
      workerOutput: runResult.stdout,
      memoryCapturePrefix,
      dependencies,
      emit,
    });
    if (!persistenceResult.ok) {
      return {
        kind: "execution-failed",
        executionFailureMessage: persistenceResult.message,
        executionFailureRunReason: persistenceResult.reason,
        executionFailureExitCode: 1,
      };
    }
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

function persistMemoryCaptureOutput(params: {
  sourcePath: string;
  workerOutput: string;
  memoryCapturePrefix?: "memory" | "memorize" | "remember" | "inventory";
  dependencies: RunTaskDependencies;
  emit: EmitFn;
}): { ok: true } | { ok: false; message: string; reason: string } {
  const { sourcePath, workerOutput, memoryCapturePrefix, dependencies, emit } = params;
  const normalizedOutput = workerOutput.trim();
  if (normalizedOutput.length === 0) {
    return {
      ok: false,
      message: "Memory capture worker returned empty output; nothing to persist.",
      reason: "Memory capture worker returned empty output.",
    };
  }

  if (!dependencies.memoryWriter) {
    return {
      ok: false,
      message: "Memory capture requires a configured memory writer.",
      reason: "Memory writer is not configured.",
    };
  }

  const writeResult = dependencies.memoryWriter.write({
    sourcePath,
    workerOutput: normalizedOutput,
    capturePrefix: memoryCapturePrefix,
  });
  if (!writeResult.ok) {
    if (writeResult.error.warningMessage) {
      emit({
        kind: "warn",
        message: writeResult.error.warningMessage,
      });
    }

    return {
      ok: false,
      message: writeResult.error.message,
      reason: writeResult.error.reason,
    };
  }

  if (writeResult.value.warningMessage) {
    emit({
      kind: "warn",
      message: writeResult.value.warningMessage,
    });
  }

  return { ok: true };
}
