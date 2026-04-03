import { CONFIG_DIR_NAME } from "../../domain/ports/config-dir-port.js";
import type { FileSystem } from "../../domain/ports/file-system.js";
import type {
  MemoryWriteFailure,
  MemoryWriteInput,
  MemoryWriteSuccess,
  MemoryWriterPort,
} from "../../domain/ports/memory-writer-port.js";
import type { PathOperationsPort } from "../../domain/ports/path-operations-port.js";

const MEMORY_INDEX_FILE_NAME = "memory-index.json";

type MemoryIndexEntry = {
  summary?: unknown;
  updatedAt?: unknown;
  lastPrefix?: unknown;
  entryCount?: unknown;
};

type MemoryIndex = Record<string, MemoryIndexEntry | string>;

/**
 * Dependencies required to persist source-local memory body and index files.
 */
export interface MemoryWriterAdapterDependencies {
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
}

/**
 * Creates a memory writer adapter that appends worker output to source-local
 * memory and updates the source-local memory index.
 */
export function createMemoryWriterAdapter(
  dependencies: MemoryWriterAdapterDependencies,
): MemoryWriterPort {
  return {
    write(input: MemoryWriteInput) {
      const normalizedOutput = input.workerOutput.trim();
      if (normalizedOutput.length === 0) {
        return failure("Memory capture worker returned empty output; nothing to persist.", "Memory capture worker returned empty output.");
      }

      const canonicalSourcePath = dependencies.pathOperations.resolve(input.sourcePath);
      const sourceDirectory = dependencies.pathOperations.dirname(canonicalSourcePath);
      const sourceName = basenameFromPath(canonicalSourcePath);
      const memoryDirectory = dependencies.pathOperations.join(sourceDirectory, CONFIG_DIR_NAME);
      const memoryFilePath = dependencies.pathOperations.join(memoryDirectory, `${sourceName}.memory.md`);
      const memoryIndexPath = dependencies.pathOperations.join(memoryDirectory, MEMORY_INDEX_FILE_NAME);

      const existingMemoryBody = readExistingMemoryBody(memoryFilePath, dependencies.fileSystem);
      if (!existingMemoryBody.ok) {
        return failure(
          "Failed to read existing memory body file at " + memoryFilePath + ": " + existingMemoryBody.error,
          "Memory body read failed.",
        );
      }

      const nextMemoryBody = appendMemoryEntry(existingMemoryBody.value, normalizedOutput);

      const memoryBodyWriteResult = writeWithLazyDirectoryCreate({
        filePath: memoryFilePath,
        content: nextMemoryBody,
        parentDirectory: memoryDirectory,
        fileSystem: dependencies.fileSystem,
      });
      if (!memoryBodyWriteResult.ok) {
        return failure("Failed to persist memory body file: " + String(memoryBodyWriteResult.error), "Memory body write failed.");
      }

      const loadedIndex = loadMemoryIndex(memoryIndexPath, dependencies.fileSystem);
      const nextIndex: MemoryIndex = loadedIndex.ok ? loadedIndex.value : {};
      const existingEntry = nextIndex[canonicalSourcePath];
      const indexEntry = composeMemoryIndexEntry({
        existingEntry,
        output: normalizedOutput,
        capturePrefix: input.capturePrefix,
      });
      nextIndex[canonicalSourcePath] = {
        summary: indexEntry.summary,
        updatedAt: indexEntry.updatedAt,
        lastPrefix: indexEntry.lastPrefix,
        entryCount: indexEntry.entryCount,
      };

      const indexWriteResult = writeJsonAtomically({
        memoryIndexPath,
        memoryDirectory,
        json: JSON.stringify(nextIndex, null, 2),
        fileSystem: dependencies.fileSystem,
      });
      if (!indexWriteResult.ok) {
        return failure(
          "Memory body was written to "
            + memoryFilePath
            + " but updating memory index failed at "
            + memoryIndexPath
            + ": "
            + String(indexWriteResult.error),
          "Memory index update failed after writing memory body.",
          "Memory capture output was persisted to " + memoryFilePath + ", but memory index metadata could not be updated.",
        );
      }

      const success: MemoryWriteSuccess = {
        memoryFilePath,
        memoryIndexPath,
        canonicalSourcePath,
      };

      if (!loadedIndex.ok) {
        success.warningMessage = "Memory index is malformed at "
          + memoryIndexPath
          + "; rebuilding index entry for current source.";
      }

      return { ok: true, value: success };
    },
  };
}

function writeWithLazyDirectoryCreate(params: {
  filePath: string;
  content: string;
  parentDirectory: string;
  fileSystem: FileSystem;
}): { ok: true } | { ok: false; error: unknown } {
  const { filePath, content, parentDirectory, fileSystem } = params;
  try {
    fileSystem.writeText(filePath, content);
    return { ok: true };
  } catch (initialError) {
    if (!isMissingParentDirectoryError(initialError)) {
      return { ok: false, error: initialError };
    }

    try {
      fileSystem.mkdir(parentDirectory, { recursive: true });
      fileSystem.writeText(filePath, content);
      return { ok: true };
    } catch (retryError) {
      return { ok: false, error: retryError };
    }
  }
}

function writeJsonAtomically(params: {
  memoryIndexPath: string;
  memoryDirectory: string;
  json: string;
  fileSystem: FileSystem;
}): { ok: true } | { ok: false; error: unknown } {
  const { memoryIndexPath, memoryDirectory, json, fileSystem } = params;
  const tempPath = buildAtomicTempPath(memoryIndexPath);
  const rename = fileSystem.rename;

  if (!rename) {
    return writeWithLazyDirectoryCreate({
      filePath: memoryIndexPath,
      content: json,
      parentDirectory: memoryDirectory,
      fileSystem,
    });
  }

  const tempWrite = writeWithLazyDirectoryCreate({
    filePath: tempPath,
    content: json,
    parentDirectory: memoryDirectory,
    fileSystem,
  });
  if (!tempWrite.ok) {
    return tempWrite;
  }

  try {
    rename(tempPath, memoryIndexPath);
    return { ok: true };
  } catch (error) {
    removeIfPresent(fileSystem, tempPath);
    return { ok: false, error };
  }
}

function buildAtomicTempPath(memoryIndexPath: string): string {
  return memoryIndexPath + ".tmp-" + Date.now() + "-" + Math.random().toString(16).slice(2);
}

function isMissingParentDirectoryError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeNodeError = error as { code?: unknown };
  return maybeNodeError.code === "ENOENT";
}

function removeIfPresent(fileSystem: FileSystem, filePath: string): void {
  try {
    if (fileSystem.exists(filePath)) {
      fileSystem.rm(filePath, { force: true });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

function failure(
  message: string,
  reason: string,
  warningMessage?: string,
): { ok: false; error: MemoryWriteFailure } {
  return {
    ok: false,
    error: {
      message,
      reason,
      warningMessage,
    },
  };
}

function readExistingMemoryBody(
  memoryFilePath: string,
  fileSystem: FileSystem,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    if (!fileSystem.exists(memoryFilePath)) {
      return { ok: true, value: "" };
    }

    return { ok: true, value: fileSystem.readText(memoryFilePath) };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function appendMemoryEntry(existingBody: string, nextEntry: string): string {
  if (existingBody.trim().length === 0) {
    return nextEntry + "\n";
  }

  const separator = existingBody.endsWith("\n") ? "\n---\n\n" : "\n\n---\n\n";
  return existingBody + separator + nextEntry + "\n";
}

function loadMemoryIndex(
  memoryIndexPath: string,
  fileSystem: FileSystem,
): { ok: true; value: MemoryIndex } | { ok: false } {
  try {
    if (!fileSystem.exists(memoryIndexPath)) {
      return { ok: true, value: {} };
    }

    const raw = fileSystem.readText(memoryIndexPath);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false };
    }

    return { ok: true, value: parsed as MemoryIndex };
  } catch {
    return { ok: false };
  }
}

function summarizeMemoryOutput(output: string): string {
  const firstNonEmptyLine = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstNonEmptyLine) {
    return "memory captured";
  }

  return firstNonEmptyLine.length > 160
    ? firstNonEmptyLine.slice(0, 157) + "..."
    : firstNonEmptyLine;
}

function composeMemoryIndexEntry(params: {
  existingEntry: MemoryIndexEntry | string | undefined;
  output: string;
  capturePrefix: string | undefined;
}): {
  summary: string;
  updatedAt: string;
  lastPrefix?: string;
  entryCount: number;
} {
  const { existingEntry, output, capturePrefix } = params;
  const normalizedPrefix = normalizeCapturePrefix(capturePrefix);

  return {
    summary: summarizeMemoryOutput(output),
    updatedAt: new Date().toISOString(),
    lastPrefix: normalizedPrefix,
    entryCount: readPreviousEntryCount(existingEntry) + 1,
  };
}

function readPreviousEntryCount(existingEntry: MemoryIndexEntry | string | undefined): number {
  if (typeof existingEntry === "string") {
    return existingEntry.trim().length > 0 ? 1 : 0;
  }

  if (!existingEntry || typeof existingEntry !== "object") {
    return 0;
  }

  const entryCount = existingEntry.entryCount;
  if (typeof entryCount === "number" && Number.isFinite(entryCount) && entryCount >= 0) {
    return Math.floor(entryCount);
  }

  const summary = typeof existingEntry.summary === "string"
    ? existingEntry.summary
    : typeof (existingEntry as { description?: unknown }).description === "string"
      ? String((existingEntry as { description?: unknown }).description)
      : "";
  return summary.trim().length > 0 ? 1 : 0;
}

function normalizeCapturePrefix(prefix: string | undefined): string | undefined {
  if (!prefix) {
    return undefined;
  }

  const normalized = prefix.trim().toLowerCase();
  if (
    normalized === "memory"
    || normalized === "memorize"
    || normalized === "remember"
    || normalized === "inventory"
  ) {
    return normalized;
  }

  return undefined;
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[/\\]+/);
  return parts[parts.length - 1] ?? filePath;
}
