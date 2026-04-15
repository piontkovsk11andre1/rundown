import { afterEach, describe, expect, it, vi } from "vitest";
import { CLI_TIMESTAMP_FORMAT, formatCliTimestamp } from "../../src/domain/cli-timestamp.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cli-timestamp", () => {
  it("documents local ISO-8601 with numeric offset as the canonical CLI format", () => {
    expect(CLI_TIMESTAMP_FORMAT).toBe("Local ISO-8601 with numeric offset");
  });

  it("formats Date values as local ISO-8601 with numeric offset", () => {
    const value = new Date("2026-04-14T08:26:01.557Z");
    expect(formatCliTimestamp(value)).toBe(buildExpectedLocalIso(value));
  });

  it("normalizes parseable strings and preserves invalid values", () => {
    const value = "2026-04-14T08:26:01.557Z";
    expect(formatCliTimestamp(value)).toBe(buildExpectedLocalIso(new Date(value)));
    expect(formatCliTimestamp("not-a-date")).toBe("not-a-date");
  });

  it("keeps a deterministic ISO-like structure with explicit offset", () => {
    expect(formatCliTimestamp("2026-04-14T08:26:01.557Z")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/,
    );
  });

  it("renders non-hour local offsets using +/-HH:MM", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(-330);

    const formatted = formatCliTimestamp("2026-04-14T08:26:01.557Z");

    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+05:30$/);
  });

  it("renders west-of-UTC non-hour offsets with a negative sign", () => {
    vi.spyOn(Date.prototype, "getTimezoneOffset").mockReturnValue(210);

    const formatted = formatCliTimestamp("2026-04-14T08:26:01.557Z");

    expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}-03:30$/);
  });
});

function buildExpectedLocalIso(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, "0");
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  const hours = String(value.getHours()).padStart(2, "0");
  const minutes = String(value.getMinutes()).padStart(2, "0");
  const seconds = String(value.getSeconds()).padStart(2, "0");
  const milliseconds = String(value.getMilliseconds()).padStart(3, "0");

  const offsetMinutes = -value.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const offsetAbsoluteMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(offsetAbsoluteMinutes / 60)).padStart(2, "0");
  const offsetRemainderMinutes = String(offsetAbsoluteMinutes % 60).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${offsetSign}${offsetHours}:${offsetRemainderMinutes}`;
}
