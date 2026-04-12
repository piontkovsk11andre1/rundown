import { describe, expect, it } from "vitest";
import {
  evaluateWorkerHealthEligibility,
  evaluateWorkerProfileEligibility,
  WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER,
  WORKER_FAILURE_CLASS_SUCCESS,
  WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
  WORKER_FAILURE_CLASS_USAGE_LIMIT,
  WORKER_HEALTH_STATUS_COOLING_DOWN,
  WORKER_HEALTH_STATUS_HEALTHY,
  WORKER_HEALTH_STATUS_UNAVAILABLE,
  type WorkerFailureClass,
  type WorkerHealthEntry,
} from "../../src/domain/worker-health.ts";

describe("worker-health domain", () => {
  it("exposes canonical failure class values", () => {
    const values: WorkerFailureClass[] = [
      WORKER_FAILURE_CLASS_USAGE_LIMIT,
      WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE,
      WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER,
      WORKER_FAILURE_CLASS_SUCCESS,
    ];

    expect(values).toEqual([
      "usage_limit",
      "transport_unavailable",
      "execution_failure_other",
      "success",
    ]);
  });

  it("treats missing entries as healthy and eligible", () => {
    expect(evaluateWorkerHealthEligibility(undefined)).toEqual({
      eligible: true,
      status: WORKER_HEALTH_STATUS_HEALTHY,
      reason: "healthy",
    });
  });

  it("keeps cooling-down entries ineligible until cooldown ends", () => {
    const entry: WorkerHealthEntry = {
      key: "worker:primary",
      source: "worker",
      status: WORKER_HEALTH_STATUS_COOLING_DOWN,
      cooldownUntil: "2026-04-12T09:00:10.000Z",
    };

    expect(evaluateWorkerHealthEligibility(entry, Date.parse("2026-04-12T09:00:00.000Z"))).toEqual({
      eligible: false,
      status: WORKER_HEALTH_STATUS_COOLING_DOWN,
      reason: "cooling_down",
      nextEligibleAt: "2026-04-12T09:00:10.000Z",
    });
  });

  it("treats expired cooldown entries as eligible", () => {
    const entry: WorkerHealthEntry = {
      key: "worker:primary",
      source: "worker",
      status: WORKER_HEALTH_STATUS_COOLING_DOWN,
      cooldownUntil: "2026-04-12T09:00:10.000Z",
    };

    expect(evaluateWorkerHealthEligibility(entry, Date.parse("2026-04-12T09:00:20.000Z"))).toEqual({
      eligible: true,
      status: WORKER_HEALTH_STATUS_HEALTHY,
      reason: "healthy",
    });
  });

  it("marks unavailable entries as ineligible", () => {
    const entry: WorkerHealthEntry = {
      key: "worker:primary",
      source: "worker",
      status: WORKER_HEALTH_STATUS_UNAVAILABLE,
    };

    expect(evaluateWorkerHealthEligibility(entry)).toEqual({
      eligible: false,
      status: WORKER_HEALTH_STATUS_UNAVAILABLE,
      reason: "unavailable",
    });
  });

  it("evaluates combined worker/profile eligibility and next-eligible time", () => {
    const workerEntry: WorkerHealthEntry = {
      key: "worker:primary",
      source: "worker",
      status: WORKER_HEALTH_STATUS_COOLING_DOWN,
      cooldownUntil: "2026-04-12T09:00:10.000Z",
    };
    const profileEntry: WorkerHealthEntry = {
      key: "profile:verify",
      source: "profile",
      status: WORKER_HEALTH_STATUS_COOLING_DOWN,
      cooldownUntil: "2026-04-12T09:00:30.000Z",
    };

    expect(
      evaluateWorkerProfileEligibility(
        workerEntry,
        profileEntry,
        Date.parse("2026-04-12T09:00:00.000Z"),
      ),
    ).toEqual({
      worker: {
        eligible: false,
        status: WORKER_HEALTH_STATUS_COOLING_DOWN,
        reason: "cooling_down",
        nextEligibleAt: "2026-04-12T09:00:10.000Z",
      },
      profile: {
        eligible: false,
        status: WORKER_HEALTH_STATUS_COOLING_DOWN,
        reason: "cooling_down",
        nextEligibleAt: "2026-04-12T09:00:30.000Z",
      },
      eligible: false,
      blockedBy: ["worker", "profile"],
      nextEligibleAt: "2026-04-12T09:00:30.000Z",
    });
  });
});
