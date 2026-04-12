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
  /** Returns the absolute file path used for persistence. */
  filePath(configDirOrCwd?: string): string;
}
