import { CONFIG_DIR_NAME } from "../../domain/ports/config-dir-port.js";
import type { FileSystem } from "../../domain/ports/file-system.js";
import type { MemoryResolverPort } from "../../domain/ports/memory-resolver-port.js";
import type { PathOperationsPort } from "../../domain/ports/path-operations-port.js";

const MEMORY_INDEX_FILE_NAME = "memory-index.json";

type MemoryIndexRecord = {
  summary?: unknown;
  description?: unknown;
};

type MemoryIndex = Record<string, MemoryIndexRecord | string>;

/**
 * Dependencies required to resolve source-local memory metadata.
 */
export interface MemoryResolverAdapterDependencies {
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
}

/**
 * Creates a memory resolver adapter that maps source files to source-local memory paths.
 */
export function createMemoryResolverAdapter(
  dependencies: MemoryResolverAdapterDependencies,
): MemoryResolverPort {
  return {
    resolve(sourcePath) {
      const canonicalSourcePath = dependencies.pathOperations.resolve(sourcePath);
      const sourceDirectory = dependencies.pathOperations.dirname(canonicalSourcePath);
      const sourceName = basenameFromPath(canonicalSourcePath);
      const sourceConfigDirectory = dependencies.pathOperations.join(sourceDirectory, CONFIG_DIR_NAME);
      const memoryFilePath = dependencies.pathOperations.join(
        sourceConfigDirectory,
        `${sourceName}.memory.md`,
      );
      const memoryIndexPath = dependencies.pathOperations.join(sourceConfigDirectory, MEMORY_INDEX_FILE_NAME);

      return {
        available: safeExists(memoryFilePath, dependencies.fileSystem),
        filePath: memoryFilePath,
        summary: resolveMemorySummary(memoryIndexPath, canonicalSourcePath, dependencies.fileSystem),
      };
    },
  };
}

function resolveMemorySummary(
  memoryIndexPath: string,
  canonicalSourcePath: string,
  fileSystem: FileSystem,
): string | undefined {
  if (!safeExists(memoryIndexPath, fileSystem)) {
    return undefined;
  }

  try {
    const rawIndex = fileSystem.readText(memoryIndexPath);
    const parsedIndex = JSON.parse(rawIndex) as unknown;
    if (!isMemoryIndex(parsedIndex)) {
      return undefined;
    }

    return normalizeSummary(parsedIndex[canonicalSourcePath]);
  } catch {
    return undefined;
  }
}

function safeExists(filePath: string, fileSystem: FileSystem): boolean {
  try {
    return fileSystem.exists(filePath);
  } catch {
    return false;
  }
}

function isMemoryIndex(value: unknown): value is MemoryIndex {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeSummary(record: MemoryIndexRecord | string | undefined): string | undefined {
  if (typeof record === "string") {
    const summary = record.trim();
    return summary.length > 0 ? summary : undefined;
  }
  if (!record || typeof record !== "object") {
    return undefined;
  }

  const summaryField = typeof record.summary === "string"
    ? record.summary
    : typeof record.description === "string"
      ? record.description
      : undefined;
  if (!summaryField) {
    return undefined;
  }

  const normalizedSummary = summaryField.trim();
  return normalizedSummary.length > 0 ? normalizedSummary : undefined;
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[/\\]+/);
  return parts[parts.length - 1] ?? filePath;
}
