/**
 * Inline CLI task executor.
 *
 * Handles tasks that begin with "cli: " by executing the command directly
 * in a shell, without going through an external worker.
 */

import { spawn } from "node:child_process";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  finalizeRuntimeArtifacts,
  type RuntimeArtifactsContext,
} from "./runtime-artifacts.js";

/**
 * Result payload produced by an inline CLI execution.
 */
export interface InlineCliResult {
  /** Exit code reported by the child process, or null when unavailable. */
  exitCode: number | null;
  /** UTF-8 decoded stdout captured from the child process. */
  stdout: string;
  /** UTF-8 decoded stderr captured from the child process. */
  stderr: string;
}

/**
 * Optional runtime controls for inline CLI execution.
 */
interface ExecuteInlineCliOptions {
  /** Reuse an existing artifact context instead of creating one locally. */
  artifactContext?: RuntimeArtifactsContext;
  /** Preserve generated artifacts after execution completes. */
  keepArtifacts?: boolean;
  /** Attach additional metadata to runtime phase artifacts. */
  artifactExtra?: Record<string, unknown>;
}

/**
 * Executes a task-scoped CLI command through the system shell.
 *
 * Captures stdout/stderr, tracks runtime artifact phases, and finalizes
 * owned artifact contexts based on process completion status.
 *
 * @param command Shell command string to execute.
 * @param cwd Working directory used for shell execution.
 * @param options Optional artifact and metadata controls for execution.
 * @returns Captured process result including exit code and output streams.
 */
export async function executeInlineCli(
  command: string,
  cwd: string = process.cwd(),
  options?: ExecuteInlineCliOptions,
): Promise<InlineCliResult> {
  // Track whether this function owns lifecycle cleanup for artifacts.
  let ownedArtifactContext: RuntimeArtifactsContext | null = null;
  let artifactContext: RuntimeArtifactsContext;

  if (options?.artifactContext) {
    // Reuse caller-provided artifact context when available.
    artifactContext = options.artifactContext;
  } else {
    // Create an isolated context for this inline CLI execution.
    ownedArtifactContext = createRuntimeArtifactsContext({
      cwd,
      commandName: "inline-cli",
      workerCommand: [command],
      mode: "wait",
      transport: "inline-cli",
      keepArtifacts: options?.keepArtifacts ?? false,
    });
    artifactContext = ownedArtifactContext;
  }

  const phase = beginRuntimePhase(artifactContext, {
    phase: "inline-cli",
    command: [command],
    mode: "wait",
    transport: "inline-cli",
    extra: options?.artifactExtra,
  });

  return new Promise((resolve, reject) => {
    // Spawn through the shell to support full command-string syntax.
    const child = spawn(command, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd,
      shell: true,
    });

    // Collect raw buffers to preserve stream ordering and encoding safety.
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("close", (code) => {
      // Normalize buffered streams into UTF-8 strings for consumers.
      const result = {
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      };

      completeRuntimePhase(phase, {
        exitCode: code,
        stdout: result.stdout,
        stderr: result.stderr,
        outputCaptured: true,
      });

      if (ownedArtifactContext) {
        finalizeRuntimeArtifacts(ownedArtifactContext, {
          status: code === 0 ? "completed" : "failed",
          preserve: options?.keepArtifacts ?? false,
        });
      }

      resolve(result);
    });

    child.on("error", (error) => {
      // Record spawn/runtime errors in artifacts before surfacing failure.
      completeRuntimePhase(phase, {
        exitCode: null,
        outputCaptured: true,
        notes: error.message,
        extra: { error: true },
      });

      if (ownedArtifactContext) {
        finalizeRuntimeArtifacts(ownedArtifactContext, {
          status: "failed",
          preserve: options?.keepArtifacts ?? false,
        });
      }

      reject(error);
    });
  });
}
