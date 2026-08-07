import nodeFs from "node:fs";
import path from "node:path";
import type { TraceWriterPort } from "../../domain/ports/trace-writer-port.js";
import type { FileSystem } from "../../domain/ports/file-system.js";

/**
 * Creates a trace writer that persists each trace event as a JSON Lines record.
 *
 * The writer ensures the output directory exists on first write and then appends
 * newline-delimited JSON entries to the configured file path.
 */
export function createJsonlTraceWriter(filePath: string, fs: FileSystem): TraceWriterPort {
  // Tracks whether the destination directory has already been created.
  let parentDirectoryEnsured = false;

  return {
    write(event) {
      // Lazily create the parent directory to avoid redundant mkdir calls.
      if (!parentDirectoryEnsured) {
        const parentDirectory = path.dirname(filePath);
        fs.mkdir(parentDirectory, { recursive: true });
        parentDirectoryEnsured = true;
      }

      // Persist each event as one JSON object per line for easy streaming reads.
      nodeFs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, "utf-8");
    },
    // This writer performs synchronous writes, so no buffered flush is required.
    flush() {},
  };
}
