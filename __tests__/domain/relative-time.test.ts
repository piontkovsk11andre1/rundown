import { describe, expect, it } from "vitest";
import { formatRelativeTimestamp } from "../../src/domain/relative-time.js";

describe("relative-time", () => {
  it("formats past timestamps", () => {
    const now = new Date("2026-03-28T12:00:00.000Z");

    expect(formatRelativeTimestamp(now, "2026-03-28T11:59:58.000Z")).toBe("just now");
    expect(formatRelativeTimestamp(now, "2026-03-28T11:59:10.000Z")).toBe("50s ago");
    expect(formatRelativeTimestamp(now, "2026-03-28T11:50:00.000Z")).toBe("10m ago");
    expect(formatRelativeTimestamp(now, "2026-03-28T09:00:00.000Z")).toBe("3h ago");
    expect(formatRelativeTimestamp(now, "2026-03-24T12:00:00.000Z")).toBe("4d ago");
  });

  it("formats future timestamps", () => {
    const now = new Date("2026-03-28T12:00:00.000Z");

    expect(formatRelativeTimestamp(now, "2026-03-28T12:00:30.000Z")).toBe("in 30s");
    expect(formatRelativeTimestamp(now, "2026-03-28T12:15:00.000Z")).toBe("in 15m");
    expect(formatRelativeTimestamp(now, "2026-03-30T12:00:00.000Z")).toBe("in 2d");
  });

  it("falls back to input for invalid timestamp", () => {
    const now = new Date("2026-03-28T12:00:00.000Z");
    expect(formatRelativeTimestamp(now, "not-a-date")).toBe("not-a-date");
  });
});
