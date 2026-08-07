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

const WORKER_KEY_PREFIX = "worker:";
const PROFILE_KEY_PREFIX = "profile:";
const WORKER_KEY_EXECUTABLE_EXTENSIONS = [".cmd", ".exe", ".bat", ".ps1"];

/**
 * Normalizes profile identity text for stable health-key construction.
 */
export function normalizeProfileIdentity(profileName: string): string {
  return profileName.trim().replace(/\s+/g, " ");
}

/**
 * Normalizes worker command tokens so equivalent forms map to the same identity.
 */
export function normalizeWorkerCommandIdentity(command: readonly string[]): string[] {
  const normalizedTokens: string[] = [];

  for (const rawToken of command) {
    const token = normalizeToken(rawToken);
    if (token.length === 0) {
      continue;
    }

    const splitFlag = splitLongFlagWithEquals(token);
    if (!splitFlag) {
      normalizedTokens.push(token);
      continue;
    }

    normalizedTokens.push(splitFlag.flag);
    const normalizedFlagValue = normalizeToken(splitFlag.value);
    if (normalizedFlagValue.length > 0) {
      normalizedTokens.push(normalizedFlagValue);
    }
  }

  if (normalizedTokens.length === 0) {
    return [];
  }

  normalizedTokens[0] = normalizeExecutableToken(normalizedTokens[0]!);
  return normalizedTokens;
}

/**
 * Builds a canonical worker-level key from a worker command.
 */
export function buildWorkerHealthWorkerKey(command: readonly string[]): string {
  return WORKER_KEY_PREFIX + JSON.stringify(normalizeWorkerCommandIdentity(command));
}

/**
 * Builds a canonical profile-level key from a profile name.
 */
export function buildWorkerHealthProfileKey(profileName: string): string {
  return PROFILE_KEY_PREFIX + normalizeProfileIdentity(profileName);
}

/**
 * Normalizes persisted keys according to source scope.
 */
export function normalizeWorkerHealthKey(source: WorkerHealthSource, key: string): string {
  if (source === "profile") {
    return normalizeProfileHealthKey(key);
  }

  return normalizeWorkerHealthWorkerKey(key);
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

function normalizeWorkerHealthWorkerKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const withoutPrefix = trimmed.toLowerCase().startsWith(WORKER_KEY_PREFIX)
    ? trimmed.slice(WORKER_KEY_PREFIX.length)
    : trimmed;
  const parsed = tryParseWorkerKeyPayload(withoutPrefix);

  if (parsed) {
    return buildWorkerHealthWorkerKey(parsed);
  }

  return buildWorkerHealthWorkerKey([withoutPrefix]);
}

function normalizeProfileHealthKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const withoutPrefix = trimmed.toLowerCase().startsWith(PROFILE_KEY_PREFIX)
    ? trimmed.slice(PROFILE_KEY_PREFIX.length)
    : trimmed;
  const normalized = normalizeProfileIdentity(withoutPrefix);
  return normalized.length > 0 ? buildWorkerHealthProfileKey(normalized) : "";
}

function tryParseWorkerKeyPayload(value: string): string[] | null {
  if (!value.startsWith("[") || !value.endsWith("]")) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.some((token) => typeof token !== "string")) {
      return null;
    }

    return parsed as string[];
  } catch {
    return null;
  }
}

function splitLongFlagWithEquals(token: string): { flag: string; value: string } | null {
  if (!token.startsWith("--")) {
    return null;
  }

  const separatorIndex = token.indexOf("=");
  if (separatorIndex <= 2) {
    return null;
  }

  return {
    flag: token.slice(0, separatorIndex),
    value: token.slice(separatorIndex + 1),
  };
}

function normalizeExecutableToken(token: string): string {
  const normalizedPath = token.replaceAll("\\", "/");
  const rawBaseName = normalizedPath.includes("/")
    ? normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1)
    : normalizedPath;

  const loweredBaseName = rawBaseName.toLowerCase();
  for (const extension of WORKER_KEY_EXECUTABLE_EXTENSIONS) {
    if (loweredBaseName.endsWith(extension)) {
      return loweredBaseName.slice(0, loweredBaseName.length - extension.length);
    }
  }

  return loweredBaseName;
}

function normalizeToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}
