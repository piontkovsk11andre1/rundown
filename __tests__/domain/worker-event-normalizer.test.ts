import { describe, expect, it } from "vitest";
import {
  normalizeWorkerJsonEvent,
  parseWorkerJsonEventsFromChunk,
} from "../../src/domain/worker-event-normalizer.js";

describe("worker-event-normalizer", () => {
  it("normalizes file tool events from common JSON fields", () => {
    const event = normalizeWorkerJsonEvent({
      type: "tool.started",
      provider: "opencode",
      tool: "Read",
      input: { path: "src/app.ts" },
    });

    expect(event).toMatchObject({
      provider: "opencode",
      kind: "file",
      action: "started",
      name: "Read",
      file_path: "src/app.ts",
    });
  });

  it("normalizes command events and ignores non-json lines", () => {
    const events = parseWorkerJsonEventsFromChunk([
      "plain text",
      JSON.stringify({ type: "tool.completed", tool: "Bash", input: { command: "npm test" }, durationMs: 42 }),
      "",
    ].join("\n"));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "command",
      action: "finished",
      name: "Bash",
      command: "npm test",
      duration_ms: 42,
    });
  });

  it("normalizes thinking events", () => {
    const event = normalizeWorkerJsonEvent({
      event_type: "thinking.finished",
      status: "completed",
    });

    expect(event).toMatchObject({
      kind: "thinking",
      action: "finished",
      status: "completed",
    });
  });
});
