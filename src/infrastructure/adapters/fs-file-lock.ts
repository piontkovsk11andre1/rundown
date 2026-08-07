import type { FileLock } from "../../domain/ports/file-lock.js";
import { createLockfileFileLock } from "../file-lock.js";

/**
 * Creates the filesystem-backed file lock adapter.
 *
 * This adapter satisfies the domain `FileLock` port by reusing the shared
 * lockfile-based implementation from the infrastructure layer.
 */
export function createFsFileLock(): FileLock {
  // Delegates to the lockfile implementation used across infrastructure modules.
  return createLockfileFileLock();
}
