import fs from "node:fs";
import path from "node:path";
import type { WorkerConfigPort } from "../../domain/ports/worker-config-port.js";
import type { WorkerConfig, WorkerProfile } from "../../domain/worker-config.js";

const WORKER_CONFIG_FILE_NAME = "config.json";

/**
 * Determines whether a value is a non-null, non-array object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Determines whether a value is an array composed entirely of strings.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Validates and normalizes a worker profile object from parsed JSON input.
 *
 * The function enforces shape expectations and returns cloned arrays so callers
 * receive immutable snapshots of the parsed configuration sections.
 */
function validateWorkerProfile(value: unknown, keyPath: string): WorkerProfile {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  // Validate the optional worker executable command parts.
  const worker = value.worker;
  if (worker !== undefined && !isStringArray(worker)) {
    throw new Error(`Invalid worker config at ${keyPath}.worker: expected string array.`);
  }

  // Validate the optional worker argument list.
  const workerArgs = value.workerArgs;
  if (workerArgs !== undefined && !isStringArray(workerArgs)) {
    throw new Error(`Invalid worker config at ${keyPath}.workerArgs: expected string array.`);
  }

  // Clone arrays to avoid returning references to raw parsed objects.
  return {
    worker: worker === undefined ? undefined : [...worker],
    workerArgs: workerArgs === undefined ? undefined : [...workerArgs],
  };
}

/**
 * Validates a map of worker profiles keyed by command or profile name.
 */
function validateProfileMap(value: unknown, keyPath: string): Record<string, WorkerProfile> {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: Record<string, WorkerProfile> = {};
  // Validate each nested profile with a fully qualified path for clear errors.
  for (const [key, profile] of Object.entries(value)) {
    result[key] = validateWorkerProfile(profile, `${keyPath}.${key}`);
  }

  return result;
}

/**
 * Validates the top-level worker configuration document.
 */
function validateWorkerConfig(value: unknown): WorkerConfig {
  if (!isPlainObject(value)) {
    throw new Error("Invalid worker config: expected top-level JSON object.");
  }

  const defaults = value.defaults;
  const commands = value.commands;
  const profiles = value.profiles;

  return {
    defaults: defaults === undefined ? undefined : validateWorkerProfile(defaults, "defaults"),
    commands: commands === undefined ? undefined : validateProfileMap(commands, "commands"),
    profiles: profiles === undefined ? undefined : validateProfileMap(profiles, "profiles"),
  };
}

/**
 * Creates the worker configuration adapter that loads and validates config
 * values from `<configDir>/config.json`.
 */
export function createWorkerConfigAdapter(): WorkerConfigPort {
  return {
    /**
     * Loads worker configuration from disk.
     *
     * Returns `undefined` when the configuration file does not exist.
     */
    load(configDir) {
      const configPath = path.join(configDir, WORKER_CONFIG_FILE_NAME);

      let parsed: unknown;
      try {
        const source = fs.readFileSync(configPath, "utf-8");
        parsed = JSON.parse(source);
      } catch (error) {
        // Missing config is allowed and treated as an optional file.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }

        // Surface malformed JSON with a targeted parse error.
        if (error instanceof SyntaxError) {
          throw new Error(`Failed to parse worker config at \"${configPath}\": invalid JSON (${error.message}).`);
        }

        // Preserve any unexpected I/O failure details.
        throw new Error(`Failed to read worker config at \"${configPath}\": ${String(error)}.`);
      }

      try {
        return validateWorkerConfig(parsed);
      } catch (error) {
        // Prefix validation failures with the source path for traceability.
        throw new Error(`Invalid worker config at \"${configPath}\": ${(error as Error).message}`);
      }
    },
  };
}
