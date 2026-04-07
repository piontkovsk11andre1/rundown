import type { SubItem } from "./parser.js";
import type { ProcessRunMode } from "./ports/process-runner.js";

/**
 * A flat worker command expressed as a string array of executable tokens.
 */
export type WorkerCommand = string[];

/**
 * Worker entries in the `workers` configuration section.
 */
export interface WorkersConfig {
  // Default worker command used for all non-TUI executions.
  default?: WorkerCommand;
  // Worker command used when executing in TUI mode.
  tui?: WorkerCommand;
  // Ordered list of fallback worker commands tried when the primary worker
  // hits a usage-limit or connection error.
  fallbacks?: WorkerCommand[];
}

/**
 * Known command names that support worker configuration overrides.
 */
export const WORKER_CONFIG_COMMAND_NAMES = [
  "help",
  "run",
  "plan",
  "discuss",
  "research",
  "reverify",
  "verify",
  "memory",
] as const;

/**
 * Supported command names for `config.commands` worker overrides.
 * Includes fixed intent-based keys and a dynamic `tools.{toolName}` pattern
 * for per-tool worker configuration.
 */
export type WorkerConfigCommandName = typeof WORKER_CONFIG_COMMAND_NAMES[number] | `tools.${string}`;

/**
 * Per-command worker overrides keyed by supported command name.
 */
export type WorkerCommandProfiles = {
  [K in WorkerConfigCommandName]?: WorkerCommand;
};

/**
 * Worker configuration loaded from user or project settings.
 */
export interface WorkerConfig {
  // Named worker commands: default, tui, and fallback list.
  workers?: WorkersConfig;
  // Per-command overrides keyed by command name.
  commands?: WorkerCommandProfiles;
  // Named reusable profiles referenced by directive or file metadata.
  profiles?: Record<string, WorkerCommand>;
}

// Matches a sub-item like "profile: build" and captures the profile name.
const PROFILE_SUBITEM_PATTERN = /^profile\s*:\s*(.+)$/i;

/**
 * Normalizes profile names by trimming whitespace and rejecting empty values.
 *
 * @param profileName Candidate profile name from configuration or markdown metadata.
 * @returns Trimmed profile name, or `undefined` when the value is missing or blank.
 */
function normalizeProfileName(profileName: string | undefined): string | undefined {
  if (typeof profileName !== "string") {
    return undefined;
  }

  const trimmed = profileName.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extracts the first valid `profile:` reference from parsed task sub-items.
 *
 * @param subItems Parsed sub-items associated with a task.
 * @returns Normalized profile name when present, otherwise `undefined`.
 */
export function extractProfileFromSubItems(subItems: SubItem[]): string | undefined {
  for (const subItem of subItems) {
    const match = subItem.text.match(PROFILE_SUBITEM_PATTERN);
    if (!match) {
      continue;
    }

    const profileName = normalizeProfileName(match[1]);
    if (profileName) {
      return profileName;
    }
  }

  return undefined;
}

/**
 * Resolves a named profile from configuration and throws when it is unknown.
 *
 * @param config Worker configuration that may include named profiles.
 * @param profileName Name of the profile to resolve.
 * @returns The matching worker command.
 * @throws Error When the requested profile does not exist.
 */
function resolveNamedProfile(config: WorkerConfig, profileName: string): WorkerCommand {
  const profile = config.profiles?.[profileName];
  if (!profile) {
    throw new Error(`Unknown worker profile: ${profileName}`);
  }

  return profile;
}

/**
 * Returns the override command when non-empty, otherwise falls back to the base.
 */
function pickCommand(base: WorkerCommand, override: WorkerCommand | undefined): WorkerCommand {
  return override && override.length > 0 ? [...override] : [...base];
}

/**
 * Resolves the effective worker command from CLI, config workers, command overrides,
 * file profile metadata, and directive profile metadata.
 *
 * Resolution order is deterministic:
 * 1) CLI worker (if provided) short-circuits all config.
 * 2) Config workers.default or workers.tui (based on mode).
 * 3) Per-command override.
 * 4) Per-intent override (e.g. "verify" for verify-only tasks), when provided.
 * 5) File-level named profile.
 * 6) Directive-level named profile.
 * 7) Task-level named profile.
 *
 * @param config Optional worker configuration source.
 * @param commandName Command currently being executed.
 * @param fileProfile Profile name derived from file-level metadata.
 * @param directiveProfile Profile name derived from task/directive metadata.
 * @param taskProfile Profile name derived from task-level inline metadata.
 * @param cliWorker Optional worker executable tokens passed via CLI.
 * @param intentCommandName Optional intent-based command key (e.g. "verify") applied after the per-command override.
 * @param mode Optional process run mode; when "tui", prefers workers.tui over workers.default.
 * @returns Resolved worker command as a flat string array.
 */
export function resolveWorkerConfig(
  config: WorkerConfig | undefined,
  commandName: WorkerConfigCommandName,
  fileProfile: string | undefined,
  directiveProfile: string | undefined,
  taskProfile: string | undefined,
  cliWorker: string[] | undefined,
  intentCommandName?: WorkerConfigCommandName,
  mode?: ProcessRunMode,
): WorkerCommand {
  // CLI-provided worker executable takes absolute precedence.
  if (Array.isArray(cliWorker) && cliWorker.length > 0) {
    return [...cliWorker];
  }

  // Select the base worker from config: prefer tui variant when in TUI mode.
  const workers = config?.workers;
  let resolved: WorkerCommand = mode === "tui" && workers?.tui && workers.tui.length > 0
    ? [...workers.tui]
    : workers?.default ? [...workers.default] : [];

  const commandOverride = config?.commands?.[commandName];
  resolved = pickCommand(resolved, commandOverride);

  if (intentCommandName && intentCommandName !== commandName) {
    const intentOverride = config?.commands?.[intentCommandName];
    resolved = pickCommand(resolved, intentOverride);
  }

  const normalizedFileProfile = normalizeProfileName(fileProfile);
  if (normalizedFileProfile) {
    const profile = resolveNamedProfile(config ?? {}, normalizedFileProfile);
    resolved = pickCommand(resolved, profile);
  }

  const normalizedDirectiveProfile = normalizeProfileName(directiveProfile);
  if (normalizedDirectiveProfile) {
    const profile = resolveNamedProfile(config ?? {}, normalizedDirectiveProfile);
    resolved = pickCommand(resolved, profile);
  }

  const normalizedTaskProfile = normalizeProfileName(taskProfile);
  if (normalizedTaskProfile) {
    const profile = resolveNamedProfile(config ?? {}, normalizedTaskProfile);
    resolved = pickCommand(resolved, profile);
  }

  return resolved;
}
