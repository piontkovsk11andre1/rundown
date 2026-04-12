/**
 * Canonical worker execution result classes used for runtime health updates.
 */
export const WORKER_FAILURE_CLASS_USAGE_LIMIT = "usage_limit" as const;
export const WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE = "transport_unavailable" as const;
export const WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER = "execution_failure_other" as const;
export const WORKER_FAILURE_CLASS_SUCCESS = "success" as const;

/**
 * Runtime classification labels emitted after a worker attempt.
 */
export type WorkerFailureClass =
  | typeof WORKER_FAILURE_CLASS_USAGE_LIMIT
  | typeof WORKER_FAILURE_CLASS_TRANSPORT_UNAVAILABLE
  | typeof WORKER_FAILURE_CLASS_EXECUTION_FAILURE_OTHER
  | typeof WORKER_FAILURE_CLASS_SUCCESS;

/**
 * Persisted worker-health status values.
 */
export const WORKER_HEALTH_STATUS_HEALTHY = "healthy" as const;
export const WORKER_HEALTH_STATUS_COOLING_DOWN = "cooling_down" as const;
export const WORKER_HEALTH_STATUS_UNAVAILABLE = "unavailable" as const;

/**
 * Normalized status values for worker/profile health entries.
 */
export type WorkerHealthStatus =
  | typeof WORKER_HEALTH_STATUS_HEALTHY
  | typeof WORKER_HEALTH_STATUS_COOLING_DOWN
  | typeof WORKER_HEALTH_STATUS_UNAVAILABLE;

/**
 * Source scope for health records.
 */
export type WorkerHealthSource = "worker" | "profile";

/**
 * Persisted state for one worker- or profile-level health key.
 */
export interface WorkerHealthEntry {
  key: string;
  status: WorkerHealthStatus;
  lastFailureClass?: WorkerFailureClass;
  lastFailureAt?: string;
  cooldownUntil?: string;
  failureCountWindow?: number;
  lastSuccessAt?: string;
  source: WorkerHealthSource;
}

/**
 * Eligibility decision for one health entry at evaluation time.
 */
export interface WorkerHealthEligibility {
  eligible: boolean;
  status: WorkerHealthStatus;
  reason: "healthy" | "cooling_down" | "unavailable";
  nextEligibleAt?: string;
}

/**
 * Eligibility projection across worker-level and profile-level records.
 */
export interface WorkerProfileEligibilityEvaluation {
  worker: WorkerHealthEligibility;
  profile: WorkerHealthEligibility;
  eligible: boolean;
  blockedBy: WorkerHealthSource[];
  nextEligibleAt?: string;
}

/**
 * Evaluates whether a single health entry is eligible right now.
 */
export function evaluateWorkerHealthEligibility(
  entry: WorkerHealthEntry | undefined,
  nowMs: number = Date.now(),
): WorkerHealthEligibility {
  if (!entry || entry.status === WORKER_HEALTH_STATUS_HEALTHY) {
    return {
      eligible: true,
      status: WORKER_HEALTH_STATUS_HEALTHY,
      reason: "healthy",
    };
  }

  if (entry.status === WORKER_HEALTH_STATUS_UNAVAILABLE) {
    return {
      eligible: false,
      status: WORKER_HEALTH_STATUS_UNAVAILABLE,
      reason: "unavailable",
    };
  }

  const cooldownUntilMs = parseTimestampMs(entry.cooldownUntil);
  if (cooldownUntilMs !== undefined && cooldownUntilMs <= nowMs) {
    return {
      eligible: true,
      status: WORKER_HEALTH_STATUS_HEALTHY,
      reason: "healthy",
    };
  }

  return {
    eligible: false,
    status: WORKER_HEALTH_STATUS_COOLING_DOWN,
    reason: "cooling_down",
    nextEligibleAt: entry.cooldownUntil,
  };
}

/**
 * Evaluates combined eligibility for resolved worker/profile candidates.
 */
export function evaluateWorkerProfileEligibility(
  workerEntry: WorkerHealthEntry | undefined,
  profileEntry: WorkerHealthEntry | undefined,
  nowMs: number = Date.now(),
): WorkerProfileEligibilityEvaluation {
  const worker = evaluateWorkerHealthEligibility(workerEntry, nowMs);
  const profile = evaluateWorkerHealthEligibility(profileEntry, nowMs);

  const blockedBy: WorkerHealthSource[] = [];
  if (!worker.eligible) {
    blockedBy.push("worker");
  }
  if (!profile.eligible) {
    blockedBy.push("profile");
  }

  const nextEligibleAt = resolveNextEligibleAt(worker, profile);

  return {
    worker,
    profile,
    eligible: blockedBy.length === 0,
    blockedBy,
    nextEligibleAt,
  };
}

function resolveNextEligibleAt(
  worker: WorkerHealthEligibility,
  profile: WorkerHealthEligibility,
): string | undefined {
  const workerTime = parseTimestampMs(worker.nextEligibleAt);
  const profileTime = parseTimestampMs(profile.nextEligibleAt);

  if (workerTime === undefined && profileTime === undefined) {
    return undefined;
  }

  if (workerTime === undefined) {
    return profile.nextEligibleAt;
  }

  if (profileTime === undefined) {
    return worker.nextEligibleAt;
  }

  return workerTime >= profileTime ? worker.nextEligibleAt : profile.nextEligibleAt;
}

function parseTimestampMs(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
