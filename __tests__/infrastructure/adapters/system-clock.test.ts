import { describe, expect, it } from "vitest";
import { createSystemClock } from "../../../src/infrastructure/adapters/system-clock.js";

describe("createSystemClock", () => {
  it("returns a Date from now", () => {
    const clock = createSystemClock();
    const value = clock.now();

    expect(value).toBeInstanceOf(Date);
    expect(Number.isFinite(value.getTime())).toBe(true);
  });

  it("returns ISO timestamp from nowIsoString", () => {
    const clock = createSystemClock();
    const value = clock.nowIsoString();

    expect(typeof value).toBe("string");
    expect(new Date(value).toISOString()).toBe(value);
  });
});
