import type { TraceWriterPort } from "../../domain/ports/trace-writer-port.js";

export function createFanoutTraceWriter(writers: TraceWriterPort[]): TraceWriterPort {
  return {
    write(event) {
      for (const writer of writers) {
        writer.write(event);
      }
    },
    flush() {
      for (const writer of writers) {
        writer.flush();
      }
    },
  };
}
