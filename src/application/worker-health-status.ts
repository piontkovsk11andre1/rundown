import type { ApplicationOutputPort, WorkerHealthStore } from "../domain/ports/index.js";
import type { WorkerConfigPort } from "../domain/ports/worker-config-port.js";
import type { ConfigDirResult } from "../domain/ports/config-dir-port.js";
import {
  evaluateWorkerHealthEligibility,
  normalizeWorkerCommandIdentity,
  normalizeWorkerHealthKey,
  type WorkerHealthEntry,
} from "../domain/worker-health.js";
import {
  resolveWorkerSelectionSnapshotForInvocation,
  type WorkerResolutionCandidateSnapshot,
} from "./resolve-worker.js";
import { EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";

export interface ViewWorkerHealthDependencies {
  workerHealthStore: WorkerHealthStore;
  workerConfigPort: WorkerConfigPort;
  configDir: ConfigDirResult | undefined;
  output: ApplicationOutputPort;
}

export interface ViewWorkerHealthOptions {
  json: boolean;
}

interface WorkerHealthStatusRecord {
  source: WorkerHealthEntry["source"];
  key: string;
  identity: string;
  status: WorkerHealthEntry["status"];
  eligible: boolean;
  reason: "healthy" | "cooling_down" | "unavailable";
  cooldownUntil?: string;
  cooldownRemainingSeconds?: number;
  lastFailureClass?: WorkerHealthEntry["lastFailureClass"];
  lastFailureAt?: string;
  lastSuccessAt?: string;
  failureCountWindow?: number;
}

interface WorkerFallbackCandidateStatus {
  workerCommand: string[];
  workerLabel: string;
  source: WorkerResolutionCandidateSnapshot["source"];
  fallbackIndex?: number;
  eligible: boolean;
  blockedBy: Array<"worker" | "profile">;
  nextEligibleAt?: string;
  profileName?: string;
  worker: {
    status: WorkerResolutionCandidateSnapshot["eligibility"]["worker"]["status"];
    eligible: boolean;
    reason: WorkerResolutionCandidateSnapshot["eligibility"]["worker"]["reason"];
    nextEligibleAt?: string;
  };
  profile: {
    status: WorkerResolutionCandidateSnapshot["eligibility"]["profile"]["status"];
    eligible: boolean;
    reason: WorkerResolutionCandidateSnapshot["eligibility"]["profile"]["reason"];
    nextEligibleAt?: string;
  };
}

interface WorkerFallbackStatusRecord {
  commandName: "run" | "discuss" | "plan" | "research" | "reverify";
  profileName?: string;
  selectedCandidateIndex: number;
  selectedWorkerCommand: string[];
  selectedWorkerLabel: string;
  candidates: WorkerFallbackCandidateStatus[];
}

interface WorkerHealthStatusPayload {
  generatedAt: string;
  filePath: string;
  configDir?: string;
  entries: WorkerHealthStatusRecord[];
  fallbackOrderSnapshots: WorkerFallbackStatusRecord[];
}

const WORKER_COMMAND_NAMES: ReadonlyArray<"run" | "discuss" | "plan" | "research" | "reverify"> = [
  "run",
  "discuss",
  "plan",
  "research",
  "reverify",
];

export function createViewWorkerHealthStatus(
  dependencies: ViewWorkerHealthDependencies,
): (options: ViewWorkerHealthOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return (options: ViewWorkerHealthOptions): number => {
    const configDirPath = dependencies.configDir?.configDir;
    const baseDir = configDirPath ?? process.cwd();
    const nowMs = Date.now();
    const snapshot = dependencies.workerHealthStore.read(baseDir);
    const entries = snapshot.entries
      .map((entry) => toStatusRecord(entry, nowMs))
      .sort(compareHealthRecords);
    const workerConfig = configDirPath
      ? dependencies.workerConfigPort.load(configDirPath)
      : undefined;
    const fallbackOrderSnapshots = WORKER_COMMAND_NAMES
      .map((commandName) => buildFallbackSnapshot(commandName, workerConfig, snapshot.entries, nowMs))
      .filter((value): value is WorkerFallbackStatusRecord => value !== null);

    const payload: WorkerHealthStatusPayload = {
      generatedAt: new Date(nowMs).toISOString(),
      filePath: dependencies.workerHealthStore.filePath(baseDir),
      entries,
      fallbackOrderSnapshots,
      ...(configDirPath ? { configDir: configDirPath } : {}),
    };

    if (options.json) {
      emit({ kind: "text", text: JSON.stringify(payload, null, 2) });
      return EXIT_CODE_SUCCESS;
    }

    emit({ kind: "text", text: "Worker health status" });
    emit({ kind: "text", text: "  store: " + payload.filePath });
    emit({ kind: "text", text: "  generatedAt: " + payload.generatedAt });
    if (payload.configDir) {
      emit({ kind: "text", text: "  configDir: " + payload.configDir });
    }

    emit({ kind: "text", text: "" });
    emit({ kind: "text", text: "Entries" });
    if (entries.length === 0) {
      emit({ kind: "text", text: "  (none)" });
    } else {
      for (const entry of entries) {
        emit({
          kind: "text",
          text: "  - [" + entry.source + "] " + entry.identity + " | status=" + entry.status + " | eligible=" + (entry.eligible ? "yes" : "no"),
        });
        if (entry.cooldownUntil) {
          const remaining = entry.cooldownRemainingSeconds;
          emit({
            kind: "text",
            text: "      cooldown: "
              + entry.cooldownUntil
              + (typeof remaining === "number" ? " (remaining ~" + remaining + "s)" : ""),
          });
        }
        if (entry.lastFailureClass || entry.lastFailureAt || entry.lastSuccessAt) {
          emit({
            kind: "text",
            text: "      lastFailureClass="
              + (entry.lastFailureClass ?? "n/a")
              + " | lastFailureAt="
              + (entry.lastFailureAt ?? "n/a")
              + " | lastSuccessAt="
              + (entry.lastSuccessAt ?? "n/a"),
          });
        }
      }
    }

    emit({ kind: "text", text: "" });
    emit({ kind: "text", text: "Fallback order snapshots" });
    if (fallbackOrderSnapshots.length === 0) {
      emit({ kind: "text", text: "  (no configured workers/fallbacks)" });
    } else {
      for (const snapshotRecord of fallbackOrderSnapshots) {
        emit({ kind: "text", text: "  - command=" + snapshotRecord.commandName + (snapshotRecord.profileName ? " profile=" + snapshotRecord.profileName : "") });
        emit({ kind: "text", text: "      selected: " + snapshotRecord.selectedWorkerLabel });
        for (const candidate of snapshotRecord.candidates) {
          const tag = candidate.source === "configured-fallback"
            ? "fallback#" + String(candidate.fallbackIndex ?? 1)
            : candidate.source;
          const blocked = candidate.blockedBy.length > 0
            ? " blockedBy=" + candidate.blockedBy.join("+")
            : "";
          const nextEligible = candidate.nextEligibleAt
            ? " nextEligibleAt=" + candidate.nextEligibleAt
            : "";
          emit({
            kind: "text",
            text: "      * ["
              + tag
              + "] "
              + candidate.workerLabel
              + " -> eligible="
              + (candidate.eligible ? "yes" : "no")
              + blocked
              + nextEligible,
          });
        }
      }
    }

    return EXIT_CODE_SUCCESS;
  };
}

function toStatusRecord(entry: WorkerHealthEntry, nowMs: number): WorkerHealthStatusRecord {
  const normalizedKey = normalizeWorkerHealthKey(entry.source, entry.key);
  const eligibility = evaluateWorkerHealthEligibility(entry, nowMs);
  const cooldownUntil = entry.cooldownUntil;
  const cooldownRemainingSeconds = cooldownUntil
    ? resolveCooldownRemainingSeconds(cooldownUntil, nowMs)
    : undefined;

  return {
    source: entry.source,
    key: normalizedKey,
    identity: formatHealthIdentity(entry.source, normalizedKey),
    status: entry.status,
    eligible: eligibility.eligible,
    reason: eligibility.reason,
    ...(cooldownUntil ? { cooldownUntil } : {}),
    ...(typeof cooldownRemainingSeconds === "number" ? { cooldownRemainingSeconds } : {}),
    ...(entry.lastFailureClass ? { lastFailureClass: entry.lastFailureClass } : {}),
    ...(entry.lastFailureAt ? { lastFailureAt: entry.lastFailureAt } : {}),
    ...(entry.lastSuccessAt ? { lastSuccessAt: entry.lastSuccessAt } : {}),
    ...(typeof entry.failureCountWindow === "number" ? { failureCountWindow: entry.failureCountWindow } : {}),
  };
}

function formatHealthIdentity(source: WorkerHealthEntry["source"], key: string): string {
  if (source === "profile") {
    const prefix = "profile:";
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  const prefix = "worker:";
  const payload = key.startsWith(prefix) ? key.slice(prefix.length) : key;
  const parsed = tryParseStringArray(payload);
  return parsed ? parsed.join(" ") : payload;
}

function tryParseStringArray(value: string): string[] | null {
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

function resolveCooldownRemainingSeconds(cooldownUntil: string, nowMs: number): number | undefined {
  const cooldownMs = Date.parse(cooldownUntil);
  if (!Number.isFinite(cooldownMs)) {
    return undefined;
  }

  const remainingMs = cooldownMs - nowMs;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1000) : 0;
}

function compareHealthRecords(left: WorkerHealthStatusRecord, right: WorkerHealthStatusRecord): number {
  if (left.source !== right.source) {
    return left.source.localeCompare(right.source);
  }

  return left.identity.localeCompare(right.identity);
}

function buildFallbackSnapshot(
  commandName: "run" | "discuss" | "plan" | "research" | "reverify",
  workerConfig: ReturnType<WorkerConfigPort["load"]> | undefined,
  entries: readonly WorkerHealthEntry[],
  nowMs: number,
): WorkerFallbackStatusRecord | null {
  const selection = resolveWorkerSelectionSnapshotForInvocation({
    commandName,
    workerConfig,
    source: "",
    cliWorkerCommand: [],
    workerHealthEntries: entries,
    evaluateWorkerHealthAtMs: nowMs,
  });

  if (selection.candidates.length === 0) {
    return null;
  }

  const selectedCandidate = selection.selectedCandidateIndex >= 0
    ? selection.candidates[selection.selectedCandidateIndex]
    : selection.candidates[0];

  return {
    commandName,
    ...(selection.effectiveProfileName ? { profileName: selection.effectiveProfileName } : {}),
    selectedCandidateIndex: selection.selectedCandidateIndex,
    selectedWorkerCommand: [...selection.workerCommand],
    selectedWorkerLabel: formatWorkerLabel(selection.workerCommand),
    candidates: selection.candidates.map((candidate) => ({
      workerCommand: [...candidate.workerCommand],
      workerLabel: formatWorkerLabel(candidate.workerCommand),
      source: candidate.source,
      fallbackIndex: candidate.fallbackIndex,
      eligible: candidate.eligibility.eligible,
      blockedBy: [...candidate.eligibility.blockedBy],
      nextEligibleAt: candidate.eligibility.nextEligibleAt,
      ...(selection.effectiveProfileName ? { profileName: selection.effectiveProfileName } : {}),
      worker: {
        status: candidate.eligibility.worker.status,
        eligible: candidate.eligibility.worker.eligible,
        reason: candidate.eligibility.worker.reason,
        ...(candidate.eligibility.worker.nextEligibleAt
          ? { nextEligibleAt: candidate.eligibility.worker.nextEligibleAt }
          : {}),
      },
      profile: {
        status: candidate.eligibility.profile.status,
        eligible: candidate.eligibility.profile.eligible,
        reason: candidate.eligibility.profile.reason,
        ...(candidate.eligibility.profile.nextEligibleAt
          ? { nextEligibleAt: candidate.eligibility.profile.nextEligibleAt }
          : {}),
      },
    })),
  };
}

function formatWorkerLabel(command: readonly string[]): string {
  const normalized = normalizeWorkerCommandIdentity([...command]);
  return normalized.length > 0 ? normalized.join(" ") : "(none)";
}
