import { createCliBlockExecutedEvent } from "../domain/trace.js";
import type {
  CommandExecutionOptions,
  TraceWriterPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

interface CommandExecutionDetails {
  command: string;
  exitCode: number | null;
  stdoutLength: number;
  stderrLength: number;
  durationMs: number;
}

/**
 * Error raised when a `cli` fenced block from a template fails.
 *
 * Carries template and command context so callers can emit a precise
 * diagnostic message and fail the run deterministically.
 */
export class TemplateCliBlockExecutionError extends Error {
  readonly templateLabel: string;
  readonly command: string;
  readonly exitCode: number | null;

  constructor(templateLabel: string, command: string, exitCode: number | null) {
    super("Template cli block execution failed");
    this.templateLabel = templateLabel;
    this.command = command;
    this.exitCode = exitCode;
  }
}

/**
 * Adds an `onCommandExecuted` callback while preserving an existing callback.
 *
 * The existing handler runs first, then the new handler, so callers can layer
 * behavior (for example trace logging, warnings, and failure policies).
 */
export function withCommandExecutionHandler(
  executionOptions: CommandExecutionOptions | undefined,
  handler: ((execution: CommandExecutionDetails) => void | Promise<void>) | undefined,
): CommandExecutionOptions | undefined {
  if (!handler) {
    return executionOptions;
  }

  const existingHandler = executionOptions?.onCommandExecuted;

  return {
    ...(executionOptions ?? {}),
    onCommandExecuted: async (execution): Promise<void> => {
      await existingHandler?.(execution);
      await handler(execution);
    },
  };
}

/**
 * Adds a trace writer hook that records CLI execution details for a run.
 *
 * When `cliTraceRunId` is not provided, tracing is left unchanged.
 */
export function withCliTrace(
  executionOptions: CommandExecutionOptions | undefined,
  traceWriter: TraceWriterPort,
  cliTraceRunId: string | undefined,
  nowIso: () => string,
): CommandExecutionOptions | undefined {
  // Build a trace handler only when CLI trace capture is enabled.
  const cliTraceExecutionHandler = cliTraceRunId
    ? (execution: CommandExecutionDetails): void => {
      traceWriter.write(createCliBlockExecutedEvent({
        timestamp: nowIso(),
        run_id: cliTraceRunId,
        payload: {
          command: execution.command,
          exit_code: execution.exitCode,
          stdout_length: execution.stdoutLength,
          stderr_length: execution.stderrLength,
          duration_ms: execution.durationMs,
        },
      }));
    }
    : undefined;

  return withCommandExecutionHandler(executionOptions, cliTraceExecutionHandler);
}

/**
 * Adds a warning policy for failed `cli` blocks originating from source markdown.
 *
 * Source markdown failures do not abort the run; execution continues with
 * captured command output so downstream steps can still proceed.
 */
export function withSourceCliFailureWarning(
  executionOptions: CommandExecutionOptions | undefined,
  emit: ApplicationOutputPort["emit"],
): CommandExecutionOptions | undefined {
  const sourceCliFailureWarningHandler = (execution: CommandExecutionDetails): void => {
    if (typeof execution.exitCode !== "number" || execution.exitCode === 0) {
      return;
    }

    emit({
      kind: "warn",
      message: "`cli` fenced command failed in source markdown (exit "
        + execution.exitCode
        + "): "
        + execution.command
        + ". Continuing with captured output.",
    });
  };

  return withCommandExecutionHandler(executionOptions, sourceCliFailureWarningHandler);
}

/**
 * Adds an abort policy for failed `cli` blocks originating from templates.
 *
 * Template failures are treated as fatal and converted into a structured error
 * that is handled by `handleTemplateCliFailure`.
 */
export function withTemplateCliFailureAbort(
  executionOptions: CommandExecutionOptions | undefined,
  templateLabel: string,
): CommandExecutionOptions | undefined {
  const templateCliFailureHandler = (execution: CommandExecutionDetails): void => {
    if (typeof execution.exitCode === "number" && execution.exitCode === 0) {
      return;
    }

    throw new TemplateCliBlockExecutionError(templateLabel, execution.command, execution.exitCode);
  };

  return withCommandExecutionHandler(executionOptions, templateCliFailureHandler);
}

/**
 * Handles template CLI failure errors and maps them into user-facing output.
 *
 * Returns `null` when the error is unrelated, otherwise emits diagnostics,
 * runs failure cleanup, and returns the run failure exit code.
 */
export async function handleTemplateCliFailure(
  error: unknown,
  emit: ApplicationOutputPort["emit"],
  onFailureHook: () => Promise<void>,
  failRun: (failureMessage: string) => Promise<number>,
): Promise<number | null> {
  if (!(error instanceof TemplateCliBlockExecutionError)) {
    return null;
  }

  const exitCodeLabel = error.exitCode === null ? "unknown" : String(error.exitCode);
  emit({
    kind: "error",
    message: "`cli` fenced command failed in "
      + error.templateLabel
      + " (exit "
      + exitCodeLabel
      + "): "
      + error.command
      + ". Aborting run.",
  });
  await onFailureHook();
  return await failRun("`cli` fenced command failed in " + error.templateLabel + ": " + error.command);
}
