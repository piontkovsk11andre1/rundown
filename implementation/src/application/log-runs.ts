import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type {
  ArtifactRunMetadata,
  ArtifactStore,
  Clock,
  ConfigDirResult,
  FileSystem,
} from "../domain/ports/index.js";
import { formatRelativeTimestamp } from "../domain/relative-time.js";
import { toCompactRunId } from "../domain/run-id.js";
import { EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { formatCliTimestamp } from "../domain/cli-timestamp.js";
import { formatNoItemsFound, pluralize } from "./run-task-utils.js";

/**
 * Dependencies required to list and render previously completed runs.
 */
export interface LogRunsDependencies {
  artifactStore: ArtifactStore;
  configDir: ConfigDirResult | undefined;
  fileSystem: FileSystem;
  clock: Clock;
  output: ApplicationOutputPort;
}

/**
 * Runtime options that control filtering and output formatting for `log-runs`.
 */
export interface LogRunsOptions {
  revertable: boolean;
  commandName?: string;
  limit?: number;
  json: boolean;
}

/**
 * Normalized record shape emitted by the command in text and JSON modes.
 */
interface LogRunEntry {
  runId: string;
  shortRunId: string;
  commandName: string;
  status: string;
  timestamp: string;
  relativeTime: string;
  taskSummary: string;
  source: string;
  snapshot: string;
  revertable: boolean;
  startedAt: string;
  completedAt?: string;
}

const NO_REVERTABLE_RUNS_BASE_MESSAGE = "No revertable runs found. Revertable runs must be completed with implementation snapshot metadata and a snapshot payload that still exists on disk.";
const MISSING_SNAPSHOT_PAYLOAD_MESSAGE = "Completed runs with snapshot metadata were found, but their snapshot payloads are missing on disk. Restore those snapshot directories or record new snapshots before retrying.";

/**
 * Creates the application service for listing completed runs.
 *
 * The returned function loads run artifacts, applies optional filters, and
 * emits either human-friendly log lines or a JSON payload for automation.
 */
export function createLogRuns(
  dependencies: LogRunsDependencies,
): (options: LogRunsOptions) => number {
  // Bind once so callers can pass the emitter around without losing context.
  const emit = dependencies.output.emit.bind(dependencies.output);

  return function logRuns(options: LogRunsOptions): number {
    const artifactBaseDir = dependencies.configDir?.configDir;
    const normalizedCommandFilter = normalizeOptionalLower(options.commandName);
    const now = dependencies.clock.now();

    // Keep only completed runs that satisfy command and revertability filters.
    const runs = dependencies.artifactStore
      .listSaved(artifactBaseDir)
      .filter((run) => run.status === "completed")
      .filter((run) => {
        if (!normalizedCommandFilter) {
          return true;
        }
        return run.commandName.toLowerCase() === normalizedCommandFilter;
      })
      .filter((run) => options.revertable ? isRevertableRun(run, dependencies.fileSystem) : true)
      .slice(0, options.limit);

    if (runs.length === 0) {
      if (options.revertable) {
        emit({ kind: "info", message: buildNoSnapshotRevertableRunsMessage(dependencies.artifactStore.listSaved(artifactBaseDir), dependencies.fileSystem) });
        return EXIT_CODE_NO_WORK;
      }

      // Mirror CLI behavior by reporting a friendly empty-state message.
      emit({ kind: "info", message: formatNoItemsFound("matching completed runs") });
      return EXIT_CODE_NO_WORK;
    }

    const entries = runs.map((run) => toLogRunEntry(run, now, dependencies.fileSystem));

    if (options.json) {
      // Preserve machine-readability for downstream scripting.
      emit({ kind: "text", text: JSON.stringify(entries.map(toJsonEntry), null, 2) });
      return EXIT_CODE_SUCCESS;
    }

    // Render one line per run for compact terminal viewing.
    for (const entry of entries) {
      emit({ kind: "text", text: formatLogLine(entry) });
    }

    emit({ kind: "info", message: entries.length + " " + pluralize(entries.length, "run", "runs") + " listed." });
    return EXIT_CODE_SUCCESS;
  };
}

/**
 * Converts persisted artifact metadata into a stable display model.
 */
function toLogRunEntry(run: ArtifactRunMetadata, now: Date, fileSystem: FileSystem): LogRunEntry {
  const revertable = isRevertableRun(run, fileSystem);
  const snapshot = formatSnapshotToken(run, fileSystem);
  // Prefer completion timestamp when present so relative time matches status.
  const timestamp = run.completedAt ?? run.startedAt;

  return {
    runId: run.runId,
    shortRunId: toCompactRunId(run.runId),
    commandName: run.commandName,
    status: run.status ?? "unknown",
    timestamp: formatCliTimestamp(timestamp),
    relativeTime: formatRelativeTimestamp(now, timestamp),
    taskSummary: summarizeTask(run.task?.text),
    source: formatSource(run),
    snapshot,
    revertable,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

/**
 * Formats a single run entry as a compact, pipe-delimited terminal line.
 */
function formatLogLine(entry: LogRunEntry): string {
  return [
    entry.shortRunId,
    formatTimestampToken(entry.timestamp, entry.relativeTime),
    `[${entry.status}]`,
    entry.taskSummary,
    `source=${entry.source}`,
    `command=${entry.commandName}`,
    `snapshot=${entry.snapshot}`,
    `revertable=${entry.revertable ? "yes" : "no"}`,
  ].join(" | ");
}

/**
 * Combines absolute and relative time into one compact token.
 */
function formatTimestampToken(absoluteTimestamp: string, relativeTimestamp: string): string {
  if (absoluteTimestamp === relativeTimestamp) {
    return absoluteTimestamp;
  }

  return `${absoluteTimestamp} (${relativeTimestamp})`;
}

/**
 * Determines whether a run can be reverted using snapshot-backed metadata.
 */
function isRevertableRun(run: ArtifactRunMetadata, fileSystem: FileSystem): boolean {
  if (run.status !== "completed") {
    return false;
  }

  const snapshotTargets = getSnapshotTargets(run);
  if (snapshotTargets.length === 0) {
    return false;
  }

  return snapshotTargets.some((target) => {
    const stat = fileSystem.stat(target.snapshotPath);
    return Boolean(stat?.isDirectory);
  });
}

/**
 * Produces a single-line task summary capped for terminal readability.
 */
function summarizeTask(taskText: string | undefined): string {
  if (!taskText) {
    return "(task metadata unavailable)";
  }

  const singleLine = taskText.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 80) {
    return singleLine;
  }

  return singleLine.slice(0, 77) + "...";
}

/**
 * Resolves the most specific available source reference for a run.
 */
function formatSource(run: ArtifactRunMetadata): string {
  if (run.task?.file && Number.isInteger(run.task.line) && run.task.line > 0) {
    return `${run.task.file}:${run.task.line}`;
  }

  if (run.task?.file) {
    return run.task.file;
  }

  if (typeof run.source === "string" && run.source.trim().length > 0) {
    return run.source;
  }

  return "(unknown source)";
}

/**
 * Normalizes optional CLI text filters into comparable lowercase values.
 */
function normalizeOptionalLower(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Produces the stable JSON output shape for automation clients.
 */
function toJsonEntry(entry: LogRunEntry): Omit<LogRunEntry, "timestamp"> {
  return {
    runId: entry.runId,
    shortRunId: entry.shortRunId,
    commandName: entry.commandName,
    status: entry.status,
    relativeTime: entry.relativeTime,
    taskSummary: entry.taskSummary,
    source: entry.source,
    snapshot: entry.snapshot,
    revertable: entry.revertable,
    startedAt: entry.startedAt,
    completedAt: entry.completedAt,
  };
}

interface SnapshotTarget {
  laneKind: "root" | "thread";
  threadSlug?: string;
  migrationNumber: number;
  snapshotPath: string;
}

function buildNoSnapshotRevertableRunsMessage(runs: ArtifactRunMetadata[], fileSystem: FileSystem): string {
  const completedRuns = runs.filter((run) => run.status === "completed");
  if (completedRuns.length === 0) {
    return formatNoItemsFound("matching completed runs");
  }

  const hasSnapshotMetadata = completedRuns.some((run) => getSnapshotTargets(run).length > 0);
  const hasExistingSnapshotPayload = completedRuns.some((run) => hasAnyExistingSnapshotPayload(run, fileSystem));
  if (hasSnapshotMetadata && !hasExistingSnapshotPayload) {
    return NO_REVERTABLE_RUNS_BASE_MESSAGE + " " + MISSING_SNAPSHOT_PAYLOAD_MESSAGE;
  }

  return NO_REVERTABLE_RUNS_BASE_MESSAGE;
}

function formatSnapshotToken(run: ArtifactRunMetadata, fileSystem: FileSystem): string {
  const snapshotTargets = getSnapshotTargets(run);
  if (snapshotTargets.length === 0) {
    return "-";
  }

  const hasExistingPayload = snapshotTargets.some((target) => {
    const stat = fileSystem.stat(target.snapshotPath);
    return Boolean(stat?.isDirectory);
  });

  if (!hasExistingPayload) {
    return "missing";
  }

  const selectedTarget = chooseDeterministicSnapshotTarget(snapshotTargets);
  if (!selectedTarget) {
    return "-";
  }

  return formatSnapshotTarget(selectedTarget);
}

function hasAnyExistingSnapshotPayload(run: ArtifactRunMetadata, fileSystem: FileSystem): boolean {
  return getSnapshotTargets(run).some((target) => {
    const stat = fileSystem.stat(target.snapshotPath);
    return Boolean(stat?.isDirectory);
  });
}

function getSnapshotTargets(run: ArtifactRunMetadata): SnapshotTarget[] {
  const raw = run.extra?.["implementationSnapshotTargets"];
  if (!Array.isArray(raw)) {
    return [];
  }

  const targets: SnapshotTarget[] = [];
  for (const value of raw) {
    if (!isSnapshotTargetRecord(value)) {
      continue;
    }

    const laneKind = normalizeLaneKind(value["laneKind"]);
    const snapshotPath = normalizeNonEmptyString(value["snapshotPath"]);
    const migrationNumber = normalizeMigrationNumber(value["migrationNumber"]);
    if (!laneKind || !snapshotPath || migrationNumber === null) {
      continue;
    }

    const threadSlug = normalizeOptionalNonEmptyString(value["threadSlug"]);
    if (laneKind === "thread" && !threadSlug) {
      continue;
    }

    targets.push({
      laneKind,
      ...(threadSlug ? { threadSlug } : {}),
      migrationNumber,
      snapshotPath,
    });
  }

  return targets;
}

function chooseDeterministicSnapshotTarget(targets: SnapshotTarget[]): SnapshotTarget | null {
  if (targets.length === 0) {
    return null;
  }

  const sorted = [...targets].sort((left, right) => {
    if (left.laneKind !== right.laneKind) {
      return left.laneKind === "root" ? -1 : 1;
    }

    const leftThread = left.threadSlug ?? "";
    const rightThread = right.threadSlug ?? "";
    if (leftThread !== rightThread) {
      return leftThread.localeCompare(rightThread);
    }

    if (left.migrationNumber !== right.migrationNumber) {
      return right.migrationNumber - left.migrationNumber;
    }

    return left.snapshotPath.localeCompare(right.snapshotPath);
  });

  return sorted[0] ?? null;
}

function formatSnapshotTarget(target: SnapshotTarget): string {
  if (target.laneKind === "thread") {
    return `thread:${target.threadSlug ?? "unknown"}:${target.migrationNumber}`;
  }

  return `root:${target.migrationNumber}`;
}

function isSnapshotTargetRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeLaneKind(value: unknown): "root" | "thread" | null {
  if (value === "root" || value === "thread") {
    return value;
  }

  return null;
}

function normalizeNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalNonEmptyString(value: unknown): string | undefined {
  const normalized = normalizeNonEmptyString(value);
  return normalized ?? undefined;
}

function normalizeMigrationNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
}
