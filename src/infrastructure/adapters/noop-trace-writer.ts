import type { TraceWriterPort } from "../../domain/ports/trace-writer-port.js";

/**
 * Creates a trace writer that intentionally discards all trace activity.
 *
 * This adapter is useful when tracing is optional and callers still require
 * a `TraceWriterPort` implementation with no side effects.
 */
export function createNoopTraceWriter(): TraceWriterPort {
  return {
    // Intentionally ignore emitted trace events.
    write() {},
    // No buffering is used, so flush is a deliberate no-op.
    flush() {},
  };
}
