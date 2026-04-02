import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type {
  ArtifactRunMetadata,
  ArtifactStore,
  Clock,
  ConfigDirResult,
} from "../domain/ports/index.js";
import pc from "picocolors";
import { formatRelativeTimestamp } from "../domain/relative-time.js";
import { toCompactRunId } from "../domain/run-id.js";

/**
 * Dependencies required to list and render previously completed runs.
 */
export interface LogRunsDependencies {
  artifactStore: ArtifactStore;
  configDir: ConfigDirResult | undefined;
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
  relativeTime: string;
  taskSummary: string;
  source: string;
  commitSha: string | null;
  shortCommitSha: string | null;
  revertable: boolean;
  startedAt: string;
  completedAt?: string;
}

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
      .filter((run) => options.revertable ? isRevertableRun(run) : true)
      .slice(0, options.limit);

    if (runs.length === 0) {
      // Mirror CLI behavior by reporting a friendly empty-state message.
      emit({ kind: "info", message: "No matching completed runs found." });
      return 0;
    }

    const entries = runs.map((run) => toLogRunEntry(run, now));

    if (options.json) {
      // Preserve machine-readability for downstream scripting.
      emit({ kind: "text", text: JSON.stringify(entries, null, 2) });
      return 0;
    }

    // Render one line per run for compact terminal viewing.
    for (const entry of entries) {
      emit({ kind: "text", text: formatLogLine(entry) });
    }

    return 0;
  };
}

/**
 * Converts persisted artifact metadata into a stable display model.
 */
function toLogRunEntry(run: ArtifactRunMetadata, now: Date): LogRunEntry {
  const commitSha = getCommitSha(run);
  const revertable = run.status === "completed" && commitSha !== null;
  // Prefer completion timestamp when present so relative time matches status.
  const timestamp = run.completedAt ?? run.startedAt;

  return {
    runId: run.runId,
    shortRunId: toCompactRunId(run.runId),
    commandName: run.commandName,
    status: run.status ?? "unknown",
    relativeTime: formatRelativeTimestamp(now, timestamp),
    taskSummary: summarizeTask(run.task?.text),
    source: formatSource(run),
    commitSha,
    shortCommitSha: commitSha ? shortCommitSha(commitSha) : null,
    revertable,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

/**
 * Formats a single run entry as a compact, pipe-delimited terminal line.
 */
function formatLogLine(entry: LogRunEntry): string {
  const line = [
    entry.shortRunId,
    entry.relativeTime,
    formatStatus(entry.status),
    entry.taskSummary,
    `source=${entry.source}`,
    `command=${entry.commandName}`,
    `sha=${entry.shortCommitSha ?? "-"}`,
    `revertable=${entry.revertable ? "yes" : "no"}`,
  ].join(" | ");

  return entry.revertable ? line : pc.dim(line);
}

/**
 * Applies consistent status coloring used by run list output.
 */
function formatStatus(status: string): string {
  const label = `[${status}]`;
  switch (status.toLowerCase()) {
    case "completed":
      return pc.green(label);
    case "failed":
      return pc.red(label);
    case "cancelled":
    case "canceled":
      return pc.yellow(label);
    default:
      return pc.blue(label);
  }
}

/**
 * Returns a short git SHA suitable for table-like command output.
 */
function shortCommitSha(sha: string): string {
  return sha.length <= 12 ? sha : sha.slice(0, 12);
}

/**
 * Extracts and sanitizes commit SHA metadata stored on a run artifact.
 */
function getCommitSha(run: ArtifactRunMetadata): string | null {
  const commitSha = run.extra?.["commitSha"];
  if (typeof commitSha !== "string") {
    return null;
  }

  const normalized = commitSha.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Determines whether a run can be reverted using git-backed metadata.
 */
function isRevertableRun(run: ArtifactRunMetadata): boolean {
  return run.status === "completed" && getCommitSha(run) !== null;
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
