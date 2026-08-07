/**
 * Shared types for worker output similarity detection.
 *
 * Function implementations are added in follow-up tasks.
 */
import { stripAnsi } from "./string-utils.js";

const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:z|[+-]\d{2}:?\d{2})\b/gi;
const DATETIME_PATTERN = /\b\d{4}-\d{2}-\d{2}[ t]\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g;

export interface WorkerOutputPair {
  left: string;
  right: string;
}

export interface WorkerPhaseOutputs {
  execution?: string;
  verification?: string;
  repair?: string;
}

export interface OutputSimilarityOptions {
  minLength?: number;
}

export const DEFAULT_OUTPUT_SIMILARITY_MIN_LENGTH = 50;

const KNOWN_USAGE_LIMIT_PATTERNS: RegExp[] = [
  /\brate\s*limit(?:ed|s)?\b/i,
  /\bquota\s+(?:exceeded|reached)\b/i,
  /\busage\s+limit\b/i,
  /\btoo\s+many\s+requests\b/i,
  /\bbilling\s+issue\b/i,
  /\b(?:http\s*)?429\b/i,
];

function resolveMinLength(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) {
    return DEFAULT_OUTPUT_SIMILARITY_MIN_LENGTH;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : DEFAULT_OUTPUT_SIMILARITY_MIN_LENGTH;
}

export function normalizeWorkerOutput(stdout: string): string {
  return stripAnsi(stdout)
    .replace(ISO_TIMESTAMP_PATTERN, " ")
    .replace(DATETIME_PATTERN, " ")
    .replace(UUID_PATTERN, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function areOutputsSuspiciouslySimilar(
  outputA: string,
  outputB: string,
  options?: OutputSimilarityOptions,
): boolean {
  const normalizedA = normalizeWorkerOutput(outputA);
  const normalizedB = normalizeWorkerOutput(outputB);
  const minLength = resolveMinLength(options?.minLength);

  if (normalizedA.length === 0 || normalizedB.length === 0) {
    return false;
  }

  if (normalizedA.length < minLength || normalizedB.length < minLength) {
    return false;
  }

  return normalizedA === normalizedB;
}

export function containsKnownUsageLimitPattern(stdout: string): boolean {
  const normalized = normalizeWorkerOutput(stdout);

  if (normalized.length === 0) {
    return false;
  }

  return KNOWN_USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(normalized));
}
