import type { FileSystem } from "../domain/ports/file-system.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { PathOperationsPort } from "../domain/ports/path-operations-port.js";
import type {
  MemoryCleanResult,
  MemoryIndexEntry,
  MemoryReaderPort,
  MemoryResolverPort,
  SourceResolverPort,
} from "../domain/ports/index.js";

const MEMORY_INDEX_FILE_NAME = "memory-index.json";

interface MemoryCandidate {
  sourcePath: string;
  memoryFilePath: string;
  memoryIndexPath: string;
  indexEntry: MemoryIndexEntry | null;
  bodyExists: boolean;
  sourceExists: boolean;
  bodySizeBytes: number;
  bodyMtimeMs: number | null;
}

/**
 * Dependencies required to remove source-local memory artifacts.
 */
export interface CleanMemoryDependencies {
  sourceResolver: SourceResolverPort;
  memoryResolver: MemoryResolverPort;
  memoryReader: MemoryReaderPort;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  output: ApplicationOutputPort;
}

/**
 * Runtime options for memory cleanup.
 */
export interface CleanMemoryOptions {
  source: string;
  dryRun: boolean;
  orphans: boolean;
  outdated: boolean;
  olderThan: string;
  all: boolean;
  force: boolean;
}

/**
 * Creates the memory-clean application use case.
 */
export function createCleanMemory(
  dependencies: CleanMemoryDependencies,
): (options: CleanMemoryOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function cleanMemory(options: CleanMemoryOptions): Promise<number> {
    if (options.all && !options.force) {
      emit({ kind: "warn", message: "Refusing to clean all memory without --force." });
      return 2;
    }

    const resolvedSources = await dependencies.sourceResolver.resolveSources(options.source);
    if (resolvedSources.length === 0) {
      emit({ kind: "warn", message: "No Markdown files found matching: " + options.source });
      return 3;
    }

    const olderThanMs = parseAgeThresholdMs(options.olderThan);
    const candidates = collectCandidates(dependencies, resolvedSources);
    const selectedCandidates = selectCandidates(candidates, options, olderThanMs, Date.now());

    if (selectedCandidates.length === 0) {
      emit({ kind: "info", message: "No memory artifacts found for cleanup filters." });
      return 0;
    }

    const cleanupResult = executeCleanup(dependencies, selectedCandidates, options.dryRun);
    renderCleanupResult(cleanupResult, selectedCandidates, emit);

    return 0;
  };
}

function collectCandidates(
  dependencies: CleanMemoryDependencies,
  resolvedSources: string[],
): MemoryCandidate[] {
  const candidates = new Map<string, MemoryCandidate>();
  const sourceDirectories = new Set<string>();

  for (const sourcePath of resolvedSources) {
    const canonicalSourcePath = dependencies.pathOperations.resolve(sourcePath);
    sourceDirectories.add(dependencies.pathOperations.dirname(canonicalSourcePath));

    const metadata = dependencies.memoryResolver.resolve(canonicalSourcePath);
    const memory = dependencies.memoryReader.read(canonicalSourcePath);
    candidates.set(canonicalSourcePath, buildCandidate(
      dependencies,
      canonicalSourcePath,
      metadata.filePath,
      memory.index,
    ));
  }

  for (const sourceDirectory of sourceDirectories) {
    const memoryFiles = dependencies.memoryReader.readAll(sourceDirectory);
    for (const memoryFile of memoryFiles) {
      const canonicalSourcePath = dependencies.pathOperations.resolve(memoryFile.sourcePath);
      candidates.set(canonicalSourcePath, buildCandidate(
        dependencies,
        canonicalSourcePath,
        memoryFile.memoryFilePath,
        memoryFile.index,
      ));
    }
  }

  return Array.from(candidates.values())
    .filter((candidate) => candidate.bodyExists || candidate.indexEntry !== null)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function buildCandidate(
  dependencies: CleanMemoryDependencies,
  sourcePath: string,
  memoryFilePath: string,
  indexEntry: MemoryIndexEntry | null,
): MemoryCandidate {
  const bodyStats = safeStat(dependencies.fileSystem, memoryFilePath);

  return {
    sourcePath,
    memoryFilePath,
    memoryIndexPath: dependencies.pathOperations.join(
      dependencies.pathOperations.dirname(memoryFilePath),
      MEMORY_INDEX_FILE_NAME,
    ),
    indexEntry,
    bodyExists: bodyStats?.isFile ?? false,
    sourceExists: safeExists(dependencies.fileSystem, sourcePath),
    bodySizeBytes: bodyStats?.size ?? 0,
    bodyMtimeMs: typeof bodyStats?.mtimeMs === "number" ? bodyStats.mtimeMs : null,
  };
}

function selectCandidates(
  candidates: MemoryCandidate[],
  options: CleanMemoryOptions,
  olderThanMs: number,
  nowMs: number,
): MemoryCandidate[] {
  return candidates.filter((candidate) => {
    if (options.all) {
      return true;
    }

    const orphaned = !candidate.sourceExists;
    const invalid = candidate.indexEntry !== null && !candidate.bodyExists;
    const outdated = isOutdated(candidate, nowMs, olderThanMs);

    if (options.orphans && options.outdated) {
      return orphaned || outdated;
    }
    if (options.orphans) {
      return orphaned;
    }
    if (options.outdated) {
      return outdated;
    }

    return orphaned || invalid || outdated;
  });
}

function isOutdated(candidate: MemoryCandidate, nowMs: number, olderThanMs: number): boolean {
  const updatedAtMs = resolveUpdatedAtMs(candidate);
  if (updatedAtMs === null) {
    return false;
  }

  return nowMs - updatedAtMs >= olderThanMs;
}

function resolveUpdatedAtMs(candidate: MemoryCandidate): number | null {
  if (candidate.indexEntry?.updatedAt) {
    const parsed = Date.parse(candidate.indexEntry.updatedAt);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return candidate.bodyMtimeMs;
}

function executeCleanup(
  dependencies: CleanMemoryDependencies,
  selectedCandidates: MemoryCandidate[],
  dryRun: boolean,
): MemoryCleanResult {
  const removed: string[] = [];
  let freedBytes = 0;
  const indexUpdates = new Map<string, Record<string, MemoryIndexEntry>>();

  for (const candidate of selectedCandidates) {
    if (dryRun) {
      if (candidate.bodyExists) {
        removed.push(candidate.memoryFilePath);
        freedBytes += candidate.bodySizeBytes;
      }
      continue;
    }

    if (candidate.bodyExists) {
      dependencies.fileSystem.rm(candidate.memoryFilePath, { force: true });
      removed.push(candidate.memoryFilePath);
      freedBytes += candidate.bodySizeBytes;
    }

    const indexEntries = ensureIndexUpdateState(dependencies.fileSystem, candidate.memoryIndexPath, indexUpdates);
    delete indexEntries[candidate.sourcePath];
  }

  if (!dryRun) {
    for (const [memoryIndexPath, indexEntries] of indexUpdates.entries()) {
      writeMemoryIndexAtomically(dependencies, memoryIndexPath, indexEntries);
    }
  }

  return {
    removed,
    freedBytes,
    dryRun,
  };
}

function ensureIndexUpdateState(
  fileSystem: FileSystem,
  memoryIndexPath: string,
  updates: Map<string, Record<string, MemoryIndexEntry>>,
): Record<string, MemoryIndexEntry> {
  const existing = updates.get(memoryIndexPath);
  if (existing) {
    return existing;
  }

  const initial = readNormalizedMemoryIndex(fileSystem, memoryIndexPath);
  updates.set(memoryIndexPath, initial);
  return initial;
}

function renderCleanupResult(
  result: MemoryCleanResult,
  selectedCandidates: MemoryCandidate[],
  emit: ApplicationOutputPort["emit"],
): void {
  emit({ kind: "text", text: "Cleanup plan:" });
  for (const candidate of selectedCandidates) {
    emit({
      kind: "text",
      text: `  ${candidate.memoryFilePath} (${formatBytes(candidate.bodySizeBytes)})`,
    });
  }

  if (result.dryRun) {
    emit({ kind: "info", message: `Dry run: ${selectedCandidates.length} memory artifact(s) would be cleaned.` });
    emit({ kind: "info", message: `Estimated reclaimed space: ${formatBytes(result.freedBytes)}.` });
    return;
  }

  emit({ kind: "success", message: `Removed ${result.removed.length} memory file(s).` });
  emit({ kind: "info", message: `Reclaimed space: ${formatBytes(result.freedBytes)}.` });
}

function parseAgeThresholdMs(duration: string): number {
  const normalized = duration.trim().toLowerCase();
  const match = normalized.match(/^(\d+)\s*(d|day|days|w|week|weeks|m|mo|month|months|y|yr|year|years)$/);
  if (!match) {
    throw new Error(`Invalid --older-than duration: ${duration}. Expected values like 30d, 6m, or 1y.`);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`Invalid --older-than duration: ${duration}. Duration must be greater than zero.`);
  }

  const dayMs = 24 * 60 * 60 * 1000;
  switch (unit) {
    case "d":
    case "day":
    case "days":
      return amount * dayMs;
    case "w":
    case "week":
    case "weeks":
      return amount * 7 * dayMs;
    case "m":
    case "mo":
    case "month":
    case "months":
      return amount * 30 * dayMs;
    case "y":
    case "yr":
    case "year":
    case "years":
      return amount * 365 * dayMs;
    default:
      throw new Error(`Invalid --older-than duration: ${duration}.`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function readNormalizedMemoryIndex(fileSystem: FileSystem, memoryIndexPath: string): Record<string, MemoryIndexEntry> {
  const rawIndex = readRawMemoryIndex(fileSystem, memoryIndexPath);
  if (!rawIndex) {
    return {};
  }

  const normalized: Record<string, MemoryIndexEntry> = {};
  for (const [sourcePath, value] of Object.entries(rawIndex)) {
    const entry = normalizeMemoryIndexEntry(value);
    if (!entry) {
      continue;
    }
    normalized[sourcePath] = entry;
  }

  return normalized;
}

function readRawMemoryIndex(fileSystem: FileSystem, memoryIndexPath: string): Record<string, unknown> | null {
  try {
    if (!fileSystem.exists(memoryIndexPath)) {
      return null;
    }

    const raw = fileSystem.readText(memoryIndexPath);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeMemoryIndexEntry(value: unknown): MemoryIndexEntry | null {
  if (typeof value === "string") {
    const summary = value.trim();
    if (summary.length === 0) {
      return null;
    }

    return {
      summary,
      updatedAt: "",
      entryCount: 1,
    };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as {
    summary?: unknown;
    description?: unknown;
    updatedAt?: unknown;
    lastPrefix?: unknown;
    entryCount?: unknown;
    origin?: unknown;
  };

  const summary = typeof record.summary === "string"
    ? record.summary.trim()
    : typeof record.description === "string"
      ? record.description.trim()
      : "";
  if (summary.length === 0) {
    return null;
  }

  const normalized: MemoryIndexEntry = {
    summary,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    entryCount: typeof record.entryCount === "number" && Number.isFinite(record.entryCount) && record.entryCount >= 0
      ? Math.floor(record.entryCount)
      : 1,
  };

  if (typeof record.lastPrefix === "string" && record.lastPrefix.trim().length > 0) {
    normalized.lastPrefix = record.lastPrefix;
  }

  if (record.origin && typeof record.origin === "object") {
    const originRecord = record.origin as {
      taskText?: unknown;
      taskLine?: unknown;
      sourceHash?: unknown;
    };

    if (typeof originRecord.taskText === "string"
      && typeof originRecord.taskLine === "number"
      && Number.isFinite(originRecord.taskLine)) {
      normalized.origin = {
        taskText: originRecord.taskText,
        taskLine: Math.floor(originRecord.taskLine),
      };

      if (typeof originRecord.sourceHash === "string" && originRecord.sourceHash.length > 0) {
        normalized.origin.sourceHash = originRecord.sourceHash;
      }
    }
  }

  return normalized;
}

function writeMemoryIndexAtomically(
  dependencies: CleanMemoryDependencies,
  memoryIndexPath: string,
  indexEntries: Record<string, MemoryIndexEntry>,
): void {
  const memoryDirectory = dependencies.pathOperations.dirname(memoryIndexPath);
  const rename = dependencies.fileSystem.rename;

  if (Object.keys(indexEntries).length === 0) {
    dependencies.fileSystem.rm(memoryIndexPath, { force: true });
    return;
  }

  const serialized = JSON.stringify(indexEntries, null, 2);
  dependencies.fileSystem.mkdir(memoryDirectory, { recursive: true });
  if (!rename) {
    dependencies.fileSystem.writeText(memoryIndexPath, serialized);
    return;
  }

  const tempPath = `${memoryIndexPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  dependencies.fileSystem.writeText(tempPath, serialized);

  try {
    rename(tempPath, memoryIndexPath);
  } catch (error) {
    try {
      if (dependencies.fileSystem.exists(tempPath)) {
        dependencies.fileSystem.rm(tempPath, { force: true });
      }
    } catch {
      // Best-effort temp cleanup only.
    }
    throw error;
  }
}

function safeExists(fileSystem: FileSystem, filePath: string): boolean {
  try {
    return fileSystem.exists(filePath);
  } catch {
    return false;
  }
}

function safeStat(fileSystem: FileSystem, filePath: string): (ReturnType<FileSystem["stat"]> & { size?: number }) | null {
  try {
    return fileSystem.stat(filePath) as (ReturnType<FileSystem["stat"]> & { size?: number }) | null;
  } catch {
    return null;
  }
}
