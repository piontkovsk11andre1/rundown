import type { TraceWriterPort } from "../../domain/ports/trace-writer-port.js";

/**
 * Creates a trace writer that forwards each operation to all provided writers.
 *
 * This adapter lets the runtime fan out trace events to multiple destinations
 * (for example, console output and persisted artifacts) while exposing a single
 * `TraceWriterPort` implementation to callers.
 */
export function createFanoutTraceWriter(writers: TraceWriterPort[]): TraceWriterPort {
  return {
    write(event) {
      // Dispatch the trace event to every configured writer.
      for (const writer of writers) {
        writer.write(event);
      }
    },
    flush() {
      // Ensure each writer flushes any buffered trace output.
      for (const writer of writers) {
        writer.flush();
      }
    },
  };
}
