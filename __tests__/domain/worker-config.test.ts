import { describe, expect, it } from "vitest";
import {
  applyTraceStatisticsDefaults,
  DEFAULT_TRACE_STATISTICS_FIELDS,
  type WorkerConfig,
} from "../../src/domain/worker-config.ts";

describe("applyTraceStatisticsDefaults", () => {
  it("enables default trace statistics when trace is active and config is missing", () => {
    const result = applyTraceStatisticsDefaults(undefined, true);

    expect(result).toEqual({
      traceStatistics: {
        enabled: true,
        fields: DEFAULT_TRACE_STATISTICS_FIELDS,
      },
    });
  });

  it("enables default trace statistics when trace is active and traceStatistics is absent", () => {
    const config: WorkerConfig = {
      workers: {
        default: ["opencode"],
      },
    };

    const result = applyTraceStatisticsDefaults(config, true);

    expect(result).toEqual({
      workers: {
        default: ["opencode"],
      },
      traceStatistics: {
        enabled: true,
        fields: DEFAULT_TRACE_STATISTICS_FIELDS,
      },
    });
  });

  it("does not apply defaults when trace is disabled", () => {
    const config: WorkerConfig = {
      workers: {
        default: ["opencode"],
      },
    };

    const result = applyTraceStatisticsDefaults(config, false);

    expect(result).toEqual(config);
    expect(result).toBe(config);
  });

  it("does not overwrite explicit traceStatistics config", () => {
    const config: WorkerConfig = {
      traceStatistics: {
        enabled: false,
        fields: ["total_time"],
      },
    };

    const result = applyTraceStatisticsDefaults(config, true);

    expect(result).toEqual(config);
    expect(result).toBe(config);
  });
});
