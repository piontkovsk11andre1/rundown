import fs from "node:fs";
import path from "node:path";
import type { WorkerConfigPort } from "../../domain/ports/worker-config-port.js";
import type { WorkerConfig, WorkerProfile } from "../../domain/worker-config.js";

const WORKER_CONFIG_FILE_NAME = "config.json";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function validateWorkerProfile(value: unknown, keyPath: string): WorkerProfile {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const worker = value.worker;
  if (worker !== undefined && !isStringArray(worker)) {
    throw new Error(`Invalid worker config at ${keyPath}.worker: expected string array.`);
  }

  const workerArgs = value.workerArgs;
  if (workerArgs !== undefined && !isStringArray(workerArgs)) {
    throw new Error(`Invalid worker config at ${keyPath}.workerArgs: expected string array.`);
  }

  return {
    worker: worker === undefined ? undefined : [...worker],
    workerArgs: workerArgs === undefined ? undefined : [...workerArgs],
  };
}

function validateProfileMap(value: unknown, keyPath: string): Record<string, WorkerProfile> {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: Record<string, WorkerProfile> = {};
  for (const [key, profile] of Object.entries(value)) {
    result[key] = validateWorkerProfile(profile, `${keyPath}.${key}`);
  }

  return result;
}

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

export function createWorkerConfigAdapter(): WorkerConfigPort {
  return {
    load(configDir) {
      const configPath = path.join(configDir, WORKER_CONFIG_FILE_NAME);

      let parsed: unknown;
      try {
        const source = fs.readFileSync(configPath, "utf-8");
        parsed = JSON.parse(source);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return undefined;
        }

        if (error instanceof SyntaxError) {
          throw new Error(`Failed to parse worker config at \"${configPath}\": invalid JSON (${error.message}).`);
        }

        throw new Error(`Failed to read worker config at \"${configPath}\": ${String(error)}.`);
      }

      try {
        return validateWorkerConfig(parsed);
      } catch (error) {
        throw new Error(`Invalid worker config at \"${configPath}\": ${(error as Error).message}`);
      }
    },
  };
}
