export interface GitClient {
  run(args: string[], cwd: string, options?: { timeoutMs?: number }): Promise<string>;
}
