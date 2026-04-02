import nodeFs from "node:fs";
import path from "node:path";
import {
  serializeGlobalOutputLogEntry,
  type GlobalOutputLogEntry,
} from "../../domain/global-output-log.js";
import type { FileSystem } from "../../domain/ports/file-system.js";

/**
 * Writes serialized global output entries to a persistent sink.
 *
 * Implementations are intentionally best-effort and must not affect
 * the primary command execution flow when logging fails.
 */
export interface GlobalOutputLogWriter {
  /**
   * Appends a single global output entry to the backing log.
   */
  write(entry: GlobalOutputLogEntry): void;

  /**
   * Flushes buffered writes, if buffering is implemented.
   */
  flush(): void;
}

/**
 * Creates a filesystem-backed global output log writer.
 *
 * The writer ensures the parent directory exists before the first write,
 * then appends each serialized entry to `filePath` using UTF-8 encoding.
 * Errors are swallowed to preserve best-effort logging behavior.
 */
export function createGlobalOutputLogWriter(filePath: string, fs: FileSystem): GlobalOutputLogWriter {
  // Track whether the destination directory has already been created.
  let parentDirectoryEnsured = false;

  return {
    write(entry) {
      try {
        if (!parentDirectoryEnsured) {
          // Lazily create the log directory to avoid unnecessary filesystem work.
          fs.mkdir(path.dirname(filePath), { recursive: true });
          parentDirectoryEnsured = true;
        }

        // Append each entry as an independent record to preserve chronological order.
        nodeFs.appendFileSync(filePath, serializeGlobalOutputLogEntry(entry), {
          encoding: "utf-8",
          flag: "a",
        });
      } catch {
        // best-effort logging: never interrupt command flow on log write failures
      }
    },
    // This implementation writes synchronously, so there is nothing to flush.
    flush() {},
  };
}
