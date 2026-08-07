import type { MemoryIndexEntry } from "./memory-writer-port.js";

/**
 * Describes a readable source-local memory body file with optional index metadata.
 */
export interface MemoryFileInfo {
  // Canonical source path that owns this memory file.
  sourcePath: string;
  // Absolute path to the memory body file.
  memoryFilePath: string;
  // Parsed memory entries from the body file.
  entries: string[];
  // Optional index metadata for the source.
  index: MemoryIndexEntry | null;
}

/**
 * Defines read access to source-local memory body and index data.
 */
export interface MemoryReaderPort {
  // Reads parsed entries and index metadata for a single source path.
  read(sourcePath: string): { entries: string[]; index: MemoryIndexEntry | null };
  // Reads all memory body files and index metadata under a directory.
  readAll(directory: string): MemoryFileInfo[];
}
