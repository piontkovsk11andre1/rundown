import { execFile } from "node:child_process";
import type { GitClient } from "../../domain/ports/git-client.js";

/**
 * Creates a `GitClient` implementation backed by the Node.js `execFile` API.
 *
 * The client executes `git` commands in a target working directory and delegates
 * command execution details to `runGit`.
 */
export function createExecFileGitClient(): GitClient {
  return {
    // Forward port calls to the shared git execution helper.
    run(args, cwd, options) {
      return runGit(args, cwd, options?.timeoutMs);
    },
  };
}

/**
 * Executes a `git` command and resolves with trimmed standard output.
 *
 * The process is constrained by the provided timeout and rejects with a
 * command-scoped error message that prioritizes stderr output for diagnostics.
 */
function runGit(args: string[], cwd: string, timeoutMs: number = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        // Prefer stderr when available to preserve the most actionable git failure detail.
        const message = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(`git ${args[0]}: ${message}`));
        return;
      }

      // Normalize trailing newlines so callers receive a clean command result.
      resolve(stdout.trim());
    });
  });
}
