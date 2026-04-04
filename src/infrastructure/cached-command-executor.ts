import type {
  CommandExecutionOptions,
  CommandExecutor,
  CommandResult,
} from "../domain/ports/command-executor.js";

/**
 * Creates a command executor decorator that memoizes results in memory.
 *
 * Cache keys are derived from `(command, cwd)`, so repeated executions of the
 * same command in the same directory return the cached `CommandResult`.
 */
export function createCachedCommandExecutor(delegate: CommandExecutor): CommandExecutor {
  const cache = new Map<string, CommandResult>();

  return {
    async execute(
      command: string,
      cwd: string,
      options?: CommandExecutionOptions,
    ): Promise<CommandResult> {
      const cacheKey = buildCacheKey(command, cwd);
      const cached = cache.get(cacheKey);
      if (cached) {
        return cloneResult(cached);
      }

      const result = await delegate.execute(command, cwd, options);
      cache.set(cacheKey, cloneResult(result));
      return cloneResult(result);
    },
  };
}

/**
 * Builds a stable cache key for command execution input.
 */
function buildCacheKey(command: string, cwd: string): string {
  return JSON.stringify([command, cwd]);
}

/**
 * Clones command results to prevent external mutation of cache entries.
 */
function cloneResult(result: CommandResult): CommandResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
