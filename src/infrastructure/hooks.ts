/**
 * Post-completion hooks.
 *
 * Runs a user-supplied command after a task has been successfully completed
 * and checked. Task metadata is passed as environment variables so the hook
 * can perform arbitrary actions (git push, notify, log, etc.).
 *
 * Environment variables set for the hook command:
 *   RUNDOWN_TASK    — The task text
 *   RUNDOWN_FILE    — Absolute path to the Markdown file
 *   RUNDOWN_LINE    — 1-based line number of the task
 *   RUNDOWN_INDEX   — Zero-based task index
 *   RUNDOWN_SOURCE  — The original source argument passed to rundown
 */

import { execFile } from "node:child_process";
import path from "node:path";

export interface HookTaskInfo {
  /** The task text. */
  task: string;
  /** Absolute path to the Markdown file. */
  file: string;
  /** 1-based line number. */
  line: number;
  /** Zero-based task index. */
  index: number;
}

export interface OnCompleteHookOptions {
  /** The shell command to run. */
  command: string;
  /** Task metadata. */
  taskInfo: HookTaskInfo;
  /** The original source argument. */
  source: string;
  /** Working directory. */
  cwd: string;
}

export interface HookResult {
  /** Whether the hook exited successfully (code 0). */
  success: boolean;
  /** The exit code. */
  exitCode: number | null;
  /** Captured stdout. */
  stdout: string;
  /** Captured stderr. */
  stderr: string;
}

/**
 * Run the on-complete hook command with task metadata as environment variables.
 *
 * The command is executed in a shell. Returns the result rather than throwing,
 * so the caller can decide whether to warn or fail.
 */
export async function runOnCompleteHook(options: OnCompleteHookOptions): Promise<HookResult> {
  const { command, taskInfo, source, cwd } = options;

  const env: Record<string, string> = {
    ...process.env,
    RUNDOWN_TASK: taskInfo.task,
    RUNDOWN_FILE: path.resolve(taskInfo.file),
    RUNDOWN_LINE: String(taskInfo.line),
    RUNDOWN_INDEX: String(taskInfo.index),
    RUNDOWN_SOURCE: source,
  };

  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "cmd" : "/bin/sh";
    const shellFlag = process.platform === "win32" ? "/c" : "-c";

    execFile(shell, [shellFlag, command], { cwd, env, timeout: 60_000 }, (error, stdout, stderr) => {
      if (error && "code" in error && typeof error.code === "number") {
        resolve({
          success: false,
          exitCode: error.code,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
        return;
      }

      if (error) {
        const errCode = (error as NodeJS.ErrnoException & { code?: number | string }).code;
        const numericCode = typeof errCode === "number" ? errCode : null;
        resolve({
          success: false,
          exitCode: numericCode,
          stdout: stdout ?? "",
          stderr: stderr ?? error.message,
        });
        return;
      }

      resolve({
        success: true,
        exitCode: 0,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}
