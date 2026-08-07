import { createCliBlockExecutedEvent } from "./trace.js";
import type {
  ApplicationOutputPort,
  CommandExecutionOptions,
  TraceWriterPort,
} from "./ports/index.js";

interface CommandExecutionDetails {
  command: string;
  exitCode: number | null;
  stdoutLength: number;
  stderrLength: number;
  durationMs: number;
}

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

export function mapTemplateCliFailureToExitCode(error: unknown): number | null {
  if (!(error instanceof TemplateCliBlockExecutionError)) {
    return null;
  }

  return 1;
}

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

export function withCliTrace(
  executionOptions: CommandExecutionOptions | undefined,
  traceWriter: TraceWriterPort,
  cliTraceRunId: string | undefined,
  nowIso: () => string,
): CommandExecutionOptions | undefined {
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

export async function handleTemplateCliFailure(
  error: unknown,
  emit: ApplicationOutputPort["emit"],
  onFailureHook: () => Promise<void>,
  failRun: (failureMessage: string) => Promise<number>,
): Promise<number | null> {
  if (mapTemplateCliFailureToExitCode(error) === null) {
    return null;
  }

  const templateCliError = error as TemplateCliBlockExecutionError;

  const exitCodeLabel = templateCliError.exitCode === null ? "unknown" : String(templateCliError.exitCode);
  emit({
    kind: "error",
    message: "`cli` fenced command failed in "
      + templateCliError.templateLabel
      + " (exit "
      + exitCodeLabel
      + "): "
      + templateCliError.command
      + ". Aborting run.",
  });
  await onFailureHook();
  return await failRun("`cli` fenced command failed in " + templateCliError.templateLabel + ": " + templateCliError.command);
}