import type { TraceEvent } from "../trace.js";

/**
 * Defines the trace output boundary used by tracing-enabled workflows.
 *
 * Implementations decide where trace events are written (for example, files,
 * in-memory buffers, or external sinks) while exposing a minimal append/flush
 * contract to domain orchestration code.
 */
export interface TraceWriterPort {
  // Appends a single trace event to the underlying trace sink.
  write(event: TraceEvent): void;
  // Flushes any buffered trace events to durable storage.
  flush(): void;
}
