import type { ApplicationOutputPort, WorkerHealthStore } from "../domain/ports/index.js";
import type { ConfigDirResult } from "../domain/ports/config-dir-port.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";

export interface ResetWorkerHealthDependencies {
  workerHealthStore: WorkerHealthStore;
  configDir: ConfigDirResult | undefined;
  output: ApplicationOutputPort;
}

export interface ResetWorkerHealthOptions {
  /** Health entry key as persisted (e.g. `worker:["opencode"]` or `profile:default`). */
  key?: string;
  /** When true, clear every persisted worker-health entry. */
  all?: boolean;
  /** When true, emit a JSON payload describing the post-reset snapshot. */
  json?: boolean;
}

interface ResetWorkerHealthPayload {
  removedKey?: string;
  removed: boolean;
  removedCount: number;
  filePath: string;
  configDir?: string;
  generatedAt: string;
}

/**
 * Atomically removes worker-health entries through the {@link WorkerHealthStore}
 * port, preserving schemaVersion and file-lock semantics. Single-entry reset
 * returns success even when the key is unknown so callers can treat reset as
 * idempotent.
 */
export function createResetWorkerHealthEntry(
  dependencies: ResetWorkerHealthDependencies,
): (options: ResetWorkerHealthOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return (options: ResetWorkerHealthOptions): number => {
    const key = typeof options?.key === "string" ? options.key : "";
    const resetAll = options.all === true;
    if (!resetAll && key.length === 0) {
      emit({ kind: "text", text: "reset-worker-health: missing entry key" });
      return EXIT_CODE_FAILURE;
    }

    const configDirPath = dependencies.configDir?.configDir;
    const baseDir = configDirPath ?? process.cwd();

    if (!resetAll && typeof dependencies.workerHealthStore.removeEntry !== "function") {
      emit({ kind: "text", text: "reset-worker-health: store does not support removeEntry" });
      return EXIT_CODE_FAILURE;
    }

    const before = dependencies.workerHealthStore.read(baseDir);
    const existed = before.entries.some((entry) => entry.key === key);

    const snapshot = resetAll
      ? resetAllEntries(dependencies.workerHealthStore, before, baseDir)
      : dependencies.workerHealthStore.removeEntry!(key, baseDir);
    const removedCount = resetAll ? before.entries.length : (existed ? 1 : 0);

    const payload: ResetWorkerHealthPayload = {
      ...(resetAll ? {} : { removedKey: key }),
      removed: resetAll ? removedCount > 0 : existed,
      removedCount,
      filePath: dependencies.workerHealthStore.filePath(baseDir),
      generatedAt: snapshot.updatedAt,
      ...(configDirPath ? { configDir: configDirPath } : {}),
    };

    if (options.json) {
      emit({ kind: "text", text: JSON.stringify(payload, null, 2) });
      return EXIT_CODE_SUCCESS;
    }

    emit({
      kind: "text",
      text: resetAll
        ? `Reset worker-health entries: ${removedCount}`
        : (existed
          ? `Reset worker-health entry: ${key}`
          : `No worker-health entry found for key: ${key}`),
    });
    emit({ kind: "text", text: "  store: " + payload.filePath });
    if (payload.configDir) {
      emit({ kind: "text", text: "  configDir: " + payload.configDir });
    }
    emit({ kind: "text", text: "  generatedAt: " + payload.generatedAt });

    return EXIT_CODE_SUCCESS;
  };
}

function resetAllEntries(
  workerHealthStore: WorkerHealthStore,
  before: ReturnType<WorkerHealthStore["read"]>,
  baseDir: string,
): ReturnType<WorkerHealthStore["read"]> {
  const updatedAt = new Date().toISOString();

  if (typeof workerHealthStore.update === "function") {
    return workerHealthStore.update((snapshot) => ({
      schemaVersion: snapshot.schemaVersion,
      updatedAt,
      entries: [],
    }), baseDir);
  }

  const next = {
    schemaVersion: before.schemaVersion,
    updatedAt,
    entries: [],
  };
  workerHealthStore.write(next, baseDir);
  return next;
}
