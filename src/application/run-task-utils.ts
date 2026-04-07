import type { Task } from "../domain/parser.js";
import type { ArtifactRunMetadata } from "../domain/ports/artifact-store.js";

/**
 * Safely parses a JSON string and returns null when parsing fails.
 */
export function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/**
 * Converts an unknown value into a normalized array of non-empty strings.
 */
export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Converts an unknown value to a non-negative integer.
 *
 * Non-numeric values default to zero.
 */
export function asNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }

  return 0;
}

/**
 * Returns a trimmed string enum value when it matches one of the allowed options.
 *
 * Falls back to the provided default when the input is invalid.
 */
export function asEnum<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim() as T;
  return options.includes(normalized) ? normalized : fallback;
}

/**
 * Counts lines in trace text using both Unix and Windows newline formats.
 */
export function countTraceLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return text.split(/\r?\n/).length;
}

/**
 * Computes elapsed time in milliseconds between two ISO-like timestamp strings.
 *
 * Invalid or missing timestamps yield zero.
 */
export function computeDurationMs(startedAt: string | undefined, completedAt: string | undefined): number {
  if (!startedAt || !completedAt) {
    return 0;
  }

  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);

  if (Number.isNaN(started) || Number.isNaN(completed)) {
    return 0;
  }

  return Math.max(0, completed - started);
}

/**
 * Builds a stable task label for logs and diagnostics.
 */
export function formatTaskLabel(taskOrRun: Task | ArtifactRunMetadata): string {
  if ("runId" in taskOrRun) {
    if (!taskOrRun.task) {
      return "(task metadata unavailable)";
    }

    return `${taskOrRun.task.file}:${taskOrRun.task.line} [#${taskOrRun.task.index}] ${taskOrRun.task.text}`;
  }

  return `${taskOrRun.file}:${taskOrRun.line} [#${taskOrRun.index}] ${taskOrRun.text}`;
}

/**
 * Compares file paths with platform-aware case sensitivity.
 */
export function isSameFilePath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    // Windows file systems are commonly case-insensitive.
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

/**
 * Checks whether command arguments contain a long option, including `--key=value` form.
 */
export function hasLongOption(args: string[], option: string): boolean {
  return args.some((arg) => arg === option || arg.startsWith(option + "="));
}

/**
 * Checks whether any long-option variant is present in command arguments.
 */
export function hasLongOptionVariant(args: string[], options: string[]): boolean {
  return options.some((option) => hasLongOption(args, option));
}

/**
 * Returns singular or plural noun form based on count.
 */
export function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}
