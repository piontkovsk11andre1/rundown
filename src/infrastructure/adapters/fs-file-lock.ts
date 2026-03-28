import type { FileLock } from "../../domain/ports/file-lock.js";
import { createLockfileFileLock } from "../file-lock.js";

export function createFsFileLock(): FileLock {
  return createLockfileFileLock();
}
