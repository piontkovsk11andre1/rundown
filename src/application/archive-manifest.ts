import path from "node:path";
import type { FileSystem } from "../domain/ports/index.js";

export const ARCHIVE_MANIFEST_FILE_NAME = "archive-index.json";
const ARCHIVE_MANIFEST_SCHEMA_VERSION = 1;

export type ArchiveManifestContentKind =
  | "revision-payload"
  | "migration-primary"
  | "migration-review"
  | `migration-thread-${string}`;

export type ArchiveManifestLane = "root" | "thread";

export interface ArchiveManifestEntry {
  kind: ArchiveManifestContentKind;
  originalLogicalPath: string;
  archiveLogicalPath: string;
  archivedAt: string;
  lane?: ArchiveManifestLane;
  threadSlug?: string;
}

export interface ArchiveManifest {
  schemaVersion: number;
  updatedAt: string;
  entries: ArchiveManifestEntry[];
}

export function archiveManifestFilePath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".rundown", ARCHIVE_MANIFEST_FILE_NAME);
}

export function readArchiveManifest(fileSystem: FileSystem, workspaceRoot: string): ArchiveManifest {
  const filePath = archiveManifestFilePath(workspaceRoot);
  if (!fileSystem.exists(filePath)) {
    return createEmptyArchiveManifest();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileSystem.readText(filePath));
  } catch {
    return createEmptyArchiveManifest();
  }

  return normalizeArchiveManifest(parsed);
}

export function writeArchiveManifest(
  fileSystem: FileSystem,
  workspaceRoot: string,
  manifest: ArchiveManifest,
): ArchiveManifest {
  const filePath = archiveManifestFilePath(workspaceRoot);
  const normalized = normalizeArchiveManifestForWrite(manifest);
  const payload: ArchiveManifest = {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    updatedAt: normalized.updatedAt,
    entries: normalized.entries,
  };
  writeTextAtomically(fileSystem, filePath, JSON.stringify(payload, null, 2) + "\n");
  return payload;
}

export function upsertArchiveManifestEntries(
  fileSystem: FileSystem,
  workspaceRoot: string,
  entries: readonly ArchiveManifestEntry[],
): ArchiveManifest {
  if (entries.length === 0) {
    return readArchiveManifest(fileSystem, workspaceRoot);
  }

  const current = readArchiveManifest(fileSystem, workspaceRoot);
  const currentByKey = new Map<string, ArchiveManifestEntry>();

  for (const entry of current.entries) {
    currentByKey.set(buildManifestEntryKey(entry), entry);
  }

  for (const rawEntry of entries) {
    const normalizedEntry = normalizeArchiveManifestEntry(rawEntry);
    if (!normalizedEntry) {
      continue;
    }
    currentByKey.set(buildManifestEntryKey(normalizedEntry), normalizedEntry);
  }

  const mergedEntries = [...currentByKey.values()].sort(compareArchiveManifestEntries);
  const merged: ArchiveManifest = {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: mergedEntries,
  };

  return writeArchiveManifest(fileSystem, workspaceRoot, merged);
}

export function findArchiveManifestEntry(
  manifest: ArchiveManifest,
  input: {
    kind: ArchiveManifestContentKind;
    originalLogicalPath: string;
    lane?: ArchiveManifestLane;
    threadSlug?: string;
  },
): ArchiveManifestEntry | null {
  const normalizedInput = normalizeArchiveManifestEntry({
    kind: input.kind,
    originalLogicalPath: input.originalLogicalPath,
    archiveLogicalPath: "/placeholder",
    archivedAt: new Date(0).toISOString(),
    ...(input.lane ? { lane: input.lane } : {}),
    ...(input.threadSlug ? { threadSlug: input.threadSlug } : {}),
  });
  if (!normalizedInput) {
    return null;
  }
  const lookupKey = buildManifestEntryKey(normalizedInput);

  for (const entry of manifest.entries) {
    if (buildManifestEntryKey(entry) === lookupKey) {
      return entry;
    }
  }

  return null;
}

function normalizeArchiveManifest(value: unknown): ArchiveManifest {
  if (!isRecord(value)) {
    return createEmptyArchiveManifest();
  }
  if (value.schemaVersion !== ARCHIVE_MANIFEST_SCHEMA_VERSION) {
    return createEmptyArchiveManifest();
  }

  const entriesRaw = Array.isArray(value.entries) ? value.entries : [];
  const entries = entriesRaw
    .map((entry) => normalizeArchiveManifestEntry(entry))
    .filter((entry): entry is ArchiveManifestEntry => entry !== null)
    .sort(compareArchiveManifestEntries);

  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    updatedAt: normalizeIsoTimestamp(value.updatedAt),
    entries,
  };
}

function normalizeArchiveManifestForWrite(value: unknown): ArchiveManifest {
  if (!isRecord(value)) {
    return createEmptyArchiveManifest();
  }

  const entriesRaw = Array.isArray(value.entries) ? value.entries : [];
  const entries = entriesRaw
    .map((entry) => normalizeArchiveManifestEntry(entry))
    .filter((entry): entry is ArchiveManifestEntry => entry !== null)
    .sort(compareArchiveManifestEntries);

  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    updatedAt: normalizeIsoTimestamp(value.updatedAt),
    entries,
  };
}

function createEmptyArchiveManifest(): ArchiveManifest {
  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    entries: [],
  };
}

function normalizeArchiveManifestEntry(value: unknown): ArchiveManifestEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const kind = normalizeContentKind(value.kind);
  const originalLogicalPath = normalizeLogicalPath(value.originalLogicalPath);
  const archiveLogicalPath = normalizeLogicalPath(value.archiveLogicalPath);
  if (!kind || !originalLogicalPath || !archiveLogicalPath) {
    return null;
  }

  const lane = normalizeLane(value.lane);
  const threadSlug = normalizeOptionalToken(value.threadSlug);
  if (lane === "thread" && !threadSlug) {
    return null;
  }
  if (lane !== "thread" && threadSlug) {
    return null;
  }

  return {
    kind,
    originalLogicalPath,
    archiveLogicalPath,
    archivedAt: normalizeIsoTimestamp(value.archivedAt),
    ...(lane ? { lane } : {}),
    ...(threadSlug ? { threadSlug } : {}),
  };
}

function normalizeContentKind(value: unknown): ArchiveManifestContentKind | null {
  if (value === "revision-payload" || value === "migration-primary" || value === "migration-review") {
    return value;
  }
  if (typeof value === "string" && value.startsWith("migration-thread-") && value.length > "migration-thread-".length) {
    return value as ArchiveManifestContentKind;
  }

  return null;
}

function normalizeLane(value: unknown): ArchiveManifestLane | undefined {
  return value === "root" || value === "thread" ? value : undefined;
}

function normalizeLogicalPath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\\/g, "/");
  if (trimmed.length === 0) {
    return null;
  }

  return trimmed;
}

function normalizeOptionalToken(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIsoTimestamp(value: unknown): string {
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) {
    return value;
  }

  return new Date().toISOString();
}

function buildManifestEntryKey(entry: ArchiveManifestEntry): string {
  const lane = entry.lane ?? "";
  const threadSlug = entry.threadSlug ?? "";
  return `${entry.kind}::${entry.originalLogicalPath}::${lane}::${threadSlug}`;
}

function compareArchiveManifestEntries(left: ArchiveManifestEntry, right: ArchiveManifestEntry): number {
  if (left.kind !== right.kind) {
    return left.kind.localeCompare(right.kind, undefined, { sensitivity: "base" });
  }
  if (left.originalLogicalPath !== right.originalLogicalPath) {
    return left.originalLogicalPath.localeCompare(right.originalLogicalPath, undefined, { sensitivity: "base" });
  }

  const leftLane = left.lane ?? "";
  const rightLane = right.lane ?? "";
  if (leftLane !== rightLane) {
    return leftLane.localeCompare(rightLane, undefined, { sensitivity: "base" });
  }

  const leftThreadSlug = left.threadSlug ?? "";
  const rightThreadSlug = right.threadSlug ?? "";
  if (leftThreadSlug !== rightThreadSlug) {
    return leftThreadSlug.localeCompare(rightThreadSlug, undefined, { sensitivity: "base" });
  }

  return left.archivedAt.localeCompare(right.archivedAt, undefined, { sensitivity: "base" });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
