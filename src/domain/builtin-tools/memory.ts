import type { ToolHandlerFn } from "../ports/tool-handler-port.js";
import type { ProcessRunMode } from "../ports/process-runner.js";
import type { MemoryWriterPort } from "../ports/memory-writer-port.js";
import type { ApplicationOutputPort } from "../ports/output-port.js";
import type { Task } from "../parser.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

function resolveMemoryCapturePrefixFromTaskText(taskText: string):
  | "memory"
  | "memorize"
  | "remember"
  | "inventory"
  | undefined {
  const match = taskText.trim().match(/^(memory|memorize|remember|inventory)\s*:/i);
  if (!match || !match[1]) {
    return undefined;
  }

  const normalized = match[1].toLowerCase();
  if (
    normalized === "memory"
    || normalized === "memorize"
    || normalized === "remember"
    || normalized === "inventory"
  ) {
    return normalized;
  }

  return undefined;
}

function resolveMemoryCapturePrefixFromTaskContext(task: Task, source: string):
  | "memory"
  | "memorize"
  | "remember"
  | "inventory"
  | undefined {
  const sourceLines = source.split(/\r?\n/);
  const sourceLine = sourceLines[task.line - 1] ?? "";
  const sourceMatch = sourceLine.match(/^\s*[-*+]\s*\[[ xX]\]\s*(.*)$/);
  const sourceTaskText = sourceMatch?.[1]?.trim() ?? "";
  const sourcePrefix = resolveMemoryCapturePrefixFromTaskText(sourceTaskText);
  if (sourcePrefix) {
    return sourcePrefix;
  }

  return resolveMemoryCapturePrefixFromTaskText(task.text);
}

export function persistMemoryCaptureOutput(params: {
  sourcePath: string;
  taskText: string;
  taskLine: number;
  workerOutput: string;
  memoryCapturePrefix?: "memory" | "memorize" | "remember" | "inventory";
  memoryWriter?: MemoryWriterPort;
  emit: EmitFn;
}): { ok: true } | { ok: false; message: string; reason: string } {
  const {
    sourcePath,
    taskText,
    taskLine,
    workerOutput,
    memoryCapturePrefix,
    memoryWriter,
    emit,
  } = params;

  const normalizedOutput = workerOutput.trim();
  if (normalizedOutput.length === 0) {
    return {
      ok: false,
      message: "Memory capture worker returned empty output; nothing to persist.",
      reason: "Memory capture worker returned empty output.",
    };
  }

  if (!memoryWriter) {
    return {
      ok: false,
      message: "Memory capture requires a configured memory writer.",
      reason: "Memory writer is not configured.",
    };
  }

  const writeResult = memoryWriter.write({
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
      emit({ kind: "warn", message: writeResult.error.warningMessage });
    }

    return {
      ok: false,
      message: writeResult.error.message,
      reason: writeResult.error.reason,
    };
  }

  if (writeResult.value.warningMessage) {
    emit({ kind: "warn", message: writeResult.value.warningMessage });
  }

  return { ok: true };
}

/**
 * Creates a built-in memory-capture handler.
 *
 * Executes the worker, then persists the output via the memory writer port.
 * Returns `shouldVerify: true` so the standard verification pipeline continues.
 */
export function createMemoryHandler(memoryWriter?: MemoryWriterPort): ToolHandlerFn {
  return async (context) => {
    const runResult = await context.workerExecutor.runWorker({
      workerPattern: context.workerPattern,
      prompt: context.payload,
      mode: context.mode as ProcessRunMode,
      trace: context.trace,
      cwd: context.cwd,
      env: context.executionEnv,
      configDir: context.configDir,
      artifactContext: context.artifactContext,
      artifactPhase: "execute",
    });

    if (context.showAgentOutput) {
      if (runResult.stdout) {
        context.emit({ kind: "text", text: runResult.stdout });
      }
      if (runResult.stderr) {
        context.emit({ kind: "stderr", text: runResult.stderr });
      }
    }

    if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
      return {
        exitCode: runResult.exitCode,
        failureMessage: "Memory capture worker exited with code " + runResult.exitCode + ".",
        failureReason: "Memory capture worker exited with a non-zero code.",
      };
    }

    const persistenceResult = persistMemoryCaptureOutput({
      sourcePath: context.task.file,
      taskText: context.task.text,
      taskLine: context.task.line,
      workerOutput: runResult.stdout,
      memoryCapturePrefix: resolveMemoryCapturePrefixFromTaskContext(context.task, context.source),
      memoryWriter,
      emit: context.emit,
    });

    if (!persistenceResult.ok) {
      return {
        exitCode: 1,
        failureMessage: persistenceResult.message,
        failureReason: persistenceResult.reason,
      };
    }

    return {
      skipExecution: true,
      shouldVerify: true,
    };
  };
}
