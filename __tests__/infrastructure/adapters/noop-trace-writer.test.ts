import { describe, expect, it } from "vitest";
import { createRunCompletedEvent } from "../../../src/domain/trace.js";
import { createNoopTraceWriter } from "../../../src/infrastructure/adapters/noop-trace-writer.js";

describe("createNoopTraceWriter", () => {
  it("exposes write and flush methods", () => {
    const writer = createNoopTraceWriter();

    expect(typeof writer.write).toBe("function");
    expect(typeof writer.flush).toBe("function");
  });

  it("write and flush do not throw", () => {
    const writer = createNoopTraceWriter();

    expect(() =>
      writer.write(
        createRunCompletedEvent({
          timestamp: "2026-03-25T19:20:43.000Z",
          run_id: "run-1",
          payload: {
            status: "completed",
            total_duration_ms: 10,
            total_phases: 1,
          },
        }),
      ),
    ).not.toThrow();
    expect(() => writer.flush()).not.toThrow();
  });
});
