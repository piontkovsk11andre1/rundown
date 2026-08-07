import { CONFIG_DIR_NAME } from "../../domain/ports/config-dir-port.js";
import type { FileSystem } from "../../domain/ports/file-system.js";
import type { MemoryFileInfo, MemoryReaderPort } from "../../domain/ports/memory-reader-port.js";
import type { MemoryIndexEntry, MemoryIndexOrigin } from "../../domain/ports/memory-writer-port.js";
import type { PathOperationsPort } from "../../domain/ports/path-operations-port.js";

const MEMORY_INDEX_FILE_NAME = "memory-index.json";
const MEMORY_FILE_SUFFIX = ".memory.md";

type MemoryIndex = Record<string, unknown>;

/**
 * Dependencies required to read source-local memory body and index files.
 */
export interface MemoryReaderAdapterDependencies {
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
}

/**
 * Creates a memory reader adapter for source-local memory artifacts.
 */
export function createMemoryReaderAdapter(
  dependencies: MemoryReaderAdapterDependencies,
): MemoryReaderPort {
  return {
    read(sourcePath) {
      const canonicalSourcePath = dependencies.pathOperations.resolve(sourcePath);
      const sourceDirectory = dependencies.pathOperations.dirname(canonicalSourcePath);
      const sourceName = basenameFromPath(canonicalSourcePath);
      const memoryDirectory = dependencies.pathOperations.join(sourceDirectory, CONFIG_DIR_NAME);
      const memoryFilePath = dependencies.pathOperations.join(memoryDirectory, `${sourceName}${MEMORY_FILE_SUFFIX}`);
      const memoryIndexPath = dependencies.pathOperations.join(memoryDirectory, MEMORY_INDEX_FILE_NAME);

      const entries = readMemoryEntries(memoryFilePath, dependencies.fileSystem);
      const index = readMemoryIndexEntry(memoryIndexPath, canonicalSourcePath, dependencies.fileSystem);

      return {
        entries,
        index,
      };
    },
    readAll(directory) {
      const rootDirectory = dependencies.pathOperations.resolve(directory);
      const memoryFiles = collectMemoryFiles(rootDirectory, dependencies.fileSystem, dependencies.pathOperations);
      const indexCache = new Map<string, MemoryIndex | null>();

      return memoryFiles.map((memoryFilePath): MemoryFileInfo => {
        const memoryDirectory = dependencies.pathOperations.dirname(memoryFilePath);
        const sourceDirectory = dependencies.pathOperations.dirname(memoryDirectory);
        const memoryFileName = basenameFromPath(memoryFilePath);
        const sourceName = memoryFileName.slice(0, -MEMORY_FILE_SUFFIX.length);
        const sourcePath = dependencies.pathOperations.resolve(
          dependencies.pathOperations.join(sourceDirectory, sourceName),
        );
        const memoryIndexPath = dependencies.pathOperations.join(memoryDirectory, MEMORY_INDEX_FILE_NAME);

        let parsedIndex = indexCache.get(memoryDirectory);
        if (parsedIndex === undefined) {
          parsedIndex = readMemoryIndex(memoryIndexPath, dependencies.fileSystem);
          indexCache.set(memoryDirectory, parsedIndex);
        }

        return {
          sourcePath,
          memoryFilePath,
          entries: readMemoryEntries(memoryFilePath, dependencies.fileSystem),
          index: normalizeMemoryIndexEntry(parsedIndex?.[sourcePath]),
        };
      });
    },
  };
}

function collectMemoryFiles(
  directory: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): string[] {
  const files: string[] = [];
  const entries = readDirectoryEntries(directory, fileSystem);

  for (const entry of entries) {
    const entryPath = pathOperations.join(directory, entry.name);
    if (entry.isDirectory) {
      if (entry.name === CONFIG_DIR_NAME) {
        const memoryDirEntries = readDirectoryEntries(entryPath, fileSystem);
        for (const memoryEntry of memoryDirEntries) {
          if (!memoryEntry.isFile || !memoryEntry.name.endsWith(MEMORY_FILE_SUFFIX)) {
            continue;
          }

          files.push(pathOperations.join(entryPath, memoryEntry.name));
        }
        continue;
      }

      files.push(...collectMemoryFiles(entryPath, fileSystem, pathOperations));
    }
  }

  return files;
}

function readDirectoryEntries(directory: string, fileSystem: FileSystem) {
  try {
    return fileSystem.readdir(directory);
  } catch {
    return [];
  }
}

function readMemoryEntries(memoryFilePath: string, fileSystem: FileSystem): string[] {
  try {
    if (!fileSystem.exists(memoryFilePath)) {
      return [];
    }

    const body = fileSystem.readText(memoryFilePath);
    return splitMemoryEntries(body);
  } catch {
    return [];
  }
}

function splitMemoryEntries(body: string): string[] {
  if (body.trim().length === 0) {
    return [];
  }

  return body
    .split(/\r?\n\s*---\s*\r?\n/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function readMemoryIndexEntry(
  memoryIndexPath: string,
  sourcePath: string,
  fileSystem: FileSystem,
): MemoryIndexEntry | null {
  const index = readMemoryIndex(memoryIndexPath, fileSystem);
  return normalizeMemoryIndexEntry(index?.[sourcePath]);
}

function readMemoryIndex(
  memoryIndexPath: string,
  fileSystem: FileSystem,
): MemoryIndex | null {
  try {
    if (!fileSystem.exists(memoryIndexPath)) {
      return null;
    }

    const raw = fileSystem.readText(memoryIndexPath);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as MemoryIndex;
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
    entryCount: normalizeEntryCount(record.entryCount, summary),
  };

  if (typeof record.lastPrefix === "string" && record.lastPrefix.trim().length > 0) {
    normalized.lastPrefix = record.lastPrefix;
  }

  const origin = normalizeOrigin(record.origin);
  if (origin) {
    normalized.origin = origin;
  }

  return normalized;
}

function normalizeEntryCount(value: unknown, summary: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  return summary.length > 0 ? 1 : 0;
}

function normalizeOrigin(value: unknown): MemoryIndexOrigin | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const originRecord = value as {
    taskText?: unknown;
    taskLine?: unknown;
    sourceHash?: unknown;
  };

  if (typeof originRecord.taskText !== "string") {
    return undefined;
  }
  if (typeof originRecord.taskLine !== "number" || !Number.isFinite(originRecord.taskLine)) {
    return undefined;
  }

  const normalizedOrigin: MemoryIndexOrigin = {
    taskText: originRecord.taskText,
    taskLine: Math.floor(originRecord.taskLine),
  };

  if (typeof originRecord.sourceHash === "string" && originRecord.sourceHash.length > 0) {
    normalizedOrigin.sourceHash = originRecord.sourceHash;
  }

  return normalizedOrigin;
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[/\\]+/);
  return parts[parts.length - 1] ?? filePath;
}
