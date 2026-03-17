/**
 * Inline CLI task executor.
 *
 * Handles tasks that begin with "cli: " by executing the command directly
 * in a shell, without going through an external worker.
 */

import { spawn } from "node:child_process";

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
): Promise<InlineCliResult> {
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
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout).toString("utf-8"),
        stderr: Buffer.concat(stderr).toString("utf-8"),
      });
    });

    child.on("error", reject);
  });
}
