import type { WorkerHealthEntry } from "../worker-health.js";

export interface WorkerHealthSnapshot {
  schemaVersion: number;
  updatedAt: string;
  entries: WorkerHealthEntry[];
}

/**
 * Persistence contract for runtime worker health state.
 */
export interface WorkerHealthStore {
  /** Loads persisted worker health, returning an empty snapshot on missing/corrupt data. */
  read(configDirOrCwd?: string): WorkerHealthSnapshot;
  /** Persists worker health state with the current schema version. */
  write(snapshot: WorkerHealthSnapshot, configDirOrCwd?: string): void;
  /**
   * Atomically updates worker health by applying a read-modify-write transform
   * against the latest persisted snapshot.
   */
  update?(
    updater: (snapshot: WorkerHealthSnapshot) => WorkerHealthSnapshot,
    configDirOrCwd?: string,
  ): WorkerHealthSnapshot;
  /**
   * Atomically removes a single entry by key, preserving schemaVersion and
   * file-lock semantics. Returns the refreshed snapshot. No-op when the key
   * is unknown.
   */
  removeEntry?(key: string, configDirOrCwd?: string): WorkerHealthSnapshot;
  /** Returns the absolute file path used for persistence. */
  filePath(configDirOrCwd?: string): string;
}
