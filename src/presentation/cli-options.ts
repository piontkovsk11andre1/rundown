import { type ProcessRunMode } from "../domain/ports/index.js";
import type { SortMode } from "../domain/sorting.js";
import { DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS } from "../domain/ports/command-executor.js";
import {
  inferWorkerPatternFromCommand,
  parseWorkerPattern,
  type ParsedWorkerPattern,
} from "../domain/worker-pattern.js";
import fs from "node:fs";

type CliOptionMap = Record<string, string | string[] | boolean>;

export interface SharedWorkerRuntimeOptions {
  keepArtifacts: boolean;
  showAgentOutput: boolean;
  trace: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerPattern: ParsedWorkerPattern;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs: number;
  configDirOption?: string;
}

// Supported sort modes for command output ordering.
const SORT_MODES: readonly SortMode[] = ["name-sort", "none", "old-first", "new-first"];
// Supported restore mechanisms for rollback-related commands.
const REVERT_METHODS = ["revert", "reset"] as const;
const COMMIT_MODES = ["per-task", "file-done"] as const;
// Default additional nested plan depth passes.
const DEFAULT_PLAN_DEEP = 0;

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
 * Resolves worker command arguments from either parsed CLI options or the `--` separator payload.
 */
export function resolveWorkerCommand(
  worker: string | string[] | boolean | undefined,
  getWorkerFromSeparator: () => string[] | undefined,
): ParsedWorkerPattern {
  if (Array.isArray(worker)) {
    return inferWorkerPatternFromCommand(worker);
  }

  if (typeof worker === "string") {
    return parseWorkerPattern(worker);
  }

  const workerFromSeparator = getWorkerFromSeparator();
  if (Array.isArray(workerFromSeparator)) {
    return inferWorkerPatternFromCommand(workerFromSeparator);
  }

  return inferWorkerPatternFromCommand([]);
}

/**
 * Normalizes runtime and worker options shared by `research`, `plan`, and `make` workflows.
 */
export function resolveSharedWorkerRuntimeOptions(
  opts: CliOptionMap,
  getWorkerFromSeparator: () => string[] | undefined,
): SharedWorkerRuntimeOptions {
  return {
    keepArtifacts: Boolean(opts.keepArtifacts as boolean | undefined),
    showAgentOutput: resolveShowAgentOutputOption(opts),
    trace: Boolean(opts.trace as boolean | undefined),
    varsFileOption: opts.varsFile as string | boolean | undefined,
    cliTemplateVarArgs: (opts.var as string[] | undefined) ?? [],
    workerPattern: resolveWorkerCommand(opts.worker, getWorkerFromSeparator),
    forceUnlock: Boolean(opts.forceUnlock as boolean | undefined),
    ignoreCliBlock: resolveIgnoreCliBlockFlag(opts),
    cliBlockTimeoutMs: parseCliBlockTimeout(opts.cliBlockTimeout as string | undefined),
    configDirOption: normalizeOptionalString(opts.configDir),
  };
}

/**
 * Parses the process execution mode used for command invocation.
 */
export function parseRunnerMode(value: string | undefined, allowed: readonly ProcessRunMode[]): ProcessRunMode {
  return parseEnumOption(value, "mode", allowed, "wait");
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
 * Parses default outer retry attempts for force-prefixed tasks.
 */
export function parseForceAttempts(value: string | undefined): number {
  return parseIntOption(value, {
    optionName: "force-attempts",
    defaultValue: 2,
    allowUndefined: false,
    min: 1,
    integerLabel: "positive integer",
    safeIntegerLabel: "safe positive integer",
  });
}

/**
 * Parses the optional plan scan count.
 *
 * Returns `undefined` when `--scan-count` is omitted so callers can select
 * unlimited scan mode; provided values must remain positive integers.
 */
export function parseScanCount(value: string | undefined): number | undefined {
  return parseIntOption(value, {
    optionName: "scan-count",
    allowUndefined: true,
    min: 1,
    integerLabel: "positive integer",
    safeIntegerLabel: "safe positive integer",
  });
}

/**
 * Parses the additional deep planning pass count with a non-negative minimum bound.
 */
export function parsePlanDeep(value: string | undefined): number {
  return parseIntOption(value, {
    optionName: "deep",
    defaultValue: DEFAULT_PLAN_DEEP,
    allowUndefined: false,
    min: 0,
    integerLabel: "non-negative integer",
    safeIntegerLabel: "safe non-negative integer",
  });
}

/**
 * Parses the number of clean execution rounds.
 */
export function parseRounds(value: string | undefined): number {
  return parseIntOption(value, {
    optionName: "rounds",
    defaultValue: 1,
    allowUndefined: false,
    min: 1,
    integerLabel: "positive integer",
    safeIntegerLabel: "safe positive integer",
  });
}

/**
 * Parses loop cooldown seconds as milliseconds between iterations.
 */
export function parseCooldown(value: string): number {
  const seconds = parseIntOption(value, {
    optionName: "cooldown",
    allowUndefined: false,
    min: 1,
    integerLabel: "positive integer",
    safeIntegerLabel: "safe positive integer",
  });

  return seconds * 1000;
}

/**
 * @deprecated Use `parseCooldown` instead.
 */
export function parseLoopCooldownSeconds(value: string | undefined): number {
  return parseIntOption(value, {
    optionName: "cooldown",
    defaultValue: 60,
    allowUndefined: false,
    min: 0,
    integerLabel: "non-negative integer",
    safeIntegerLabel: "safe non-negative integer",
  });
}

/**
 * Parses optional loop iteration cap.
 */
export function parseLoopIterations(value: string | undefined): number | undefined {
  return parseIntOption(value, {
    optionName: "iterations",
    allowUndefined: true,
    min: 1,
    integerLabel: "positive integer",
    safeIntegerLabel: "safe positive integer",
  });
}

/**
 * Validates and resolves the single Markdown file expected by the `plan` command.
 */
export function resolvePlanMarkdownFile(markdownFiles: string[]): string {
  return resolveSingleMarkdownFile({
    commandName: "plan",
    usage: "rundown plan <markdown-file> [options]",
    invalidPathLabel: "plan",
    markdownFiles,
  });
}

/**
 * Validates and resolves the single Markdown file expected by the `research` command.
 */
export function resolveResearchMarkdownFile(markdownFiles: string[]): string {
  const markdownFile = resolveSingleMarkdownFile({
    commandName: "research",
    usage: "rundown research <source> [options]",
    invalidPathLabel: "research",
    markdownFiles,
  });

  if (containsGlobPattern(markdownFile)) {
    throw new Error(
      "Invalid research document path: "
        + markdownFile
        + ". The `research` command requires exactly one existing Markdown file and does not accept directory or glob inputs.",
    );
  }

  if (!fs.existsSync(markdownFile)) {
    throw new Error(
      "Invalid research document path: "
        + markdownFile
        + ". The `research` command requires exactly one existing Markdown file; the provided path does not exist.",
    );
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(markdownFile);
  } catch {
    throw new Error(
      "Invalid research document path: "
        + markdownFile
        + ". The `research` command requires exactly one existing Markdown file and cannot read this path.",
    );
  }

  if (!stats.isFile()) {
    throw new Error(
      "Invalid research document path: "
        + markdownFile
        + ". The `research` command requires exactly one existing Markdown file and does not accept directory or glob inputs.",
    );
  }

  return markdownFile;
}

/**
 * Validates and resolves the target Markdown file expected by the `make` command.
 */
export function resolveMakeMarkdownFile(markdownFile: string): string {
  const resolvedMarkdownFile = resolveSingleMarkdownFile({
    commandName: "make",
    usage: "rundown make <seed-text> <markdown-file> [options]",
    invalidPathLabel: "make",
    markdownFiles: [markdownFile],
  });

  if (containsGlobPattern(resolvedMarkdownFile)) {
    throw new Error(
      "Invalid make document path: "
        + resolvedMarkdownFile
        + ". The `make` command requires exactly one non-directory Markdown file and does not accept directory or glob inputs.",
    );
  }

  if (!fs.existsSync(resolvedMarkdownFile)) {
    return resolvedMarkdownFile;
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(resolvedMarkdownFile);
  } catch {
    throw new Error(
      "Invalid make document path: "
        + resolvedMarkdownFile
        + ". The `make` command requires exactly one non-directory Markdown file and cannot read this path.",
    );
  }

  if (stats.isDirectory()) {
    throw new Error(
      "Invalid make document path: "
        + resolvedMarkdownFile
        + ". The `make` command requires exactly one non-directory Markdown file and does not accept directory or glob inputs.",
    );
  }

  return resolvedMarkdownFile;
}

interface ResolveSingleMarkdownFileOptions {
  commandName: string;
  usage: string;
  invalidPathLabel: string;
  markdownFiles: string[];
}

/**
 * Validates a command that accepts exactly one Markdown document path.
 */
function resolveSingleMarkdownFile({
  commandName,
  usage,
  invalidPathLabel,
  markdownFiles,
}: ResolveSingleMarkdownFileOptions): string {
  if (markdownFiles.length === 0) {
    throw new Error(`The \`${commandName}\` command requires exactly one Markdown file path. Usage: ${usage}.`);
  }

  if (markdownFiles.length > 1) {
    throw new Error(`The \`${commandName}\` command accepts exactly one Markdown file path. Received ${markdownFiles.length}: ${markdownFiles.join(", ")}.`);
  }

  const markdownFile = markdownFiles[0] ?? "";
  if (!/\.(md|markdown)$/i.test(markdownFile)) {
    throw new Error(`Invalid ${invalidPathLabel} document path: ${markdownFile}. The \`${commandName}\` command only accepts Markdown files (.md or .markdown).`);
  }

  return markdownFile;
}

/**
 * Detects whether a path string contains common glob metacharacters.
 */
function containsGlobPattern(value: string): boolean {
  return /[*?[\]{}]/.test(value);
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
 * Parses commit timing mode used by run-style commands.
 */
export function parseCommitMode(value: string | undefined): "per-task" | "file-done" {
  return parseEnumOption(value, "commit-mode", COMMIT_MODES, "per-task");
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

/**
 * Resolves the agent-output visibility option.
 */
export function resolveShowAgentOutputOption(opts: Record<string, string | string[] | boolean>): boolean {
  const showAgentOutputOpt = opts.showAgentOutput as boolean | undefined;
  return showAgentOutputOpt === true;
}

/**
 * Resolves the verbose-output visibility option.
 */
export function resolveVerboseOption(opts: Record<string, string | string[] | boolean>): boolean {
  const verboseOpt = opts.verbose as boolean | undefined;
  return verboseOpt === true;
}
