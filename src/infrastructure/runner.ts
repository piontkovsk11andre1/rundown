/**
 * Runner - executes an external command with the rendered prompt.
 *
 * Supports three execution modes:
 * - wait:     spawn the command and block until it exits
 * - tui:      spawn the command with inherited stdio (interactive)
 * - detached: spawn the command and return immediately
 *
 * Supports two prompt transport mechanisms:
 * - file: write prompt to a .md-todo runtime file and append the path as an argument
 * - arg:  append the prompt text directly as a trailing argument
 */

import os from "node:os";
import path from "node:path";
import spawn from "cross-spawn";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  finalizeRuntimeArtifacts,
  type RuntimeArtifactsContext,
  type RuntimePhase,
} from "./runtime-artifacts.js";

export type RunnerMode = "wait" | "tui" | "detached";
export type PromptTransport = "file" | "arg";

export interface RunnerOptions {
  /** The command and its base arguments (everything after --). */
  command: string[];
  /** The rendered prompt to deliver to the command. */
  prompt: string;
  /** Execution mode. Default: "wait". */
  mode?: RunnerMode;
  /** How to pass the prompt. Default: "file". */
  transport?: PromptTransport;
  /** Working directory for the command. */
  cwd?: string;
  /** Optional shared runtime artifact context. */
  artifactContext?: RuntimeArtifactsContext;
  /** The phase name for persisted runtime artifacts. */
  artifactPhase?: RuntimePhase;
  /** Extra metadata to attach to the artifact phase. */
  artifactExtra?: Record<string, unknown>;
  /** Preserve artifacts after completion. */
  keepArtifacts?: boolean;
}

export interface RunnerResult {
  /** Exit code of the process (null if detached or killed). */
  exitCode: number | null;
  /** Captured stdout (wait mode only). */
  stdout: string;
  /** Captured stderr (wait mode only). */
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
    prompt: options.prompt,
    command: options.command,
    mode,
    transport,
    notes: buildCaptureNotes(mode),
    extra: options.artifactExtra,
  });

  const transportPromptFile = transport === "file" ? phase.promptFile : null;
  const args = buildWorkerArgs(options.command, options.prompt, transport, transportPromptFile, cwd);

  const [cmd, ...cmdArgs] = args;

  if (!cmd) {
    throw new Error("No command specified after --");
  }

  try {
    const result = await executeCommand(cmd, cmdArgs, mode, cwd);
    completeRuntimePhase(phase, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputCaptured: mode === "wait",
    });
    return result;
  } catch (error) {
    completeRuntimePhase(phase, {
      exitCode: null,
      outputCaptured: mode === "wait",
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
): string[] {
  if (command.length === 0) {
    return [];
  }

  if (isOpenCodeCommand(command[0])) {
    return buildOpenCodeArgs(command, prompt, promptFile, cwd);
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
): string[] {
  const [cmd, ...rest] = command;

  if (rest[0] === "run") {
    const args = [cmd, ...rest];

    if (promptFile) {
      args.push(buildOpenCodeRunBootstrapPrompt());
      args.push("--file", promptFile);
      return args;
    }

    args.push(prompt);
    return args;
  }

  if (promptFile) {
    return [cmd, ...rest, buildOpenCodeTuiPromptArg(buildOpenCodeTuiBootstrapPrompt(promptFile, cwd))];
  }

  return [cmd, ...rest, buildOpenCodeTuiPromptArg(prompt)];
}

function buildOpenCodeRunBootstrapPrompt(): string {
  return "Read the attached Markdown file first. It contains the full task instructions and context for this run.";
}

function buildOpenCodeTuiBootstrapPrompt(tempFile: string, cwd: string): string {
  const displayPath = path.relative(cwd, tempFile) || path.basename(tempFile);
  const normalizedPath = displayPath.split(path.sep).join("/");

  return `The full rendered md-todo task prompt is staged in ${normalizedPath}. Open and read that file completely before taking any action, then continue the work in this session.`;
}

function buildOpenCodeTuiPromptArg(prompt: string): string {
  return `--prompt=${prompt}`;
}

function executeCommand(
  cmd: string,
  args: string[],
  mode: RunnerMode,
  cwd: string,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    if (mode === "tui") {
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

function buildCaptureNotes(mode: RunnerMode): string | undefined {
  if (mode === "wait") {
    return undefined;
  }

  if (mode === "tui") {
    return "Interactive TUI mode does not capture worker stdout/stderr transcripts.";
  }

  return "Detached mode does not capture worker stdout/stderr and leaves runtime artifacts in place.";
}
