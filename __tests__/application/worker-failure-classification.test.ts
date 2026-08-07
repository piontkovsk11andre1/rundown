import { describe, expect, it } from "vitest";
import { classifyWorkerFailure } from "../../src/application/worker-failure-classification.js";
import {
  WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER,
  WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
  WORKER_FAILURE_CLASS_USAGE_LIMIT,
} from "../../src/domain/worker-health.js";
import { RUN_REASON_USAGE_LIMIT_DETECTED } from "../../src/domain/run-reasons.js";

describe("classifyWorkerFailure", () => {
  it("classifies usage-limit failures from explicit signals", () => {
    expect(classifyWorkerFailure({ usageLimitDetected: true })).toBe(WORKER_FAILURE_CLASS_USAGE_LIMIT);
    expect(classifyWorkerFailure({ runReason: RUN_REASON_USAGE_LIMIT_DETECTED })).toBe(WORKER_FAILURE_CLASS_USAGE_LIMIT);
  });

  it("does not classify raw output text alone as usage_limit without an explicit signal", () => {
    expect(classifyWorkerFailure({
      exitCode: 1,
      message: "HTTP 429 Too Many Requests",
    })).toBe(WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER);
  });

  it("classifies transport-unavailable failures from interrupted execution and transport patterns", () => {
    expect(classifyWorkerFailure({ exitCode: null })).toBe(WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE);
    expect(classifyWorkerFailure({ stderr: "connection reset by peer" })).toBe(WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE);
    expect(classifyWorkerFailure({ message: "worker timed out waiting for response" })).toBe(WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE);
  });

  it("classifies unmatched failures as execution_failure_other", () => {
    expect(classifyWorkerFailure({
      exitCode: 1,
      message: "TypeScript build failed with syntax errors",
      stderr: "error TS1005: ';' expected.",
    })).toBe(WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER);
  });
});
