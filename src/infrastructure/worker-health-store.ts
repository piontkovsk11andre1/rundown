import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import type { WorkerHealthSnapshot } from "../domain/ports/worker-health-store.js";
import {
  normalizeWorkerHealthKey,
  WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER,
  WORKER_FAILURE_CLASS_SUCCESS,
  WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
  WORKER_FAILURE_CLASS_USAGE_LIMIT,
  WORKER_HEALTH_STATUS_COOLING_DOWN,
  WORKER_HEALTH_STATUS_HEALTHY,
  WORKER_HEALTH_STATUS_UNAVAILABLE,
  type WorkerHealthEntry,
  type WorkerHealthSource,
} from "../domain/worker-health.js";

const WORKER_HEALTH_FILE_NAME = "worker-health.json";
const CURRENT_WORKER_HEALTH_SCHEMA_VERSION = 1;

/**
 * Returns the absolute path to the persisted worker health store file.
 */
export function workerHealthStoreFilePath(configDirOrCwd: string = process.cwd()): string {
  return path.join(resolveRuntimeConfigDir(configDirOrCwd), WORKER_HEALTH_FILE_NAME);
}

/**
 * Reads persisted worker health and returns an empty snapshot on missing/corrupt data.
 */
export function readWorkerHealthSnapshot(configDirOrCwd: string = process.cwd()): WorkerHealthSnapshot {
  const filePath = workerHealthStoreFilePath(configDirOrCwd);

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  } catch {
    return createEmptySnapshot();
  }

  return normalizeSnapshot(raw);
}

/**
 * Persists worker health with atomic file replacement semantics.
 */
export function writeWorkerHealthSnapshot(
  snapshot: WorkerHealthSnapshot,
  configDirOrCwd: string = process.cwd(),
): void {
  const filePath = workerHealthStoreFilePath(configDirOrCwd);
  const normalized = normalizeSnapshotForWrite(snapshot);
  const payload: WorkerHealthSnapshot = {
    schemaVersion: CURRENT_WORKER_HEALTH_SCHEMA_VERSION,
    updatedAt: normalized.updatedAt,
    entries: normalized.entries,
  };
  writeJsonAtomic(filePath, payload);
}

/**
 * Atomically applies a read-modify-write update to worker health.
 */
export function updateWorkerHealthSnapshot(
  updater: (snapshot: WorkerHealthSnapshot) => WorkerHealthSnapshot,
  configDirOrCwd: string = process.cwd(),
): WorkerHealthSnapshot {
  const filePath = workerHealthStoreFilePath(configDirOrCwd);
  const lockPath = `${filePath}.lock`;

  return withFileLock(lockPath, () => {
    const currentSnapshot = readWorkerHealthSnapshot(configDirOrCwd);
    const updatedSnapshot = normalizeSnapshotForWrite(updater(currentSnapshot));
    const payload: WorkerHealthSnapshot = {
      schemaVersion: CURRENT_WORKER_HEALTH_SCHEMA_VERSION,
      updatedAt: updatedSnapshot.updatedAt,
      entries: updatedSnapshot.entries,
    };
    writeJsonAtomic(filePath, payload);
    return payload;
  });
}

function normalizeSnapshotForWrite(value: unknown): WorkerHealthSnapshot {
  if (!isRecord(value)) {
    return createEmptySnapshot();
  }

  const entriesRaw = Array.isArray(value.entries) ? value.entries : [];
  const entries = entriesRaw
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is WorkerHealthEntry => entry !== null);

  return {
    schemaVersion: CURRENT_WORKER_HEALTH_SCHEMA_VERSION,
    updatedAt: normalizeIsoString(value.updatedAt),
    entries,
  };
}

function normalizeSnapshot(value: unknown): WorkerHealthSnapshot {
  if (!isRecord(value)) {
    return createEmptySnapshot();
  }

  if (value.schemaVersion !== CURRENT_WORKER_HEALTH_SCHEMA_VERSION) {
    return createEmptySnapshot();
  }

  const entriesRaw = Array.isArray(value.entries) ? value.entries : [];
  const entries = entriesRaw
    .map((entry) => normalizeEntry(entry))
    .filter((entry): entry is WorkerHealthEntry => entry !== null);

  return {
    schemaVersion: CURRENT_WORKER_HEALTH_SCHEMA_VERSION,
    updatedAt: normalizeIsoString(value.updatedAt),
    entries,
  };
}

function normalizeEntry(value: unknown): WorkerHealthEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const status = normalizeStatus(value.status);
  const source = normalizeSource(value.source);
  const key = typeof value.key === "string" && source
    ? normalizeWorkerHealthKey(source, value.key)
    : "";
  if (!key || !status || !source) {
    return null;
  }

  const entry: WorkerHealthEntry = {
    key,
    status,
    source,
  };

  const lastFailureClass = normalizeFailureClass(value.lastFailureClass);
  if (lastFailureClass) {
    entry.lastFailureClass = lastFailureClass;
  }

  const lastFailureAt = normalizeOptionalIsoString(value.lastFailureAt);
  if (lastFailureAt) {
    entry.lastFailureAt = lastFailureAt;
  }

  const cooldownUntil = normalizeOptionalIsoString(value.cooldownUntil);
  if (cooldownUntil) {
    entry.cooldownUntil = cooldownUntil;
  }

  if (typeof value.failureCountWindow === "number" && Number.isFinite(value.failureCountWindow)) {
    entry.failureCountWindow = value.failureCountWindow;
  }

  const lastSuccessAt = normalizeOptionalIsoString(value.lastSuccessAt);
  if (lastSuccessAt) {
    entry.lastSuccessAt = lastSuccessAt;
  }

  return entry;
}

function normalizeStatus(value: unknown): WorkerHealthEntry["status"] | null {
  if (
    value === WORKER_HEALTH_STATUS_HEALTHY
    || value === WORKER_HEALTH_STATUS_COOLING_DOWN
    || value === WORKER_HEALTH_STATUS_UNAVAILABLE
  ) {
    return value;
  }

  return null;
}

function normalizeSource(value: unknown): WorkerHealthSource | null {
  return value === "worker" || value === "profile" ? value : null;
}

function normalizeFailureClass(value: unknown): WorkerHealthEntry["lastFailureClass"] | undefined {
  if (
    value === WORKER_FAILURE_CLASS_USAGE_LIMIT
    || value === WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE
    || value === WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER
    || value === WORKER_FAILURE_CLASS_SUCCESS
  ) {
    return value;
  }

  return undefined;
}

function normalizeIsoString(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }

  return new Date().toISOString();
}

function normalizeOptionalIsoString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function createEmptySnapshot(): WorkerHealthSnapshot {
  return {
    schemaVersion: CURRENT_WORKER_HEALTH_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  ensureParentDir(filePath);

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
  }
}

function withFileLock<T>(lockPath: string, action: () => T): T {
  ensureParentDir(lockPath);
  const startedAtMs = Date.now();

  // 5 seconds is enough for local critical sections while avoiding deadlocks.
  const timeoutMs = 5_000;
  const sleepMs = 25;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return action();
      } finally {
        fs.closeSync(fd);
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // Ignore lock cleanup failures; stale lock recovery handles leftovers.
        }
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      if (Date.now() - startedAtMs >= timeoutMs) {
        throw new Error(`Timed out waiting for worker-health lock: ${lockPath}`);
      }

      sleepSync(sleepMs);
    }
  }
}

function sleepSync(durationMs: number): void {
  const waitBuffer = new SharedArrayBuffer(4);
  const waitView = new Int32Array(waitBuffer);
  Atomics.wait(waitView, 0, 0, durationMs);
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function resolveRuntimeConfigDir(startDir: string): string {
  const resolved = path.resolve(startDir);
  return path.basename(resolved) === CONFIG_DIR_NAME
    ? resolved
    : path.join(resolved, CONFIG_DIR_NAME);
}
