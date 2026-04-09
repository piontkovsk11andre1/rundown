import { stripAnsi } from "./services/string-utils.js";

/**
 * Current schema version for newline-delimited global output log entries.
 */
export const GLOBAL_OUTPUT_LOG_SCHEMA_VERSION = 1 as const;

/**
 * Literal schema version type derived from the exported version constant.
 */
export type GlobalOutputLogSchemaVersion = typeof GLOBAL_OUTPUT_LOG_SCHEMA_VERSION;

/**
 * Severity levels emitted in the global output log.
 */
export type GlobalOutputLogLevel = "info" | "warn" | "error";

/**
 * Output stream source associated with a log entry payload.
 */
export type GlobalOutputLogStream = "stdout" | "stderr";

/**
 * Event kinds captured in the global output log payload.
 */
export type GlobalOutputLogKind =
  | "info"
  | "warn"
  | "error"
  | "success"
  | "progress"
  | "task"
  | "text"
  | "stderr"
  | "cli-fatal"
  | "commander"
  | "group-start"
  | "group-end";

/**
 * Structured representation of a single global output log line.
 */
export interface GlobalOutputLogEntry {
  // ISO-like timestamp captured at emission time.
  ts: string;
  // Semantic severity associated with the event.
  level: GlobalOutputLogLevel;
  // Process stream that produced the message.
  stream: GlobalOutputLogStream;
  // Event discriminator for downstream classification.
  kind: GlobalOutputLogKind;
  // Human-readable output text after capture.
  message: string;
  // Executable name or command path that produced the output.
  command: string;
  // Raw process arguments for reproducibility.
  argv: string[];
  // Process working directory at execution time.
  cwd: string;
  // Operating-system process identifier.
  pid: number;
  // Rundown version associated with the emitting process.
  version: string;
  // Logical session identifier used to correlate related output.
  session_id: string;
}

/**
 * Serializes a sanitized log entry into one JSONL line.
 *
 * @param entry Raw global output log entry.
 * @returns Newline-terminated JSON representation safe for append-only logs.
 */
export function serializeGlobalOutputLogEntry(entry: GlobalOutputLogEntry): string {
  return `${JSON.stringify(sanitizeGlobalOutputLogEntry(entry))}\n`;
}

/**
 * Removes ANSI escape sequences from every string field in a log entry.
 *
 * This guarantees persisted logs stay plain text and machine-parseable,
 * even when subprocesses emit terminal control codes.
 *
 * @param entry Raw global output log entry.
 * @returns Sanitized entry with terminal escape codes stripped.
 */
export function sanitizeGlobalOutputLogEntry(entry: GlobalOutputLogEntry): GlobalOutputLogEntry {
  return {
    ts: stripAnsi(entry.ts),
    level: entry.level,
    stream: entry.stream,
    kind: stripAnsi(entry.kind) as GlobalOutputLogKind,
    message: stripAnsi(entry.message),
    command: stripAnsi(entry.command),
    argv: entry.argv.map((arg) => stripAnsi(arg)),
    cwd: stripAnsi(entry.cwd),
    pid: entry.pid,
    version: stripAnsi(entry.version),
    session_id: stripAnsi(entry.session_id),
  };
}
