/**
 * Describes metadata returned by a file system stat operation.
 */
export interface FileSystemStat {
  /** Indicates whether the path resolves to a regular file. */
  isFile: boolean;
  /** Indicates whether the path resolves to a directory. */
  isDirectory: boolean;
  /** Provides the creation timestamp in milliseconds since Unix epoch, when available. */
  birthtimeMs?: number;
  /** Provides the last modification timestamp in milliseconds since Unix epoch, when available. */
  mtimeMs?: number;
}

/**
 * Represents a directory entry returned by a directory listing operation.
 */
export interface FileSystemDirent {
  /** Stores the entry name relative to the parent directory. */
  name: string;
  /** Indicates whether the entry is a regular file. */
  isFile: boolean;
  /** Indicates whether the entry is a directory. */
  isDirectory: boolean;
}

/**
 * Defines file system operations required by the domain layer.
 */
export interface FileSystem {
  /** Checks whether a path currently exists on disk. */
  exists(path: string): boolean;
  /** Reads and returns UTF-8 text content from a file. */
  readText(filePath: string): string;
  /** Writes UTF-8 text content to a file, creating or replacing it. */
  writeText(filePath: string, content: string): void;
  /** Creates a directory at the provided path, optionally including parent directories. */
  mkdir(dirPath: string, options?: { recursive?: boolean }): void;
  /** Lists direct entries within the specified directory. */
  readdir(dirPath: string): FileSystemDirent[];
  /** Returns metadata for a path, or null when the path does not exist. */
  stat(path: string): FileSystemStat | null;
  /** Deletes a single file at the specified path. */
  unlink(filePath: string): void;
  /** Removes a file or directory path with optional recursive and force behavior. */
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}
