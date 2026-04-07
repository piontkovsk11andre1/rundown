import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type {
  FileSystem,
  FileLock,
  PathOperationsPort,
} from "../domain/ports/index.js";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import { formatNoItemsFoundFor } from "./run-task-utils.js";

/**
 * Dependencies required to resolve paths, inspect lock state, and emit user-facing messages
 * while performing manual lock release.
 */
export interface UnlockTaskDependencies {
  fileLock: FileLock;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  output: ApplicationOutputPort;
}

/**
 * Input options for the unlock operation.
 */
export interface UnlockTaskOptions {
  // Source file path whose associated lockfile should be released.
  source: string;
}

/**
 * Creates the unlock-task application action.
 *
 * The returned function validates that a lockfile exists, prevents unlocking an actively held
 * runtime lock, and force-releases only stale lock state.
 */
export function createUnlockTask(
  dependencies: UnlockTaskDependencies,
): (options: UnlockTaskOptions) => Promise<number> {
  // Reuse a bound emitter for concise status reporting across return paths.
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function unlockTask(options: UnlockTaskOptions): Promise<number> {
    // Resolve the incoming source path to an absolute canonical path.
    const sourcePath = dependencies.pathOperations.resolve(options.source);
    // Build the expected lockfile location under the per-project config directory.
    const sourceDirectory = dependencies.pathOperations.dirname(sourcePath);
    const sourceName = basenameFromPath(sourcePath);
    const lockPath = dependencies.pathOperations.join(sourceDirectory, CONFIG_DIR_NAME, `${sourceName}.lock`);

    // Nothing to unlock when no lockfile exists for this source.
    if (!dependencies.fileSystem.exists(lockPath)) {
      emit({ kind: "info", message: formatNoItemsFoundFor("source lock", sourcePath) });
      return 3;
    }

    // Refuse manual unlock when another active process currently owns the lock.
    if (dependencies.fileLock.isLocked(sourcePath)) {
      emit({
        kind: "error",
        message: "Source lock is currently held by a running process and cannot be manually released: " + sourcePath,
      });
      return 1;
    }

    // Lockfile exists but is not actively held, so treat it as stale and release it.
    dependencies.fileLock.forceRelease(sourcePath);
    emit({ kind: "success", message: "Released stale source lock: " + sourcePath });
    return 0;
  };
}

/**
 * Returns the final path segment for either POSIX or Windows-style separators.
 */
function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[/\\]+/);
  return parts[parts.length - 1] ?? filePath;
}
