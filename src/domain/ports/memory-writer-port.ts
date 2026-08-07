/**
 * Input payload required to persist memory capture output.
 */
export interface MemoryWriteInput {
  // Source markdown path that owns the memory artifacts.
  sourcePath: string;
  // Worker output content to persist into the source-local memory body file.
  workerOutput: string;
  // Optional memory prefix alias used by the task (for example: memory, remember).
  capturePrefix?: string;
  // Optional source-task metadata used to track the memory entry origin.
  originTask?: {
    text: string;
    line: number;
  };
}

/**
 * Origin metadata for a memory entry captured from a source task.
 */
export interface MemoryIndexOrigin {
  // Original task checkbox text used to capture this memory entry.
  taskText: string;
  // 1-based source line number where the task was captured.
  taskLine: number;
  // Optional source content hash captured at memory-write time.
  sourceHash?: string;
}

/**
 * Persisted memory index metadata for a source document.
 */
export interface MemoryIndexEntry {
  // Short human-readable summary of the latest memory entry.
  summary: string;
  // ISO timestamp for the most recent memory update.
  updatedAt: string;
  // Prefix used to capture the latest memory entry.
  lastPrefix?: string;
  // Total number of entries currently present in the memory body file.
  entryCount: number;
  // Optional origin details for the task that created the latest entry.
  origin?: MemoryIndexOrigin;
}

/**
 * Successful memory write details returned to callers.
 */
export interface MemoryWriteSuccess {
  // Absolute path to the persisted memory body file.
  memoryFilePath: string;
  // Absolute path to the memory index file.
  memoryIndexPath: string;
  // Canonical absolute source path used as the index key.
  canonicalSourcePath: string;
  // Optional warning produced during non-fatal recovery (for example malformed index rebuild).
  warningMessage?: string;
}

/**
 * Failure envelope returned when memory persistence cannot be completed.
 */
export interface MemoryWriteFailure {
  // Human-readable message suitable for CLI surfacing.
  message: string;
  // Stable reason used by run lifecycle and trace metadata.
  reason: string;
  // Optional warning that should be surfaced before the terminal failure message.
  warningMessage?: string;
}

/**
 * Defines the source-local memory persistence contract (body + index update).
 */
export interface MemoryWriterPort {
  // Persists memory body content and updates index metadata for a source file.
  write(input: MemoryWriteInput):
    | { ok: true; value: MemoryWriteSuccess }
    | { ok: false; error: MemoryWriteFailure };
}
