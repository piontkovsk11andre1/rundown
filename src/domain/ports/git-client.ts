/**
 * Defines the domain port for executing Git commands.
 */
// Abstracts Git process invocation behind a domain-facing contract.
export interface GitClient {
  /**
   * Runs a Git command in the provided working directory.
   *
   * @param args Command arguments to pass to the Git executable.
   * @param cwd Absolute or relative working directory for the command.
   * @param options Optional execution settings, such as timeout.
   * @returns Command standard output as a string.
   */
  // Returns stdout and lets adapter layers decide stderr/log handling.
  run(args: string[], cwd: string, options?: { timeoutMs?: number }): Promise<string>;
}
