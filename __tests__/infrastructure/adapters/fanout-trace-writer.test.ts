import { describe, expect, it, vi } from "vitest";
import { createRunCompletedEvent } from "../../../src/domain/trace.js";
import { createFanoutTraceWriter } from "../../../src/infrastructure/adapters/fanout-trace-writer.js";

describe("createFanoutTraceWriter", () => {
  it("writes each event to every child writer", () => {
    const first = {
      write: vi.fn(),
      flush: vi.fn(),
    };
    const second = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    const writer = createFanoutTraceWriter([first, second]);
    const event = createRunCompletedEvent({
      timestamp: "2026-03-28T00:00:00.000Z",
      run_id: "run-1",
      payload: {
        status: "completed",
        total_duration_ms: 42,
        total_phases: 2,
      },
    });

    writer.write(event);

    expect(first.write).toHaveBeenCalledTimes(1);
    expect(first.write).toHaveBeenCalledWith(event);
    expect(second.write).toHaveBeenCalledTimes(1);
    expect(second.write).toHaveBeenCalledWith(event);
  });

  it("flushes every child writer", () => {
    const first = {
      write: vi.fn(),
      flush: vi.fn(),
    };
    const second = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    const writer = createFanoutTraceWriter([first, second]);
    writer.flush();

    expect(first.flush).toHaveBeenCalledTimes(1);
    expect(second.flush).toHaveBeenCalledTimes(1);
  });
});
