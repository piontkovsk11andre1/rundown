import type {
  CommandExecutionOptions,
  CommandExecutor,
  CommandResult,
} from "../domain/ports/command-executor.js";

export interface CacheDecisionParams {
  command: string;
  cwd: string;
  options: CommandExecutionOptions | undefined;
  result: CommandResult;
}

export interface CachedCommandResultStore {
  get(command: string, cwd: string): CommandResult | null;
  set(command: string, cwd: string, result: CommandResult): void;
}

export function createCachedCommandResultStore(): CachedCommandResultStore {
  const cache = new Map<string, CommandResult>();
  return {
    get(command: string, cwd: string): CommandResult | null {
      const cached = cache.get(buildCacheKey(command, cwd));
      return cached ? cloneResult(cached) : null;
    },
    set(command: string, cwd: string, result: CommandResult): void {
      cache.set(buildCacheKey(command, cwd), cloneResult(result));
    },
  };
}

/**
 * Creates a command executor decorator that memoizes results in memory.
 *
 * Cache keys are derived from `(command, cwd)`, so repeated executions of the
 * same command in the same directory return a cached `CommandResult` clone.
 */
export function createCachedCommandExecutor(
  delegate: CommandExecutor,
  store: CachedCommandResultStore = createCachedCommandResultStore(),
  options?: {
    shouldCacheResult?: (params: CacheDecisionParams) => boolean;
  },
): CommandExecutor {
  const shouldCacheResult = options?.shouldCacheResult;

  return {
    async execute(
      command: string,
      cwd: string,
      options?: CommandExecutionOptions,
    ): Promise<CommandResult> {
      const cached = store.get(command, cwd);
      if (cached) {
        return cached;
      }

      const result = await delegate.execute(command, cwd, options);
      const canCache = shouldCacheResult
        ? shouldCacheResult({ command, cwd, options, result })
        : true;
      if (canCache) {
        store.set(command, cwd, result);
      }
      return cloneResult(result);
    },
  };
}

function buildCacheKey(command: string, cwd: string): string {
  return JSON.stringify([command, cwd]);
}

function cloneResult(result: CommandResult): CommandResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
