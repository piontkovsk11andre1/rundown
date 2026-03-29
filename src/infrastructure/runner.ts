/**
 * Runner - executes an external command with the rendered prompt.
 *
 * Supports three execution modes:
 * - wait:     spawn the command and block until it exits
 * - tui:      spawn the command with inherited stdio (interactive)
 * - detached: spawn the command and return immediately
 *
 * Supports two prompt transport mechanisms:
 * - file: write prompt to a .rundown runtime file and append the path as an argument
 * - arg:  append the prompt text directly as a trailing argument
 */

import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";
import type {
  ProcessRunMode as RunnerMode,
  PromptTransport,
} from "../domain/ports/index.js";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  finalizeRuntimeArtifacts,
  type RuntimeArtifactsContext,
  type RuntimePhase,
} from "./runtime-artifacts.js";

export type { RunnerMode, PromptTransport };

export interface RunnerOptions {
  /** The command and its base arguments (everything after --). */
  command: string[];
  /** The rendered prompt to deliver to the command. */
  prompt: string;
  /** Execution mode. Default: "wait". */
  mode?: RunnerMode;
  /** How to pass the prompt. Default: "file". */
  transport?: PromptTransport;
  /** Enable trace-aware runner behavior. */
  trace?: boolean;
  /** Capture stdout/stderr even for interactive runs. */
  captureOutput?: boolean;
  /** Working directory for the command. */
  cwd?: string;
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
  const transport = options.transport ?? "file";
  const cwd = options.cwd ?? process.cwd();
  let ownedArtifactContext: RuntimeArtifactsContext | null = null;
  let artifactContext: RuntimeArtifactsContext;

  if (options.artifactContext) {
    artifactContext = options.artifactContext;
  } else {
    ownedArtifactContext = createRuntimeArtifactsContext({
      cwd,
      commandName: "worker",
      workerCommand: options.command,
      mode,
      transport,
      keepArtifacts: options.keepArtifacts ?? false,
    });
    artifactContext = ownedArtifactContext;
  }

  const phase = beginRuntimePhase(artifactContext, {
    phase: options.artifactPhase ?? "worker",
    phaseLabel: options.artifactPhaseLabel,
    prompt: options.prompt,
    command: options.command,
    mode,
    transport,
    notes: buildCaptureNotes(mode, options.captureOutput ?? false),
    extra: options.artifactExtra,
  });

  const transportPromptFile = transport === "file" ? phase.promptFile : null;
  const args = buildWorkerArgs(
    options.command,
    options.prompt,
    transport,
    transportPromptFile,
    cwd,
    options.trace ?? false,
  );

  const [cmd, ...cmdArgs] = args;

  if (!cmd) {
    throw new Error("No command specified after --");
  }

  try {
    const result = await executeCommand(cmd, cmdArgs, mode, cwd, options.captureOutput ?? false);
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
    if (ownedArtifactContext) {
      finalizeRuntimeArtifacts(ownedArtifactContext, {
        status: mode === "detached" ? "detached" : "completed",
        preserve: (options.keepArtifacts ?? false) || mode === "detached",
      });
    }
  }
}

function buildWorkerArgs(
  command: string[],
  prompt: string,
  transport: PromptTransport,
  promptFile: string | null,
  cwd: string,
  trace: boolean,
): string[] {
  if (command.length === 0) {
    return [];
  }

  if (isOpenCodeCommand(command[0])) {
    return buildOpenCodeArgs(command, prompt, promptFile, cwd, trace);
  }

  const args = [...command];
  if (transport === "file") {
    if (!promptFile) {
      throw new Error("Prompt file transport requested but no prompt file was created.");
    }
    args.push(promptFile);
  } else {
    args.push(prompt);
  }

  return args;
}

function isOpenCodeCommand(command: string): boolean {
  const normalized = path.basename(command).toLowerCase();
  return normalized === "opencode"
    || normalized === "opencode.cmd"
    || normalized === "opencode.exe"
    || normalized === "opencode.ps1";
}

function buildOpenCodeArgs(
  command: string[],
  prompt: string,
  promptFile: string | null,
  cwd: string,
  trace: boolean,
): string[] {
  const [cmd, ...rest] = command;
  const traceArgs = trace && !hasOpenCodeThinkingArg(rest) ? ["--thinking"] : [];

  if (rest[0] === "run") {
    const args = [cmd, ...rest, ...traceArgs];

    if (promptFile) {
      args.push(buildOpenCodeRunBootstrapPrompt());
      args.push("--file", promptFile);
      return args;
    }

    args.push(prompt);
    return args;
  }

  if (promptFile) {
    return [cmd, ...rest, ...traceArgs, buildOpenCodeTuiPromptArg(buildOpenCodeTuiBootstrapPrompt(promptFile, cwd))];
  }

  return [cmd, ...rest, ...traceArgs, buildOpenCodeTuiPromptArg(prompt)];
}

function hasOpenCodeThinkingArg(args: string[]): boolean {
  return args.some((arg) => arg === "--thinking" || arg.startsWith("--thinking="));
}

function buildOpenCodeRunBootstrapPrompt(): string {
  return "Read the attached Markdown file first. It contains the full task instructions and context for this run.";
}

function buildOpenCodeTuiBootstrapPrompt(tempFile: string, cwd: string): string {
  const displayPath = path.relative(cwd, tempFile) || path.basename(tempFile);
  const normalizedPath = displayPath.split(path.sep).join("/");

  return `The full rendered rundown task prompt is staged in ${normalizedPath}. Open and read that file completely before taking any action, then continue the work in this session.`;
}

function buildOpenCodeTuiPromptArg(prompt: string): string {
  return `--prompt=${prompt}`;
}

function executeCommand(
  cmd: string,
  args: string[],
  mode: RunnerMode,
  cwd: string,
  captureOutput: boolean,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    if (mode === "tui") {
      if (captureOutput) {
        const child = spawn(cmd, args, {
          stdio: ["inherit", "pipe", "pipe"],
          cwd,
          shell: false,
        });

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout.push(chunk);
          process.stdout.write(chunk);
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr.push(chunk);
          process.stderr.write(chunk);
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

      // On Windows, launch TUI in a new terminal window to avoid
      // input-buffer issues with the parent console.
      if (os.platform() === "win32") {
        const child = spawn(
          "cmd",
          ["/c", "start", "/wait", '""', cmd, ...args],
          { stdio: "ignore", cwd, shell: false },
        );
        child.on("close", (code: number | null) => {
          resolve({ exitCode: code, stdout: "", stderr: "" });
        });
        child.on("error", reject);
        return;
      }

      // Non-Windows: inherit all stdio (interactive in same terminal)
      const child = spawn(cmd, args, {
        stdio: "inherit",
        cwd,
        shell: false,
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

function buildCaptureNotes(mode: RunnerMode, captureOutput: boolean): string | undefined {
  if (mode === "wait") {
    return undefined;
  }

  if (mode === "tui") {
    if (captureOutput) {
      return "Interactive TUI mode captures and mirrors worker stdout/stderr transcripts.";
    }

    return "Interactive TUI mode does not capture worker stdout/stderr transcripts.";
  }

  return "Detached mode does not capture worker stdout/stderr and leaves runtime artifacts in place.";
}
