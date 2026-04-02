import { type ProcessRunMode, type PromptTransport } from "../domain/ports/index.js";
import type { SortMode } from "../domain/sorting.js";
import { DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS } from "../domain/ports/command-executor.js";

// Supported prompt transport backends accepted by the CLI.
const PROMPT_TRANSPORTS: readonly PromptTransport[] = ["file", "arg"];
// Supported sort modes for command output ordering.
const SORT_MODES: readonly SortMode[] = ["name-sort", "none", "old-first", "new-first"];
// Supported restore mechanisms for rollback-related commands.
const REVERT_METHODS = ["revert", "reset"] as const;
// Default number of plan files scanned when no explicit value is provided.
const DEFAULT_PLAN_SCAN_COUNT = 1;

/**
 * Defines validation rules used to parse integer-valued CLI options.
 */
interface ParseIntOptionSpec<AllowUndefined extends boolean> {
  optionName: string;
  defaultValue?: number;
  allowUndefined: AllowUndefined;
  min?: number;
  integerLabel: string;
  safeIntegerLabel: string;
}

/**
 * Parses a string-valued option as a constrained enum with fallback support.
 */
function parseEnumOption<T extends string>(
  value: string | undefined,
  optionName: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  // Use the declared default when the option was omitted by the caller.
  const parsed = (value ?? defaultValue) as T;
  if (!allowed.includes(parsed)) {
    throw new Error(`Invalid --${optionName} value: ${value}. Allowed: ${allowed.join(", ")}.`);
  }
  return parsed;
}

/**
 * Parses and validates integer-valued CLI options with optional bounds checks.
 */
function parseIntOption<AllowUndefined extends boolean>(
  value: string | undefined,
  spec: ParseIntOptionSpec<AllowUndefined>,
): AllowUndefined extends true ? number | undefined : number {
  // Return `undefined` only for options that explicitly permit omission.
  if (value === undefined && spec.allowUndefined) {
    return undefined as AllowUndefined extends true ? number | undefined : number;
  }

  // Parse from explicit input or a configured default value.
  const raw = value ?? String(spec.defaultValue ?? "");
  if (!/^\d+$/.test(raw)) {
    throw new Error(`Invalid --${spec.optionName} value: ${raw}. Must be a ${spec.integerLabel}.`);
  }

  // Convert only after validating lexical integer format.
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Invalid --${spec.optionName} value: ${raw}. Must be a ${spec.safeIntegerLabel}.`);
  }

  // Enforce lower-bound constraints for positive-only options.
  if (spec.min !== undefined && parsed < spec.min) {
    throw new Error(`Invalid --${spec.optionName} value: ${raw}. Must be a ${spec.integerLabel}.`);
  }

  return parsed as AllowUndefined extends true ? number | undefined : number;
}

/**
 * Collects repeated option values into an accumulated array.
 */
export function collectOption(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Parses the process execution mode used for command invocation.
 */
export function parseRunnerMode(value: string | undefined, allowed: readonly ProcessRunMode[]): ProcessRunMode {
  return parseEnumOption(value, "mode", allowed, "wait");
}

/**
 * Parses the prompt transport implementation to use for the run.
 */
export function parsePromptTransport(value: string | undefined): PromptTransport {
  return parseEnumOption(value, "transport", PROMPT_TRANSPORTS, "file");
}

/**
 * Parses the sort mode applied to CLI output.
 */
export function parseSortMode(value: string | undefined): SortMode {
  return parseEnumOption(value, "sort", SORT_MODES, "name-sort");
}

/**
 * Parses how many repair retries should be attempted.
 */
export function parseRepairAttempts(value: string | undefined): number {
  return parseIntOption(value, {
    optionName: "repair-attempts",
    defaultValue: 1,
    allowUndefined: false,
    integerLabel: "non-negative integer",
    safeIntegerLabel: "safe non-negative integer",
  });
}

/**
 * Parses the plan scan count with a positive minimum bound.
 */
export function parseScanCount(value: string | undefined): number {
  return parseIntOption(value, {
    optionName: "scan-count",
    defaultValue: DEFAULT_PLAN_SCAN_COUNT,
    allowUndefined: false,
    min: 1,
    integerLabel: "positive integer",
    safeIntegerLabel: "safe positive integer",
  });
}

/**
 * Validates and resolves the single Markdown file expected by the `plan` command.
 */
export function resolvePlanMarkdownFile(markdownFiles: string[]): string {
  if (markdownFiles.length === 0) {
    throw new Error("The `plan` command requires exactly one Markdown file path. Usage: rundown plan <markdown-file> [options].");
  }

  if (markdownFiles.length > 1) {
    throw new Error(`The \`plan\` command accepts exactly one Markdown file path. Received ${markdownFiles.length}: ${markdownFiles.join(", ")}.`);
  }

  const markdownFile = markdownFiles[0] ?? "";
  if (!/\.(md|markdown)$/i.test(markdownFile)) {
    throw new Error(`Invalid plan document path: ${markdownFile}. The \`plan\` command only accepts Markdown files (.md or .markdown).`);
  }

  return markdownFile;
}

/**
 * Parses the optional `--last` filter count.
 */
export function parseLastCount(value: string | undefined): number | undefined {
  return parseIntOption(value, {
    optionName: "last",
    allowUndefined: true,
    min: 1,
    integerLabel: "positive integer",
    safeIntegerLabel: "safe positive integer",
  });
}

/**
 * Parses the optional `--limit` result cap.
 */
export function parseLimitCount(value: string | undefined): number | undefined {
  return parseIntOption(value, {
    optionName: "limit",
    allowUndefined: true,
    min: 1,
    integerLabel: "positive integer",
    safeIntegerLabel: "safe positive integer",
  });
}

/**
 * Parses the timeout used for CLI block execution.
 */
export function parseCliBlockTimeout(value: string | undefined): number {
  return parseIntOption(value, {
    optionName: "cli-block-timeout",
    defaultValue: DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS,
    allowUndefined: false,
    integerLabel: "non-negative integer",
    safeIntegerLabel: "safe non-negative integer",
  });
}

/**
 * Parses the rollback method used by recovery commands.
 */
export function parseRevertMethod(value: string | undefined): "revert" | "reset" {
  return parseEnumOption(value, "method", REVERT_METHODS, "revert");
}

/**
 * Normalizes optional string input and treats blank values as undefined.
 */
export function normalizeOptionalString(value: string | string[] | boolean | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value.trim() === "" ? undefined : value;
}

/**
 * Resolves whether verification should run, defaulting to enabled.
 */
export function resolveVerifyFlag(opts: Record<string, string | string[] | boolean>): boolean {
  const verifyOpt = opts.verify as boolean | undefined;
  if (verifyOpt === false) {
    return false;
  }
  if (verifyOpt === true) {
    return true;
  }
  return true;
}

/**
 * Resolves whether automatic repair should be skipped.
 */
export function resolveNoRepairFlag(opts: Record<string, string | string[] | boolean>): boolean {
  const repairOpt = opts.repair as boolean | undefined;
  if (repairOpt === false) {
    return true;
  }

  const noRepairOpt = opts.noRepair as boolean | undefined;
  return noRepairOpt === true;
}

/**
 * Resolves whether CLI block execution checks should be ignored.
 */
export function resolveIgnoreCliBlockFlag(opts: Record<string, string | string[] | boolean>): boolean {
  const ignoreCliBlockOpt = opts.ignoreCliBlock as boolean | undefined;
  return ignoreCliBlockOpt === true;
}
