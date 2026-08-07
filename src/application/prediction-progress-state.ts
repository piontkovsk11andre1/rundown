import { createHash } from "node:crypto";
import path from "node:path";
import type { FileSystem } from "../domain/ports/index.js";

const PREDICTION_PROGRESS_FILE_NAME = "prediction-progress.json";
const PREDICTION_PROGRESS_SCHEMA_VERSION = 1;
const PREDICTION_PROGRESS_FORMAT_VERSION = "prediction-progress/v1";

export type PredictionProgressStatus = "applied";

export interface PredictionProgressRecord {
  migrationIdentifier: string;
  migrationNumber: number;
  migrationFileName: string;
  migrationContentHash: string;
  status: PredictionProgressStatus;
  appliedAt: string;
}

export interface PredictionProgressLastAppliedPointer {
  migrationIdentifier: string;
  migrationNumber: number;
}

export interface PredictionProgress {
  schemaVersion: number;
  version: string;
  updatedAt: string;
  predictionRootPath: string;
  workspaceRoutingFingerprint: string;
  lastAppliedMigration: PredictionProgressLastAppliedPointer | null;
  migrations: PredictionProgressRecord[];
}

export interface PredictionProgressWriteInput {
  predictionRootPath: string;
  workspaceRoutingFingerprint: string;
  migrations: readonly PredictionProgressRecord[];
}

export interface PredictionProgressMigrationIdentity {
  migrationIdentifier: string;
  migrationNumber: number;
  migrationFileName: string;
  migrationContentHash: string;
}

export type PredictionProgressReadStatus = "ok" | "missing" | "unreadable" | "incompatible";

export interface PredictionProgressReadResult {
  status: PredictionProgressReadStatus;
  progress: PredictionProgress;
  filePath: string;
  reason: string | null;
}

export function predictionProgressFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".rundown", PREDICTION_PROGRESS_FILE_NAME);
}

export function readPredictionProgress(
  fileSystem: FileSystem,
  workspaceRoot: string,
): PredictionProgressReadResult {
  const filePath = predictionProgressFilePath(workspaceRoot);
  if (!fileSystem.exists(filePath)) {
    return {
      status: "missing",
      progress: createEmptyPredictionProgress(),
      filePath,
      reason: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileSystem.readText(filePath));
  } catch {
    return {
      status: "unreadable",
      progress: createEmptyPredictionProgress(),
      filePath,
      reason: "File is not valid JSON.",
    };
  }

  const normalized = normalizePredictionProgress(parsed);
  if (!normalized) {
    return {
      status: "incompatible",
      progress: createEmptyPredictionProgress(),
      filePath,
      reason: "State schema is incompatible with this rundown version.",
    };
  }

  return {
    status: "ok",
    progress: normalized,
    filePath,
    reason: null,
  };
}

export function writePredictionProgress(
  fileSystem: FileSystem,
  workspaceRoot: string,
  input: PredictionProgressWriteInput,
): PredictionProgress {
  const filePath = predictionProgressFilePath(workspaceRoot);
  const normalizedRecords = normalizePredictionProgressRecords(input.migrations);
  if (normalizedRecords === null) {
    throw new Error("Prediction progress contains invalid migration records.");
  }
  const payload: PredictionProgress = {
    schemaVersion: PREDICTION_PROGRESS_SCHEMA_VERSION,
    version: PREDICTION_PROGRESS_FORMAT_VERSION,
    updatedAt: new Date().toISOString(),
    predictionRootPath: normalizePathToken(input.predictionRootPath),
    workspaceRoutingFingerprint: normalizePathToken(input.workspaceRoutingFingerprint),
    lastAppliedMigration: computeLastAppliedMigration(normalizedRecords),
    migrations: normalizedRecords,
  };

  writeTextAtomically(fileSystem, filePath, JSON.stringify(payload, null, 2) + "\n");
  return payload;
}

export function toPredictionProgressRecord(
  migration: PredictionProgressMigrationIdentity,
  appliedAt = new Date().toISOString(),
): PredictionProgressRecord {
  return {
    migrationIdentifier: migration.migrationIdentifier,
    migrationNumber: migration.migrationNumber,
    migrationFileName: migration.migrationFileName,
    migrationContentHash: migration.migrationContentHash,
    status: "applied",
    appliedAt: normalizeIsoTimestamp(appliedAt),
  };
}

export function toMigrationContentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function createEmptyPredictionProgress(): PredictionProgress {
  return {
    schemaVersion: PREDICTION_PROGRESS_SCHEMA_VERSION,
    version: PREDICTION_PROGRESS_FORMAT_VERSION,
    updatedAt: new Date().toISOString(),
    predictionRootPath: "",
    workspaceRoutingFingerprint: "",
    lastAppliedMigration: null,
    migrations: [],
  };
}

function normalizePredictionProgress(value: unknown): PredictionProgress | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.schemaVersion !== PREDICTION_PROGRESS_SCHEMA_VERSION) {
    return null;
  }
  if (typeof value.version !== "string" || value.version.trim().length === 0) {
    return null;
  }
  if (!Array.isArray(value.migrations)) {
    return null;
  }

  const migrations = normalizePredictionProgressRecords(value.migrations);
  if (migrations === null) {
    return null;
  }

  return {
    schemaVersion: PREDICTION_PROGRESS_SCHEMA_VERSION,
    version: value.version.trim(),
    updatedAt: normalizeIsoTimestamp(value.updatedAt),
    predictionRootPath: normalizePathToken(value.predictionRootPath),
    workspaceRoutingFingerprint: normalizePathToken(value.workspaceRoutingFingerprint),
    lastAppliedMigration: computeLastAppliedMigration(migrations),
    migrations,
  };
}

function normalizePredictionProgressRecords(value: readonly unknown[]): PredictionProgressRecord[] | null {
  const byIdentifier = new Map<string, PredictionProgressRecord>();

  for (const item of value) {
    const normalized = normalizePredictionProgressRecord(item);
    if (!normalized) {
      return null;
    }
    byIdentifier.set(normalized.migrationIdentifier, normalized);
  }

  return [...byIdentifier.values()].sort(comparePredictionProgressRecords);
}

function normalizePredictionProgressRecord(value: unknown): PredictionProgressRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const migrationIdentifier = normalizePathToken(value.migrationIdentifier);
  const migrationFileName = normalizePathToken(value.migrationFileName);
  const migrationContentHash = normalizePathToken(value.migrationContentHash);
  if (!migrationIdentifier || !migrationFileName || !migrationContentHash) {
    return null;
  }

  const migrationNumber = typeof value.migrationNumber === "number"
    ? value.migrationNumber
    : Number.parseInt(String(value.migrationNumber ?? ""), 10);
  if (!Number.isInteger(migrationNumber) || migrationNumber < 0) {
    return null;
  }

  const status = value.status === "applied" ? "applied" : null;
  if (!status) {
    return null;
  }

  return {
    migrationIdentifier,
    migrationNumber,
    migrationFileName,
    migrationContentHash,
    status,
    appliedAt: normalizeIsoTimestamp(value.appliedAt),
  };
}

function comparePredictionProgressRecords(
  left: PredictionProgressRecord,
  right: PredictionProgressRecord,
): number {
  if (left.migrationNumber !== right.migrationNumber) {
    return left.migrationNumber - right.migrationNumber;
  }
  return left.migrationIdentifier.localeCompare(right.migrationIdentifier, undefined, { sensitivity: "base" });
}

function computeLastAppliedMigration(
  records: readonly PredictionProgressRecord[],
): PredictionProgressLastAppliedPointer | null {
  const appliedRecords = records.filter((record) => record.status === "applied");
  if (appliedRecords.length === 0) {
    return null;
  }
  const latest = appliedRecords[appliedRecords.length - 1]!;
  return {
    migrationIdentifier: latest.migrationIdentifier,
    migrationNumber: latest.migrationNumber,
  };
}

function writeTextAtomically(fileSystem: FileSystem, filePath: string, content: string): void {
  fileSystem.mkdir(path.dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  fileSystem.writeText(tempPath, content);

  if (typeof fileSystem.rename === "function") {
    try {
      fileSystem.rename(tempPath, filePath);
      return;
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      if (errorCode !== "EPERM" && errorCode !== "EEXIST") {
        try {
          fileSystem.unlink(tempPath);
        } catch {
        }
        throw error;
      }
    }
  }

  fileSystem.writeText(filePath, content);
  try {
    fileSystem.unlink(tempPath);
  } catch {
  }
}

function normalizePathToken(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeIsoTimestamp(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
