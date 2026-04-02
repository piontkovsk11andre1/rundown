import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS,
  type CommandExecutionOptions,
  type CommandExecutor,
  type CommandResult,
} from "../domain/ports/command-executor.js";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  type RuntimeArtifactsContext,
  type RuntimePhaseHandle,
} from "./runtime-artifacts.js";

/**
 * Creates a command executor that runs commands through the host shell and
 * waits for completion.
 *
 * The executor captures stdout/stderr, enforces optional timeouts, and writes
 * runtime phase artifacts when artifact context is provided.
 */
export function createCliBlockExecutor(): CommandExecutor {
  return {
    execute(
      command: string,
      cwd: string,
      options?: CommandExecutionOptions,
    ): Promise<CommandResult> {
      return new Promise((resolve, reject) => {
        // Start artifact phase tracking when runtime context is available.
        const phaseHandle = beginCliCommandPhase(command, options);
        const child = spawn(command, {
          stdio: ["inherit", "pipe", "pipe"],
          cwd,
          // `shell: true` uses the host default shell (`/bin/sh` on Unix,
          // `process.env.ComSpec`/`cmd.exe` on Windows).
          shell: true,
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let timedOut = false;

        // Normalize timeout to a non-negative integer before scheduling it.
        const configuredTimeout = options?.timeoutMs;
        const effectiveTimeoutMs = typeof configuredTimeout === "number"
          ? configuredTimeout
          : DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS;
        const timeoutMs = effectiveTimeoutMs > 0 ? Math.floor(effectiveTimeoutMs) : 0;
        const timeoutHandle = timeoutMs > 0
          ? setTimeout(() => {
            timedOut = true;
            // Use SIGTERM first to allow graceful shutdown on timeout.
            child.kill("SIGTERM");
          }, timeoutMs)
          : null;

        // Accumulate output chunks so we can return full stream content.
        child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

        child.on("close", (exitCode) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          if (timedOut) {
            // Include a clear timeout message in stderr for callers and logs.
            const timedOutStderr = Buffer.concat(stderr).toString("utf-8");
            const timeoutMessage = `Command timed out after ${timeoutMs}ms.`;
            const stderrWithTimeout = timedOutStderr.length > 0
              ? `${timedOutStderr}${timedOutStderr.endsWith("\n") ? "" : "\n"}${timeoutMessage}`
              : timeoutMessage;
            const stdoutText = Buffer.concat(stdout).toString("utf-8");

            completeCliCommandPhase(phaseHandle, {
              exitCode: 124,
              stdout: stdoutText,
              stderr: stderrWithTimeout,
            });
            writeCliCommandOutputArtifacts(phaseHandle, options, stdoutText, stderrWithTimeout);
            resolve({
              exitCode: 124,
              stdout: stdoutText,
              stderr: stderrWithTimeout,
            });
            return;
          }

          const stdoutText = Buffer.concat(stdout).toString("utf-8");
          const stderrText = Buffer.concat(stderr).toString("utf-8");

          // Persist completion metadata before resolving the result.
          completeCliCommandPhase(phaseHandle, {
            exitCode,
            stdout: stdoutText,
            stderr: stderrText,
          });
          writeCliCommandOutputArtifacts(phaseHandle, options, stdoutText, stderrText);
          resolve({
            exitCode,
            stdout: stdoutText,
            stderr: stderrText,
          });
        });

        child.on("error", (error) => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle);
          }

          // Record failure in artifacts, then surface the original process error.
          completeRuntimePhaseSafely(phaseHandle, {
            exitCode: null,
            outputCaptured: true,
            notes: error.message,
            extra: { error: true },
          });
          reject(error);
        });
      });
    },
  };
}

/**
 * Begins runtime phase tracking for a CLI block command when artifacts are enabled.
 */
function beginCliCommandPhase(
  command: string,
  options: CommandExecutionOptions | undefined,
): RuntimePhaseHandle | null {
  // Ignore invalid contexts so command execution remains unaffected.
  const artifactContext = resolveArtifactContext(options?.artifactContext);
  if (!artifactContext) {
    return null;
  }

  return beginRuntimePhase(artifactContext, {
    phase: options?.artifactPhase ?? "worker",
    phaseLabel: options?.artifactPhaseLabel,
    command: [command],
    mode: "wait",
    transport: "cli-block",
    extra: {
      cliBlockCommand: command,
      ...(options?.artifactExtra ?? {}),
    },
  });
}

/**
 * Completes a CLI command runtime phase with captured command output.
 */
function completeCliCommandPhase(
  phaseHandle: RuntimePhaseHandle | null,
  result: CommandResult,
): void {
  completeRuntimePhaseSafely(phaseHandle, {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    outputCaptured: true,
  });
}

/**
 * Completes a runtime phase only when a valid phase handle exists.
 */
function completeRuntimePhaseSafely(
  phaseHandle: RuntimePhaseHandle | null,
  options: {
    exitCode: number | null;
    stdout?: string;
    stderr?: string;
    outputCaptured: boolean;
    notes?: string;
    extra?: Record<string, unknown>;
  },
): void {
  if (!phaseHandle) {
    return;
  }

  completeRuntimePhase(phaseHandle, options);
}

/**
 * Validates unknown input and returns a typed runtime artifact context.
 */
function resolveArtifactContext(input: unknown): RuntimeArtifactsContext | null {
  if (!input || typeof input !== "object") {
    return null;
  }

  const candidate = input as Partial<RuntimeArtifactsContext>;
  if (typeof candidate.runId !== "string" || typeof candidate.rootDir !== "string") {
    return null;
  }

  return candidate as RuntimeArtifactsContext;
}

/**
 * Writes stdout and stderr command output files for the CLI block phase.
 */
function writeCliCommandOutputArtifacts(
  phaseHandle: RuntimePhaseHandle | null,
  options: CommandExecutionOptions | undefined,
  stdout: string,
  stderr: string,
): void {
  if (!phaseHandle) {
    return;
  }

  // Keep ordinal values deterministic to avoid unstable artifact filenames.
  const commandOrdinal = normalizeCommandOrdinal(options?.artifactCommandOrdinal);
  const stdoutFileName = `cli-block-${commandOrdinal}-stdout.txt`;
  const stderrFileName = `cli-block-${commandOrdinal}-stderr.txt`;

  fs.writeFileSync(path.join(phaseHandle.dir, stdoutFileName), stdout, "utf-8");
  fs.writeFileSync(path.join(phaseHandle.dir, stderrFileName), stderr, "utf-8");
}

/**
 * Normalizes the command ordinal used in CLI block artifact filenames.
 */
function normalizeCommandOrdinal(ordinal: number | undefined): number {
  if (typeof ordinal !== "number") {
    return 1;
  }

  if (!Number.isFinite(ordinal) || ordinal < 1) {
    return 1;
  }

  return Math.floor(ordinal);
}
