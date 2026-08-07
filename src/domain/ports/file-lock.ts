/**
 * Captures command metadata written alongside a lock file.
 */
export interface FileLockMetadata {
  // Command line used to acquire the lock.
  command: string;
}

/**
 * Describes the process that currently owns a lock.
 */
export interface FileLockHolder {
  // Process identifier of the lock owner.
  pid: number;
  // Command line reported by the lock owner.
  command: string;
  // ISO timestamp indicating when the lock owner started.
  startTime: string;
}

/**
 * Represents an error raised when lock acquisition fails due to an active owner.
 */
export class FileLockError extends Error {
  // Metadata describing the process that currently holds the lock.
  readonly holder: FileLockHolder;
  // Path to the file that is currently locked.
  readonly filePath: string;

  /**
   * Builds a lock error for the specified file and active lock holder.
   */
  constructor(filePath: string, holder: FileLockHolder, message?: string) {
    super(
      message ??
        `File is locked: ${filePath} (held by pid=${holder.pid}, command=${holder.command}, startTime=${holder.startTime})`,
    );
    this.name = "FileLockError";
    this.filePath = filePath;
    this.holder = holder;
  }
}

/**
 * Defines file lock lifecycle operations used to coordinate concurrent access.
 */
export interface FileLock {
  /** Acquires a lock for the provided file path using command metadata. */
  acquire(filePath: string, meta: FileLockMetadata): void;
  /** Returns true when the provided file path is currently locked. */
  isLocked(filePath: string): boolean;
  /** Releases an existing lock for the provided file path. */
  release(filePath: string): void;
  /** Forces release of a lock even when ownership checks are bypassed. */
  forceRelease(filePath: string): void;
  /** Releases every lock currently owned by the implementation instance. */
  releaseAll(): void;
}
