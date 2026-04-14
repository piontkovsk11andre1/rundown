// Reuse the domain worker-configuration model as the port return type.
import type {
  WorkerConfig,
  WorkerConfigLoadWithSourcesResult,
  WorkerConfigPathsResult,
  WorkerConfigReadableScope,
  WorkerConfigSetValueInput,
  WorkerConfigUnsetValueInput,
  WorkerConfigMutationResult,
} from "../worker-config.js";

/**
 * Defines the domain contract for loading persisted worker configuration.
 */
export interface WorkerConfigPort {
  // Resolve the persisted worker configuration for a specific config directory.
  /**
   * Loads worker configuration from the provided configuration directory.
   *
   * Returns `undefined` when no valid worker configuration is available.
   */
  load(configDir: string): WorkerConfig | undefined;
  loadWithSources?(configDir: string): WorkerConfigLoadWithSourcesResult;
  readValue?(configDir: string, scope: WorkerConfigReadableScope, keyPath: string): unknown;
  listValues?(configDir: string, scope: WorkerConfigReadableScope): WorkerConfig | undefined;
  getConfigPaths?(configDir: string): WorkerConfigPathsResult;
  setValue?(configDir: string, input: WorkerConfigSetValueInput): WorkerConfigMutationResult;
  unsetValue?(configDir: string, input: WorkerConfigUnsetValueInput): WorkerConfigMutationResult;
}
