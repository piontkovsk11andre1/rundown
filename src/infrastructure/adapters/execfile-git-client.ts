import { execFile } from "node:child_process";
import type { GitClient } from "../../domain/ports/git-client.js";

export function createExecFileGitClient(): GitClient {
  return {
    run(args, cwd, options) {
      return runGit(args, cwd, options?.timeoutMs);
    },
  };
}

function runGit(args: string[], cwd: string, timeoutMs: number = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const message = stderr?.trim() || stdout?.trim() || error.message;
        reject(new Error(`git ${args[0]}: ${message}`));
        return;
      }

      resolve(stdout.trim());
    });
  });
}
