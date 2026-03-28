import path from "node:path";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { FileLock, FileSystem, PathOperationsPort } from "../domain/ports/index.js";

export interface UnlockTaskDependencies {
  fileLock: FileLock;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  output: ApplicationOutputPort;
}

export interface UnlockTaskOptions {
  source: string;
}

export function createUnlockTask(
  dependencies: UnlockTaskDependencies,
): (options: UnlockTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function unlockTask(options: UnlockTaskOptions): Promise<number> {
    const sourcePath = dependencies.pathOperations.resolve(options.source);
    const sourceDirectory = dependencies.pathOperations.dirname(sourcePath);
    const sourceName = path.basename(sourcePath);
    const lockPath = dependencies.pathOperations.join(sourceDirectory, ".rundown", `${sourceName}.lock`);

    if (!dependencies.fileSystem.exists(lockPath)) {
      emit({ kind: "info", message: "No lockfile found for source: " + sourcePath });
      return 3;
    }

    if (dependencies.fileLock.isLocked(sourcePath)) {
      emit({
        kind: "error",
        message: "Source lock is currently held by a running process and cannot be manually released: " + sourcePath,
      });
      return 1;
    }

    dependencies.fileLock.forceRelease(sourcePath);
    emit({ kind: "success", message: "Released stale source lock: " + sourcePath });
    return 0;
  };
}

export const unlockTask = createUnlockTask;
