import { describe, expect, it } from "vitest";
import { toCompactRunId } from "../../src/domain/run-id.js";

describe("run-id", () => {
  it("returns run ID unchanged when length is 16 or less", () => {
    expect(toCompactRunId("run-123")).toBe("run-123");
    expect(toCompactRunId("1234567890abcdef")).toBe("1234567890abcdef");
  });

  it("truncates run ID to 16 characters for compact display", () => {
    expect(toCompactRunId("run-20260328T120000000Z-aaaaaaaa")).toBe("run-20260328T120");
  });
});
