import { type Task } from "../domain/parser.js";
import type { TaskIntent } from "../domain/task-intent.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { insertSubitems } from "../domain/planner.js";
import { parseTasks } from "../domain/parser.js";
import { parseUncheckedTodoLines } from "../domain/todo-lines.js";
import { advanceForLoopUsingFileSystem, syncForLoopMetadataItemsUsingFileSystem } from "./checkbox-operations.js";
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
import type { PrefixChain } from "../domain/prefix-chain.js";
import { executeToolChain } from "./tool-execution.js";
import { pluralize } from "./run-task-utils.js";

const INCLUDE_STACK_ENV = "RUNDOWN_INCLUDE_STACK";
const INLINE_CLI_FAILURE_STREAM_MAX_CHARS = 12_000;
const INLINE_CLI_FAILURE_STREAM_HEAD_CHARS = 2_000;
const INLINE_CLI_FAILURE_STREAM_TAIL_CHARS = 4_000;

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
    executionStdout?: string;
    executionOutputCaptured?: boolean;
    verificationFailureMessage: string;
    verificationFailureRunReason: string;
    cliExecutionOptionsForVerification: CommandExecutionOptions | undefined;
    skipRemainingSiblingsReason?: string;
    toolExpansionInsertedChildCount?: number;
    forLoopAdvanced?: {
      current: string;
      remainingItems: number;
    };
    forLoopItems?: string[];
  }
  | {
    kind: "execution-failed";
    executionFailureMessage: string;
    executionFailureRunReason: string;
    executionFailureExitCode: number | null;
    executionFailureStdout?: string;
    executionFailureStderr?: string;
    forceRetryableFailure?: boolean;
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
  prefixChain?: PrefixChain;
  task: Task;
  prompt: string;
  expandedContextBefore: string;
  artifactContext: ArtifactRunContext;
  resolvedWorkerCommand: string[];
  resolvedWorkerPattern: ParsedWorkerPattern;
  trace: boolean;
  cwd: string;
  executionEnv?: Record<string, string>;
  cliExecutionOptionsWithVerificationTemplateFailureAbort: CommandExecutionOptions | undefined;
  cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace: CommandExecutionOptions | undefined;
  forceRetryMetadata?: {
    attemptNumber: number;
    maxAttempts: number;
    previousRunId: string;
    previousExitCode: number;
  };
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
    prefixChain,
    task,
    prompt,
    expandedContextBefore,
    artifactContext,
    resolvedWorkerCommand,
    resolvedWorkerPattern,
    trace,
    cwd,
    executionEnv,
    cliExecutionOptionsWithVerificationTemplateFailureAbort,
    cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
    forceRetryMetadata,
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
  if (forceRetryMetadata) {
    traceRunSession.emitForceRetry({
      attemptNumber: forceRetryMetadata.attemptNumber,
      maxAttempts: forceRetryMetadata.maxAttempts,
      previousRunId: forceRetryMetadata.previousRunId,
      previousExitCode: forceRetryMetadata.previousExitCode,
    });
  }
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

  // Inline CLI failures should always surface captured command output so users
  // can diagnose without rerunning with --show-agent-output.
  const emitInlineCliFailureOutput = (stdout: string, stderr: string): void => {
    if (showAgentOutput) {
      return;
    }

    if (stdout) {
      emit({ kind: "text", text: formatInlineCliFailureStreamOutput("stdout", stdout) });
    }

    if (stderr) {
      emit({ kind: "stderr", text: formatInlineCliFailureStreamOutput("stderr", stderr) });
    }
  };

  // Unified prefix chain dispatch: when a prefix chain with tools is detected,
  // route through the tool execution pipeline instead of legacy intent branches.
  if (prefixChain && (prefixChain.handler || prefixChain.modifiers.length > 0)) {
    if (mode === "detached" && prefixChain.handler) {
      return {
        kind: "execution-failed",
        executionFailureMessage:
          "Tool-handled tasks do not support detached mode because worker output is required.",
        executionFailureRunReason: "Tool-handled task cannot run in detached mode.",
        executionFailureExitCode: 1,
      };
    }

    const source = dependencies.fileSystem.readText(task.file);
    const allTasks = parseTasks(source, task.file);
    const toolContext: import("../domain/ports/tool-handler-port.js").ToolHandlerContext = {
      task,
      allTasks,
      payload: prefixChain.remainingText,
      source,
      contextBefore: expandedContextBefore,
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
      emit,
      configDir: dependencies.configDir?.configDir,
      workerExecutor: dependencies.workerExecutor,
      workerPattern: selectedWorkerPattern,
      workerCommand: selectedWorkerCommand,
      mode,
      trace,
      cwd,
      executionEnv,
      artifactContext,
      keepArtifacts,
      templateVars: {
        task: task.text,
        payload: prefixChain.remainingText,
        file: task.file,
        context: expandedContextBefore,
        taskIndex: task.index,
        taskLine: task.line,
        source,
        ...buildTaskHierarchyTemplateVars(task),
      } satisfies TemplateVars,
      showAgentOutput,
    };

    const executePhaseTrace = traceRunSession.beginPhase("execute", selectedWorkerCommand);
    const chainResult = await executeToolChain(prefixChain, toolContext, emit);

    if (chainResult.kind === "execution-failed") {
      traceRunSession.completePhase(executePhaseTrace, chainResult.executionFailureExitCode ?? 1, "", "", true);
      return chainResult;
    }

    if (chainResult.kind === "tool-handled") {
      if (chainResult.childFile) {
        const includeExecution = await runIncludedFile({
          dependencies,
          task,
          childFile: chainResult.childFile,
          artifactContext,
          keepArtifacts,
          executionEnv,
          selectedWorkerCommand,
          showAgentOutput,
          ignoreCliBlock,
          verify,
          noRepair,
          repairAttempts,
          emitExecutionWorkerOutput,
        });

        if (!includeExecution.ok) {
          traceRunSession.completePhase(executePhaseTrace, includeExecution.exitCode ?? 1, "", "", true);
          return {
            kind: "execution-failed",
            executionFailureMessage: includeExecution.message,
            executionFailureRunReason: includeExecution.reason,
            executionFailureExitCode: includeExecution.exitCode,
            executionFailureStdout: includeExecution.stdout,
            executionFailureStderr: includeExecution.stderr,
            forceRetryableFailure: true,
          };
        }
      }

      traceRunSession.completePhase(executePhaseTrace, 0, "", "", true);
      const skipRemainingSiblingsReason = chainResult.skipRemainingSiblings?.reason;
      if (prefixChain?.handler?.tool.name === "for" && chainResult.forLoopItems) {
        syncForLoopMetadataItemsUsingFileSystem(task, chainResult.forLoopItems, dependencies.fileSystem);
      }

      const forLoopAdvanceResult = chainResult.childFile || prefixChain?.handler?.tool.name !== "for"
        ? undefined
        : advanceForLoopUsingFileSystem(task, dependencies.fileSystem);
      return {
        kind: "ready-for-completion",
        // Sibling-skip control-flow uses skip annotations as the audit trail,
        // so skipped siblings should not trigger any verification phase.
        shouldVerify: skipRemainingSiblingsReason ? false : chainResult.shouldVerify && shouldVerify,
        cliExecutionOptionsForVerification: cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
        verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
        verificationFailureRunReason: "Verification failed after all repair attempts.",
        skipRemainingSiblingsReason,
        toolExpansionInsertedChildCount: chainResult.childTaskCount > 0 ? chainResult.childTaskCount : undefined,
        ...(forLoopAdvanceResult?.advanced && forLoopAdvanceResult.current
          ? {
            forLoopAdvanced: {
              current: forLoopAdvanceResult.current,
              remainingItems: forLoopAdvanceResult.remainingItems,
            },
          }
          : {}),
        ...(prefixChain?.handler?.tool.name === "for" && chainResult.forLoopItems
          ? {
            forLoopItems: chainResult.forLoopItems,
          }
          : {}),
      };
    }

    // chainResult.kind === "modifiers-only" — fall through to default execution
    // with any modifier-applied context (e.g. profile override).
    traceRunSession.completePhase(executePhaseTrace, 0, "", "", true);
  }

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
    const inlineCliCommand = resolveInlineCliCommand(task);
    const inlineCliCwd = dependencies.pathOperations.dirname(dependencies.pathOperations.resolve(task.file));
    emit({ kind: "info", message: "Executing inline CLI: " + inlineCliCommand + " [cwd=" + inlineCliCwd + "]" });
    const inlineCliPhaseTrace = traceRunSession.beginPhase("execute", [inlineCliCommand]);
    const cliResult = await dependencies.workerExecutor.executeInlineCli(inlineCliCommand, inlineCliCwd, {
      env: executionEnv,
      artifactContext,
      keepArtifacts,
      artifactExtra: { taskType: "inline-cli" },
    });
    traceRunSession.completePhase(inlineCliPhaseTrace, cliResult.exitCode, cliResult.stdout, cliResult.stderr, true);
    emitExecutionWorkerOutput(cliResult.stdout, cliResult.stderr);

    // Abort the iteration when the inline command exits non-zero.
    if (cliResult.exitCode !== 0) {
      emitInlineCliFailureOutput(cliResult.stdout, cliResult.stderr);
      return {
        kind: "execution-failed",
        executionFailureMessage: "Inline CLI exited with code " + cliResult.exitCode,
        executionFailureRunReason: "Inline CLI exited with a non-zero code.",
        executionFailureExitCode: cliResult.exitCode,
        executionFailureStdout: cliResult.stdout,
        executionFailureStderr: cliResult.stderr,
        forceRetryableFailure: true,
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
    if (!resolvedTool || !resolvedTool.template) {
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
      cwd,
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

    if (runResult.exitCode === null) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Tool expansion worker execution was interrupted before completion.",
        executionFailureRunReason: "Tool expansion worker execution was interrupted.",
        executionFailureExitCode: null,
        executionFailureStdout: runResult.stdout,
        executionFailureStderr: runResult.stderr,
      };
    }

    if (runResult.exitCode !== 0) {
      return {
        kind: "execution-failed",
        executionFailureMessage: "Tool expansion worker exited with code " + runResult.exitCode + ".",
        executionFailureRunReason: "Tool expansion worker exited with a non-zero code.",
        executionFailureExitCode: runResult.exitCode,
        executionFailureStdout: runResult.stdout,
        executionFailureStderr: runResult.stderr,
        forceRetryableFailure: true,
      };
    }

    const subitemLines = parseUncheckedTodoLines(runResult.stdout);
    if (subitemLines.length > 0) {
      const updatedSource = insertSubitems(source, task, subitemLines, {
        dedupeWithExisting: true,
      });
      dependencies.fileSystem.writeText(task.file, updatedSource);
      emit({
        kind: "info",
        message: "Inserted " + subitemLines.length + " "
          + pluralize(subitemLines.length, "tool-generated child TODO item", "tool-generated child TODO items")
          + ".",
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
  emit({ kind: "info", message: resolvedWorkerCommand.join(" ") + " [" + mode + "]" });
  const executePhaseTrace = traceRunSession.beginPhase("execute", resolvedWorkerCommand);
  traceRunSession.emitPromptMetrics(prompt, expandedContextBefore, "execute.md");
  const runResult = await dependencies.workerExecutor.runWorker({
    workerPattern: selectedWorkerPattern,
    prompt,
    mode,
    trace,
    cwd,
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
  if (runResult.exitCode === null) {
    return {
      kind: "execution-failed",
      executionFailureMessage: "Worker execution was interrupted before completion.",
      executionFailureRunReason: "Worker execution was interrupted.",
      executionFailureExitCode: null,
      executionFailureStdout: runResult.stdout,
      executionFailureStderr: runResult.stderr,
    };
  }

  if (runResult.exitCode !== 0) {
    return {
      kind: "execution-failed",
      executionFailureMessage: "Worker exited with code " + runResult.exitCode + ".",
      executionFailureRunReason: "Worker exited with a non-zero code.",
      executionFailureExitCode: runResult.exitCode,
      executionFailureStdout: runResult.stdout,
      executionFailureStderr: runResult.stderr,
      forceRetryableFailure: true,
    };
  }

  if (isMemoryCaptureTask) {
    const persistenceResult = persistMemoryCaptureOutput({
      sourcePath: task.file,
      taskText: task.text,
      taskLine: task.line,
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
        forceRetryableFailure: true,
      };
    }
  }

  // Success path returns verification options for downstream completion flow.
  return {
    kind: "ready-for-completion",
    shouldVerify,
    executionStdout: shouldVerify ? runResult.stdout : undefined,
    executionOutputCaptured: shouldVerify ? mode === "wait" : undefined,
    cliExecutionOptionsForVerification: cliExecutionOptionsWithVerificationTemplateFailureAbortAndTrace,
    verificationFailureMessage: "Verification failed after all repair attempts. Task not checked.",
    verificationFailureRunReason: "Verification failed after all repair attempts.",
  };
}

function resolveInlineCliCommand(task: Task): string {
  const command = task.cliCommand?.trim() ?? "";
  const directiveCliArgs = task.directiveCliArgs?.trim();
  if (!directiveCliArgs) {
    return command;
  }

  if (command.endsWith(directiveCliArgs)) {
    return command;
  }

  return [command, directiveCliArgs].filter(Boolean).join(" ");
}

function formatInlineCliFailureStreamOutput(streamName: "stdout" | "stderr", output: string): string {
  if (output.length <= INLINE_CLI_FAILURE_STREAM_MAX_CHARS) {
    return output;
  }

  const retainedCharacterCount = INLINE_CLI_FAILURE_STREAM_HEAD_CHARS + INLINE_CLI_FAILURE_STREAM_TAIL_CHARS;
  const omittedCharacterCount = Math.max(0, output.length - retainedCharacterCount);
  const header = "[Inline CLI " + streamName + " truncated: showing first "
    + INLINE_CLI_FAILURE_STREAM_HEAD_CHARS
    + " and last "
    + INLINE_CLI_FAILURE_STREAM_TAIL_CHARS
    + " characters (omitted "
    + omittedCharacterCount
    + ").]";
  const head = output.slice(0, INLINE_CLI_FAILURE_STREAM_HEAD_CHARS);
  const tail = output.slice(-INLINE_CLI_FAILURE_STREAM_TAIL_CHARS);
  const separator = "[... omitted " + omittedCharacterCount + " characters ...]";

  return [header, head, separator, tail].join("\n");
}

function runIncludedFile(params: {
  dependencies: RunTaskDependencies;
  task: Task;
  childFile: string;
  artifactContext: ArtifactRunContext;
  keepArtifacts: boolean;
  executionEnv?: Record<string, string>;
  selectedWorkerCommand: string[];
  showAgentOutput: boolean;
  ignoreCliBlock: boolean;
  verify: boolean;
  noRepair: boolean;
  repairAttempts: number;
  emitExecutionWorkerOutput: (stdout: string, stderr: string) => void;
}): Promise<
  | { ok: true }
  | {
    ok: false;
    message: string;
    reason: string;
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
  }
> {
  const {
    dependencies,
    task,
    childFile,
    artifactContext,
    keepArtifacts,
    executionEnv,
    selectedWorkerCommand,
    showAgentOutput,
    ignoreCliBlock,
    verify,
    noRepair,
    repairAttempts,
    emitExecutionWorkerOutput,
  } = params;

  return (async () => {
    const resolvedCurrentFile = dependencies.pathOperations.resolve(task.file);
    const resolvedIncludedFile = dependencies.pathOperations.resolve(childFile);
    const currentFile = normalizeIncludePath(resolvedCurrentFile);
    const includedFile = normalizeIncludePath(resolvedIncludedFile);
    const includeStack = parseIncludeStack(executionEnv?.[INCLUDE_STACK_ENV] ?? process.env[INCLUDE_STACK_ENV]);

    if (includedFile === currentFile) {
      return {
        ok: false as const,
        message: "Include cycle detected: task includes itself (" + task.file + ").",
        reason: "Include cycle detected (direct self-include).",
        exitCode: 1,
      };
    }

    if (includeStack.includes(currentFile)) {
      const cyclePath = [...includeStack, currentFile]
        .map((entry) => entry.replaceAll("\\", "/"))
        .join(" -> ");
      return {
        ok: false as const,
        message: "Include cycle detected: " + cyclePath,
        reason: "Include cycle detected (indirect recursion).",
        exitCode: 1,
      };
    }

    if (includeStack.includes(includedFile)) {
      const cyclePath = [...includeStack, currentFile, includedFile]
        .map((entry) => entry.replaceAll("\\", "/"))
        .join(" -> ");
      return {
        ok: false as const,
        message: "Include cycle detected: " + cyclePath,
        reason: "Include cycle detected (indirect recursion).",
        exitCode: 1,
      };
    }

    const nestedIncludeStack = [...includeStack, currentFile];
    const nestedExecutionEnv: Record<string, string> = {
      ...(executionEnv ?? {}),
      [INCLUDE_STACK_ENV]: JSON.stringify(nestedIncludeStack),
    };

    const clonedIncludedFile = cloneIncludedFileToArtifacts({
      dependencies,
      includedFilePath: resolvedIncludedFile,
      artifactContext,
    });

    const includeRunResult = await dependencies.workerExecutor.executeRundownTask(
      "run",
      [clonedIncludedFile, "--all"],
      dependencies.workingDirectory.cwd(),
      {
        env: nestedExecutionEnv,
        artifactContext,
        keepArtifacts,
        artifactExtra: {
          taskType: "include",
          includeSource: currentFile,
          includeTarget: includedFile,
        },
        parentWorkerCommand: selectedWorkerCommand,
        parentKeepArtifacts: keepArtifacts,
        parentShowAgentOutput: showAgentOutput,
        parentIgnoreCliBlock: ignoreCliBlock,
        parentVerify: verify,
        parentNoRepair: noRepair,
        parentRepairAttempts: repairAttempts,
      },
    );

    emitExecutionWorkerOutput(includeRunResult.stdout, includeRunResult.stderr);

    if (includeRunResult.exitCode === null) {
      return {
        ok: false as const,
        message: "Included file execution was interrupted before completion: " + includedFile,
        reason: "Included file execution was interrupted.",
        exitCode: null,
        stdout: includeRunResult.stdout,
        stderr: includeRunResult.stderr,
      };
    }

    if (includeRunResult.exitCode !== 0) {
      return {
        ok: false as const,
        message: "Included file execution failed with code " + includeRunResult.exitCode + ": " + includedFile,
        reason: "Included file execution failed.",
        exitCode: includeRunResult.exitCode,
        stdout: includeRunResult.stdout,
        stderr: includeRunResult.stderr,
      };
    }

    return { ok: true as const };
  })();
}

function cloneIncludedFileToArtifacts(params: {
  dependencies: RunTaskDependencies;
  includedFilePath: string;
  artifactContext: ArtifactRunContext;
}): string {
  const { dependencies, includedFilePath, artifactContext } = params;
  const includesDir = dependencies.pathOperations.join(artifactContext.rootDir, "includes");
  dependencies.fileSystem.mkdir(includesDir, { recursive: true });

  const sanitizedFileName = includedFilePath
    .replaceAll("\\", "_")
    .replaceAll("/", "_")
    .replaceAll(":", "_");
  const clonedFilePath = dependencies.pathOperations.join(includesDir, sanitizedFileName);
  const sourceContent = dependencies.fileSystem.readText(includedFilePath);
  dependencies.fileSystem.writeText(clonedFilePath, sourceContent);

  return clonedFilePath;
}

function parseIncludeStack(raw: string | undefined): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => normalizeIncludePath(entry));
  } catch {
    return [];
  }
}

function normalizeIncludePath(filePath: string): string {
  return filePath.replaceAll("/", "\\").toLowerCase();
}

function persistMemoryCaptureOutput(params: {
  sourcePath: string;
  taskText: string;
  taskLine: number;
  workerOutput: string;
  memoryCapturePrefix?: "memory" | "memorize" | "remember" | "inventory";
  dependencies: RunTaskDependencies;
  emit: EmitFn;
}): { ok: true } | { ok: false; message: string; reason: string } {
  const { sourcePath, taskText, taskLine, workerOutput, memoryCapturePrefix, dependencies, emit } = params;
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
    originTask: {
      text: taskText,
      line: taskLine,
    },
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
