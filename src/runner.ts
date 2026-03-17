/**
 * Runner – executes an external command with the rendered prompt.
 *
 * Supports three execution modes:
 * - wait:     spawn the command and block until it exits
 * - tui:      spawn the command with inherited stdio (interactive)
 * - detached: spawn the command and return immediately
 *
 * Supports two prompt transport mechanisms:
 * - file: write prompt to a temp .md file and append the path as an argument
 * - arg:  append the prompt text directly as a trailing argument
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import spawn from "cross-spawn";

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
  const isOpenCode = isOpenCodeCommand(options.command[0] ?? "");
  const useWorkspacePromptFile = transport === "file"
    && mode === "tui"
    && isOpenCode;
  const useShell = process.platform === "win32"
    && mode === "tui"
    && isOpenCode;

  let tempFile: string | null = null;

  if (transport === "file") {
    tempFile = writeTempPrompt(options.prompt, cwd, useWorkspacePromptFile);
  }

  const args = buildWorkerArgs(options.command, options.prompt, transport, tempFile, cwd);

  const [cmd, ...cmdArgs] = args;

  if (!cmd) {
    throw new Error("No command specified after --");
  }

  try {
    const result = await executeCommand(cmd, cmdArgs, mode, cwd, useShell);
    return result;
  } finally {
    // Clean up temp file after execution (not for detached)
    if (tempFile && mode !== "detached") {
      cleanupTemp(tempFile);
    }
  }
}

function buildWorkerArgs(
  command: string[],
  prompt: string,
  transport: PromptTransport,
  tempFile: string | null,
  cwd: string,
): string[] {
  if (command.length === 0) {
    return [];
  }

  if (isOpenCodeCommand(command[0])) {
    return buildOpenCodeArgs(command, prompt, tempFile, cwd);
  }

  const args = [...command];
  if (transport === "file") {
    if (!tempFile) {
      throw new Error("Prompt file transport requested but no temp file was created.");
    }
    args.push(tempFile);
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
  tempFile: string | null,
  cwd: string,
): string[] {
  const [cmd, ...rest] = command;

  if (rest[0] === "run") {
    const args = [cmd, ...rest];

    if (tempFile) {
      args.push(buildOpenCodeRunBootstrapPrompt());
      args.push("--file", tempFile);
      return args;
    }

    args.push(prompt);
    return args;
  }

  if (tempFile) {
    return [cmd, ...rest, "--prompt", buildOpenCodeTuiBootstrapPrompt(tempFile, cwd)];
  }

  return [cmd, ...rest, "--prompt", prompt];
}

function buildOpenCodeRunBootstrapPrompt(): string {
  return "Read the attached Markdown file first. It contains the full task instructions and context for this run.";
}

function buildOpenCodeTuiBootstrapPrompt(tempFile: string, cwd: string): string {
  const displayPath = path.relative(cwd, tempFile) || path.basename(tempFile);
  const normalizedPath = displayPath.split(path.sep).join("/");

  return `Read and follow the full task instructions in ${normalizedPath}. Start by opening that file, then continue the work from there.`;
}

function executeCommand(
  cmd: string,
  args: string[],
  mode: RunnerMode,
  cwd: string,
  useShell: boolean,
): Promise<RunnerResult> {
  return new Promise((resolve, reject) => {
    if (mode === "tui") {
      // Interactive: inherit all stdio
      const child = spawn(cmd, args, {
        stdio: "inherit",
        cwd,
        shell: useShell,
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

function writeTempPrompt(
  prompt: string,
  cwd?: string,
  useWorkspacePromptFile: boolean = false,
): string {
  const dir = useWorkspacePromptFile && cwd
    ? path.join(cwd, ".md-todo", "runtime")
    : path.join(os.tmpdir(), "md-todo");
  fs.mkdirSync(dir, { recursive: true });
  const id = randomBytes(8).toString("hex");
  const file = path.join(dir, `prompt-${id}.md`);
  fs.writeFileSync(file, prompt, "utf-8");
  return file;
}

function cleanupTemp(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // Ignore cleanup failures
  }
}
