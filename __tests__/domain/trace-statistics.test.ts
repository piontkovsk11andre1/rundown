import { describe, expect, it } from "vitest";
import { formatStatisticsLines, type TraceStatisticsSnapshot } from "../../src/domain/trace-statistics.ts";

const baseSnapshot: TraceStatisticsSnapshot = {
  fields: {
    total_time: 3_500,
    execution_time: 1_200,
    verify_time: 900,
    repair_time: 200,
    idle_time: 0,
    tokens_estimated: 429_391.2,
    phases_count: 3,
    verify_attempts: 2,
    repair_attempts: 1,
  },
};

describe("formatStatisticsLines", () => {
  it("returns empty output when fields are empty", () => {
    const result = formatStatisticsLines(baseSnapshot, []);
    expect(result).toEqual([]);
  });

  it("nests phase durations under total_time when total_time is present", () => {
    const result = formatStatisticsLines(baseSnapshot, [
      "total_time",
      "execution_time",
      "verify_time",
      "repair_time",
      "tokens_estimated",
    ]);

    expect(result).toEqual([
      "    - total time: 4s",
      "        - execution: 1s",
      "        - verify: <1s",
      "        - repair: <1s",
      "    - tokens estimated: 429391",
    ]);
  });

  it("keeps phase durations at top level when total_time is not requested", () => {
    const result = formatStatisticsLines(baseSnapshot, ["verify_time", "execution_time"]);

    expect(result).toEqual([
      "    - verify: <1s",
      "    - execution: 1s",
    ]);
  });

  it("preserves field order when total_time appears after phase fields", () => {
    const result = formatStatisticsLines(baseSnapshot, [
      "execution_time",
      "verify_time",
      "total_time",
      "repair_time",
    ]);

    expect(result).toEqual([
      "    - execution: 1s",
      "    - verify: <1s",
      "    - total time: 4s",
      "        - repair: <1s",
    ]);
  });

  it("omits zero-valued fields", () => {
    const result = formatStatisticsLines(baseSnapshot, ["idle_time", "verify_attempts"]);

    expect(result).toEqual([
      "    - verify attempts: 2",
    ]);
  });

  it("omits null-valued fields", () => {
    const snapshot: TraceStatisticsSnapshot = {
      fields: {
        ...baseSnapshot.fields,
        tokens_estimated: null,
        repair_attempts: null,
      },
    };

    const result = formatStatisticsLines(snapshot, [
      "tokens_estimated",
      "repair_attempts",
      "phases_count",
    ]);

    expect(result).toEqual([
      "    - phases: 3",
    ]);
  });

  it("ignores unknown fields and preserves configured order", () => {
    const result = formatStatisticsLines(baseSnapshot, [
      "tokens_estimated",
      "unknown_field",
      "phases_count",
    ]);

    expect(result).toEqual([
      "    - tokens estimated: 429391",
      "    - phases: 3",
    ]);
  });
});
