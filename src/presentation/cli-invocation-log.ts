import { Command } from "commander";
import { createNodeFileSystem } from "../infrastructure/adapters/fs-file-system.js";
import { createGlobalOutputLogWriter } from "../infrastructure/adapters/global-output-log-writer.js";
import { globalOutputLogFilePath } from "../infrastructure/runtime-artifacts.js";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import type { ApplicationOutputEvent } from "../domain/ports/output-port.js";
import { withLoggedOutputContext, type LoggedOutputContext } from "./logged-output-port.js";
import type {
  CliInvocationLogState,
  CliInvocationMetadataDependencies,
  ResolveConfigDirForInvocation,
} from "./cli-invocation-types.js";
import path from "node:path";
import pc from "picocolors";

interface CreateCliInvocationLogStateDependencies extends CliInvocationMetadataDependencies {
  // Resolves config-dir metadata from invocation argv and cwd.
  resolveConfigDirForInvocation: ResolveConfigDirForInvocation;
}

type EmitOutputEvent = (event: ApplicationOutputEvent) => void;

/**
 * Creates per-invocation logging state for CLI execution.
 *
 * The returned state contains a global log writer bound to the resolved config directory
 * and immutable invocation metadata that is attached to all emitted log records.
 */
export function createCliInvocationLogState(
  argv: string[],
  {
    cliVersion,
    createSessionId,
    resolveInvocationCommand,
    resolveConfigDirForInvocation,
  }: CreateCliInvocationLogStateDependencies,
): CliInvocationLogState {
  // Copy argv so downstream logging metadata is not affected by external mutation.
  const invocationArgv = [...argv];
  // Capture invocation context once and reuse it for all log entries.
  const context: LoggedOutputContext = {
    command: resolveInvocationCommand(invocationArgv),
    argv: invocationArgv,
    cwd: process.cwd(),
    pid: process.pid,
    version: cliVersion,
    sessionId: createSessionId(),
  };
  // Resolve config directory for log file placement with a deterministic fallback.
  const resolvedConfigDir = resolveConfigDirPathForInvocation(
    invocationArgv,
    context.cwd,
    resolveConfigDirForInvocation,
  );

  return {
    // Persist logs in the global output file under the invocation config directory.
    writer: createGlobalOutputLogWriter(
      globalOutputLogFilePath(resolvedConfigDir),
      createNodeFileSystem(),
    ),
    context,
  };
}

/**
 * Resolves the config directory path used for invocation-level logging.
 *
 * Uses the configured resolver when it returns a value; otherwise falls back to
 * the default config directory under the invocation working directory.
 */
function resolveConfigDirPathForInvocation(
  argv: string[],
  cwd: string,
  resolveConfigDirForInvocation: ResolveConfigDirForInvocation,
): string {
  const resolvedConfigDir = resolveConfigDirForInvocation(argv, cwd)?.configDir;
  return resolvedConfigDir ?? path.join(cwd, CONFIG_DIR_NAME);
}

/**
 * Emits a user-visible fatal error and appends it to the invocation log when available.
 */
export function emitCliFatalError(
  error: unknown,
  state?: CliInvocationLogState,
  emitOutputEvent?: EmitOutputEvent,
): void {
  // Normalize unknown error values to a printable string.
  const message = String(error);
  void emitOutputEvent;

  // Preserve stable terminal fatal rendering across startup and runtime failures.
  console.error(pc.red("✖") + " " + message);
  // Mirror fatal errors into global logs for post-mortem diagnostics.
  appendCliFatalErrorToGlobalLog(message, state);
}

/**
 * Appends a fatal CLI error record to the global invocation log.
 *
 * Logging failures are intentionally swallowed to avoid masking the original fatal error.
 */
function appendCliFatalErrorToGlobalLog(message: string, state?: CliInvocationLogState): void {
  if (!state) {
    return;
  }

  try {
    // Persist a structured fatal log event with invocation metadata.
    state.writer.write(withLoggedOutputContext({
      ts: new Date().toISOString(),
      level: "error",
      stream: "stderr",
      kind: "cli-fatal",
      message,
    }, state.context));
  } catch {
    // best-effort logging: never interrupt command flow on log write failures
  }
}

/**
 * Configures Commander output writers to preserve normal terminal behavior and mirror output to logs.
 */
export function configureCommanderOutputHandlers(
  command: Command,
  getState: () => CliInvocationLogState | undefined,
): void {
  command.configureOutput({
    writeOut(output: string) {
      if (output.length === 0) {
        return;
      }

      // Preserve commander stdout behavior for all invocation phases.
      process.stdout.write(output);
      // Persist framework stdout output to the global invocation log using framework kind.
      appendCommanderFrameworkOutputToGlobalLog(output, "stdout", getState);
    },
    writeErr(output: string) {
      if (output.length === 0) {
        return;
      }

      // Preserve commander stderr behavior for all invocation phases.
      process.stderr.write(output);
      // Persist framework stderr output to the global invocation log using framework kind.
      appendCommanderFrameworkOutputToGlobalLog(output, "stderr", getState);
    },
  });
}

/**
 * Appends Commander framework output to the global invocation log.
 *
 * Empty messages and invocations without initialized log state are ignored.
 */
function appendCommanderFrameworkOutputToGlobalLog(
  message: string,
  stream: "stdout" | "stderr",
  getState: () => CliInvocationLogState | undefined,
): void {
  if (message.length === 0) {
    return;
  }

  const state = getState();
  if (!state) {
    return;
  }

  try {
    // Record the framework output with an inferred severity from stream type.
    state.writer.write(withLoggedOutputContext({
      ts: new Date().toISOString(),
      level: stream === "stderr" ? "error" : "info",
      stream,
      kind: "commander",
      message,
    }, state.context));
  } catch {
    // best-effort logging: never interrupt command flow on log write failures
  }
}
