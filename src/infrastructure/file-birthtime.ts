import type { FileSystem } from "../domain/ports/file-system.js";

/**
 * Returns file creation time in milliseconds using the provided filesystem port.
 *
 * Falls back to `0` when metadata cannot be read so callers can continue with a
 * deterministic sentinel value instead of handling filesystem exceptions.
 */
export function getFileBirthtimeMs(
  filePath: string,
  fileSystem: Pick<FileSystem, "stat">,
): number {
  try {
    // Prefer the filesystem-reported birthtime and default to zero when absent.
    return fileSystem.stat(filePath)?.birthtimeMs ?? 0;
  } catch {
    // Treat stat failures as unknown birthtime to keep selection logic resilient.
    return 0;
  }
}
