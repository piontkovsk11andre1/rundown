/**
 * Runner - executes an external command with the rendered prompt.
 *
 * Supports three execution modes:
 * - wait:     spawn the command and block until it exits
 * - tui:      spawn the command with inherited stdio (interactive)
 * - detached: spawn the command and return immediately
 *
 * Prompt content is always staged in a runtime file and worker arguments are
 * derived from parsed worker-pattern substitutions.
 */

import path from "node:path";
import spawn from "cross-spawn";
import { expandWorkerPattern } from "../domain/worker-pattern.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type { ProcessRunMode as RunnerMode } from "../domain/ports/index.js";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  finalizeRuntimeArtifacts,
  type RuntimeArtifactsContext,
  type RuntimePhase,
} from "./runtime-artifacts.js";

/** Re-exported runner mode type for infrastructure callers. */
export type { RunnerMode };

/**
 * Configuration for launching the worker process and tracking its runtime artifacts.
 */
export interface RunnerOptions {
  /** The command and its base arguments (everything after --). */
  command?: string[];
  /** Optional parsed worker pattern used to derive worker arguments. */
  workerPattern?: ParsedWorkerPattern;
  /** The rendered prompt to deliver to the command. */
  prompt: string;
  /** Execution mode. Default: "wait". */
  mode?: RunnerMode;
  /** Enable trace-aware runner behavior. */
  trace?: boolean;
  /** Capture stdout/stderr even for interactive runs. */
  captureOutput?: boolean;
  /** Working directory for the command. */
  cwd?: string;
  /** Additional environment variables for the worker process. */
  env?: Record<string, string>;
  /** Resolved .rundown directory for runtime artifacts. */
  configDir?: string;
  /** Optional shared runtime artifact context. */
  artifactContext?: RuntimeArtifactsContext;
  /** The phase name for persisted runtime artifacts. */
  artifactPhase?: RuntimePhase;
  /** Optional custom phase label used in artifact directory naming. */
  artifactPhaseLabel?: string;
  /** Extra metadata to attach to the artifact phase. */
  artifactExtra?: Record<string, unknown>;
  /** Preserve artifacts after completion. */
  keepArtifacts?: boolean;
}

/**
 * Normalized process result returned by the runner across all execution modes.
 */
export interface RunnerResult {
  /** Exit code of the process (null if detached or killed). */
  exitCode: number | null;
  /** Captured stdout (wait mode and optional tui capture). */
  stdout: string;
  /** Captured stderr (wait mode and optional tui capture). */
  stderr: string;
}

/**
 * Run the worker command with the rendered prompt.
 */
export async function runWorker(options: RunnerOptions): Promise<RunnerResult> {
  const mode = options.mode ?? "wait";
  const cwd = options.cwd ?? process.cwd();
  const configDir = options.configDir;
  const baseCommand = options.workerPattern?.command ?? options.command ?? [];
  let ownedArtifactContext: RuntimeArtifactsContext | null = null;
  let artifactContext: RuntimeArtifactsContext;

  // Reuse caller-managed artifact context when supplied.
  if (options.artifactContext) {
    artifactContext = options.artifactContext;
  } else {
    // Otherwise create and own a context for this invocation.
    ownedArtifactContext = createRuntimeArtifactsContext({
      cwd,
      configDir,
      commandName: "worker",
      workerCommand: baseCommand,
      mode,
      transport: "pattern",
      keepArtifacts: options.keepArtifacts ?? false,
    });
    artifactContext = ownedArtifactContext;
  }

  // Start a phase record before execution so prompt/command metadata is always persisted.
  const phase = beginRuntimePhase(artifactContext, {
    phase: options.artifactPhase ?? "worker",
    phaseLabel: options.artifactPhaseLabel,
    prompt: options.prompt,
    command: baseCommand,
    mode,
    transport: "pattern",
    notes: buildCaptureNotes(mode, options.captureOutput ?? false),
    extra: options.artifactExtra,
  });

  // The prompt file is always created and available for worker argument expansion.
  const transportPromptFile = phase.promptFile;
  const args = buildWorkerArgs(
    options.workerPattern,
    baseCommand,
    transportPromptFile,
    cwd,
  );

  const [cmd, ...cmdArgs] = args;

  if (!cmd) {
    throw new Error("No command specified after --");
  }

  try {
    const result = await executeCommand(
      cmd,
      cmdArgs,
      mode,
      cwd,
      options.captureOutput ?? false,
      options.env,
    );
    const outputCaptured = options.captureOutput ?? mode === "wait";
    completeRuntimePhase(phase, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputCaptured,
    });
    return result;
  } catch (error) {
    const outputCaptured = options.captureOutput ?? mode === "wait";
    completeRuntimePhase(phase, {
      exitCode: null,
      outputCaptured,
      notes: error instanceof Error ? error.message : String(error),
      extra: { error: true },
    });
    throw error;
  } finally {
    // Finalize only contexts created by this function; shared contexts are finalized by the caller.
    if (ownedArtifactContext) {
      finalizeRuntimeArtifacts(ownedArtifactContext, {
        status: mode === "detached" ? "detached" : "completed",
        preserve: (options.keepArtifacts ?? false) || mode === "detached",
      });
    }
  }
}

/**
 * Build the final worker command line by expanding worker pattern placeholders.
 */
function buildWorkerArgs(
  workerPattern: ParsedWorkerPattern | undefined,
  command: string[],
  promptFile: string | null,
  cwd: string,
): string[] {
  if (command.length === 0) {
    return [];
  }

  if (!promptFile) {
    throw new Error("Prompt file was not created for worker execution.");
  }

  const parsed = workerPattern ?? {
    command,
    usesBootstrap: command.some((token) => token.includes("$bootstrap")),
    usesFile: command.some((token) => token.includes("$file")),
    appendFile: !command.some((token) => token.includes("$bootstrap") || token.includes("$file")),
  };

  return expandWorkerPattern(parsed, buildBootstrapPrompt(promptFile, cwd), promptFile);
}

/**
 * Build a universal bootstrap prompt that points the worker to the staged prompt file.
 */
export function buildBootstrapPrompt(promptFilePath: string, cwd: string): string {
  const displayPath = path.relative(cwd, promptFilePath) || path.basename(promptFilePath);
  const normalizedPath = displayPath.split(path.sep).join("/");

  return `Read the task prompt file at ${normalizedPath} and follow the instructions.`;
}

/**
 * Spawn and monitor the worker process according to the selected run mode.
 */
function executeCommand(
  cmd: string,
  args: string[],
  mode: RunnerMode,
  cwd: string,
  captureOutput: boolean,
  env?: Record<string, string>,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    if (mode === "tui") {
      if (captureOutput) {
        const child = spawn(cmd, args, {
          stdio: ["inherit", "pipe", "pipe"],
          cwd,
          shell: false,
          env: env ? { ...process.env, ...env } : process.env,
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout.push(chunk);
          mirrorWorkerChunkToTerminal("stdout", chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.push(chunk);
          mirrorWorkerChunkToTerminal("stderr", chunk);
        });

        child.on("close", (code: number | null) => {
          resolve({
            exitCode: code,
            stdout: Buffer.concat(stdout).toString("utf-8"),
            stderr: Buffer.concat(stderr).toString("utf-8"),
          });
        });
        child.on("error", reject);
        return;
      }

      // Inherit all stdio (interactive in same terminal)
      const child = spawn(cmd, args, {
        stdio: "inherit",
        cwd,
        shell: false,
        env: env ? { ...process.env, ...env } : process.env,
      });

      child.on("close", (code: number | null) => {
        resolve({ exitCode: code, stdout: "", stderr: "" });
      });
      child.on("error", reject);
      return;
    }

    if (mode === "detached") {
      const child = spawn(cmd, args, {
        stdio: "ignore",
        cwd,
        shell: false,
        detached: true,
        env: env ? { ...process.env, ...env } : process.env,
      });
      child.unref();
      resolve({ exitCode: null, stdout: "", stderr: "" });
      return;
    }

    // wait mode: capture output
    const child = spawn(cmd, args, {
      stdio: ["inherit", "pipe", "pipe"],
      cwd,
      shell: false,
      env: env ? { ...process.env, ...env } : process.env,
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    child.on("close", (code: number | null) => {
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });

    child.on("error", reject);
  });
}

/**
 * Generate a concise artifact note describing stdout/stderr capture behavior for non-wait modes.
 */
function buildCaptureNotes(mode: RunnerMode, captureOutput: boolean): string | undefined {
  if (mode === "wait") {
    return undefined;
  }

  if (mode === "tui") {
    if (captureOutput) {
      return "Interactive TUI mode captures worker stdout/stderr transcripts while mirroring raw stream bytes to the terminal.";
    }

    return "Interactive TUI mode does not capture worker stdout/stderr transcripts.";
  }

  return "Detached mode does not capture worker stdout/stderr and leaves runtime artifacts in place.";
}

/**
 * Mirrors captured TUI stream chunks to the parent terminal without formatting.
 *
 * This bypass is intentional: show-agent-output in interactive mode should
 * preserve raw worker rendering (ANSI escapes, carriage returns, and partial
 * line updates) instead of routing through the structured output port.
 */
function mirrorWorkerChunkToTerminal(stream: "stdout" | "stderr", chunk: Buffer): void {
  if (stream === "stdout") {
    process.stdout.write(chunk);
    return;
  }

  process.stderr.write(chunk);
}
