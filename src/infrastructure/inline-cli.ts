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

export interface InlineCliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Execute an inline CLI command from a task.
 *
 * The command is run through the system shell.
 */
export async function executeInlineCli(
  command: string,
  cwd: string = process.cwd(),
  options?: {
    artifactContext?: RuntimeArtifactsContext;
    keepArtifacts?: boolean;
    artifactExtra?: Record<string, unknown>;
  },
): Promise<InlineCliResult> {
  let ownedArtifactContext: RuntimeArtifactsContext | null = null;
  let artifactContext: RuntimeArtifactsContext;

  if (options?.artifactContext) {
    artifactContext = options.artifactContext;
  } else {
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
    const child = spawn(command, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd,
      shell: true,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("close", (code) => {
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
