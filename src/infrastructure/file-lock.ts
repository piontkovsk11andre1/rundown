import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import { FileLockError, type FileLock, type FileLockHolder, type FileLockMetadata } from "../domain/ports/file-lock.js";

interface LockfilePayload {
  pid: number;
  command: string;
  startedAt: string;
  file: string;
}

/**
 * Creates a file-lock implementation backed by lockfiles on disk.
 *
 * The returned lock tracks lockfiles created by the current process so they can
 * be released individually or in bulk during shutdown.
 */
export function createLockfileFileLock(): FileLock {
  // Track only locks acquired by this process for safe ownership-aware release.
  const heldLocks = new Map<string, string>();

  return {
    acquire(filePath, meta) {
      const sourcePath = normalizePath(filePath);
      const lockPath = lockfilePathFor(sourcePath);
      const holder: FileLockHolder = {
        pid: process.pid,
        command: meta.command,
        startTime: new Date().toISOString(),
      };

      try {
        ensureDirectory(path.dirname(lockPath));
      } catch (error) {
        throw wrapLockIoError(sourcePath, lockPath, "prepare", error);
      }

      for (;;) {
        try {
          createLockfile(lockPath, {
            pid: holder.pid,
            command: holder.command,
            startedAt: holder.startTime,
            file: sourcePath,
          });
          heldLocks.set(sourcePath, lockPath);
          return;
        } catch (error) {
          if (!isNodeError(error) || error.code !== "EEXIST") {
            throw wrapLockIoError(sourcePath, lockPath, "acquire", error);
          }

          // Recover stale lockfiles left by processes that are no longer running.
          const existingHolder = readLockHolder(lockPath);
          if (existingHolder !== null && !isProcessRunning(existingHolder.pid)) {
            releaseLockfile(lockPath);
            continue;
          }

          throw new FileLockError(sourcePath, existingHolder ?? unknownHolder(), buildHeldLockMessage(sourcePath, existingHolder));
        }
      }
    },
    isLocked(filePath) {
      const sourcePath = normalizePath(filePath);
      const lockPath = lockfilePathFor(sourcePath);

      if (!fs.existsSync(lockPath)) {
        return false;
      }

      const holder = readLockHolder(lockPath);
      return holder !== null && isProcessRunning(holder.pid);
    },
    release(filePath) {
      const sourcePath = normalizePath(filePath);
      const lockPath = heldLocks.get(sourcePath);
      if (!lockPath) {
        return;
      }

      releaseLockfileIfOwnedByCurrentProcess(lockPath);
      heldLocks.delete(sourcePath);
    },
    forceRelease(filePath) {
      const sourcePath = normalizePath(filePath);
      const lockPath = lockfilePathFor(sourcePath);

      releaseLockfile(lockPath);
      heldLocks.delete(sourcePath);
    },
    releaseAll() {
      const sourcePaths = Array.from(heldLocks.keys());
      // Release via the public path to preserve ownership checks.
      for (const sourcePath of sourcePaths) {
        this.release(sourcePath);
      }
    },
  };
}

/**
 * Builds the lockfile path for a given source file.
 *
 * Lockfiles are stored in the source file's local config directory to keep lock
 * metadata colocated with the file being protected.
 */
export function lockfilePathFor(filePath: string): string {
  const sourcePath = normalizePath(filePath);
  const sourceDirectory = path.dirname(sourcePath);
  const sourceName = path.basename(sourcePath);
  return path.join(sourceDirectory, CONFIG_DIR_NAME, `${sourceName}.lock`);
}

/**
 * Creates a lockfile atomically and writes holder metadata to disk.
 *
 * If writing fails after file creation, this function attempts cleanup so a
 * partial lockfile does not block future lock attempts.
 */
function createLockfile(lockPath: string, payload: LockfilePayload): void {
  const lockFd = fs.openSync(lockPath, "wx");
  try {
    fs.writeFileSync(lockFd, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  } catch (error) {
    try {
      fs.closeSync(lockFd);
    } catch {
      // Ignore close failures while recovering from write errors.
    }
    releaseLockfile(lockPath);
    throw error;
  }
  fs.closeSync(lockFd);
}

/**
 * Reads and validates lockfile metadata.
 *
 * Returns `null` for unreadable or malformed lockfiles so callers can treat the
 * lock owner as unknown without crashing lock operations.
 */
function readLockHolder(lockPath: string): FileLockHolder | null {
  let raw = "";
  try {
    raw = fs.readFileSync(lockPath, "utf-8");
  } catch {
    return null;
  }

  const parsed = safeJsonParse(raw);
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }

  const candidate = parsed as Partial<LockfilePayload> & Partial<FileLockHolder>;
  if (typeof candidate.pid !== "number" || !Number.isInteger(candidate.pid) || candidate.pid <= 0) {
    return null;
  }
  if (typeof candidate.command !== "string" || candidate.command.trim() === "") {
    return null;
  }

  // Accept legacy and current timestamp keys for backward compatibility.
  const startTime =
    typeof candidate.startedAt === "string" && candidate.startedAt.trim() !== ""
      ? candidate.startedAt
      : typeof candidate.startTime === "string" && candidate.startTime.trim() !== ""
        ? candidate.startTime
        : null;
  if (startTime === null) {
    return null;
  }

  return {
    pid: candidate.pid,
    command: candidate.command,
    startTime,
  };
}

/**
 * Parses JSON without throwing, returning `null` for invalid payloads.
 */
function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Ensures the lockfile directory exists before lock creation.
 */
function ensureDirectory(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Removes a lockfile if it exists.
 *
 * Missing files are ignored to keep release paths idempotent.
 */
function releaseLockfile(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

/**
 * Releases a lockfile only when it is owned by the current process.
 */
function releaseLockfileIfOwnedByCurrentProcess(lockPath: string): void {
  const holder = readLockHolder(lockPath);
  if (!holder || holder.pid !== process.pid) {
    return;
  }

  releaseLockfile(lockPath);
}

/**
 * Builds a user-facing message that describes the lock holder when known.
 */
function buildHeldLockMessage(filePath: string, holder: FileLockHolder | null): string {
  if (!holder) {
    return `File is locked: ${filePath}`;
  }

  return `File is locked: ${filePath} (held by pid=${holder.pid}, command=${holder.command}, startTime=${holder.startTime})`;
}

/**
 * Returns a placeholder holder when lock metadata cannot be determined.
 */
function unknownHolder(): FileLockHolder {
  return {
    pid: -1,
    command: "unknown",
    startTime: "unknown",
  };
}

/**
 * Checks whether a process appears to be alive.
 *
 * Uses signal `0`, which performs existence/permission checks without
 * terminating the process.
 */
function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (!isNodeError(error)) {
      return false;
    }

    // EPERM indicates the process exists but cannot be signaled by this user.
    if (error.code === "EPERM") {
      return true;
    }

    return false;
  }
}

/**
 * Normalizes paths to absolute form so lock keys remain stable.
 */
function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

/**
 * Wraps permission-related filesystem errors with lock-specific context.
 */
function wrapLockIoError(
  filePath: string,
  lockPath: string,
  action: "prepare" | "acquire",
  error: unknown,
): unknown {
  if (!isNodeError(error)) {
    return error;
  }

  const code = error.code;
  if (code !== "EACCES" && code !== "EPERM" && code !== "EROFS") {
    return error;
  }

  const actionLabel = action === "prepare" ? "prepare lock directory" : "acquire lockfile";
  const detail = code === "EROFS"
    ? "The filesystem appears to be read-only."
    : "Permission was denied while writing lock metadata.";

  const wrapped = new Error(
    `Unable to ${actionLabel} for source file: ${filePath} (lockfile: ${lockPath}, code: ${code}). ${detail}`,
    { cause: error },
  );

  wrapped.name = "FileLockIoError";
  return wrapped;
}

/**
 * Type guard for Node.js-style I/O errors with optional `code` values.
 */
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
