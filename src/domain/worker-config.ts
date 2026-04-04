import type { SubItem } from "./parser.js";

/**
 * Partial worker settings that can be composed from defaults, commands, and profiles.
 */
export interface WorkerProfile {
  // Command tokens used to launch the worker process.
  worker?: string[];
  // Additional arguments appended during profile resolution.
  workerArgs?: string[];
}

/**
 * Known command names that support worker configuration overrides.
 */
export const WORKER_CONFIG_COMMAND_NAMES = [
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
 * Per-command worker profile overrides keyed by supported command name.
 */
export type WorkerCommandProfiles = {
  [K in WorkerConfigCommandName]?: WorkerProfile;
};

/**
 * Worker configuration loaded from user or project settings.
 */
export interface WorkerConfig {
  // Baseline profile applied first to all command executions.
  defaults?: WorkerProfile;
  // Per-command overrides keyed by command name.
  commands?: WorkerCommandProfiles;
  // Named reusable profiles referenced by directive or file metadata.
  profiles?: Record<string, WorkerProfile>;
}

/**
 * Fully resolved worker command and argument set.
 */
export interface ResolvedWorker {
  // Final worker executable tokens after all overrides are applied.
  worker: string[];
  // Final argument list accumulated in merge order.
  workerArgs: string[];
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
 * @returns The matching worker profile.
 * @throws Error When the requested profile does not exist.
 */
function resolveNamedProfile(config: WorkerConfig, profileName: string): WorkerProfile {
  const profile = config.profiles?.[profileName];
  if (!profile) {
    throw new Error(`Unknown worker profile: ${profileName}`);
  }

  return profile;
}

/**
 * Merges an override profile into a resolved worker snapshot.
 *
 * Worker executable tokens are replaced when explicitly provided by the override.
 * Worker arguments are always appended to preserve cumulative merge behavior.
 *
 * @param base Current resolved worker state.
 * @param override Profile values to apply.
 * @returns A new resolved worker object containing the merged result.
 */
function mergeWorkerProfile(base: ResolvedWorker, override: WorkerProfile): ResolvedWorker {
  return {
    worker: override.worker ? [...override.worker] : [...base.worker],
    workerArgs: [...base.workerArgs, ...(override.workerArgs ?? [])],
  };
}

/**
 * Resolves the effective worker command from CLI, config defaults, command overrides,
 * file profile metadata, and directive profile metadata.
 *
 * Resolution order is deterministic:
 * 1) CLI worker (if provided) short-circuits all config.
 * 2) Config defaults.
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
 * @returns Resolved worker executable and argument list.
 */
export function resolveWorkerConfig(
  config: WorkerConfig | undefined,
  commandName: WorkerConfigCommandName,
  fileProfile: string | undefined,
  directiveProfile: string | undefined,
  taskProfile: string | undefined,
  cliWorker: string[] | undefined,
  intentCommandName?: WorkerConfigCommandName,
): ResolvedWorker {
  // CLI-provided worker executable takes absolute precedence.
  if (Array.isArray(cliWorker) && cliWorker.length > 0) {
    return {
      worker: [...cliWorker],
      workerArgs: [],
    };
  }

  // Start from an empty resolved state and merge in order of precedence.
  const resolved: ResolvedWorker = {
    worker: [],
    workerArgs: [],
  };

  const defaults = config?.defaults;
  if (defaults) {
    Object.assign(resolved, mergeWorkerProfile(resolved, defaults));
  }

  const commandOverrides = config?.commands?.[commandName];
  if (commandOverrides) {
    Object.assign(resolved, mergeWorkerProfile(resolved, commandOverrides));
  }

  if (intentCommandName && intentCommandName !== commandName) {
    const intentCommandOverrides = config?.commands?.[intentCommandName];
    if (intentCommandOverrides) {
      Object.assign(resolved, mergeWorkerProfile(resolved, intentCommandOverrides));
    }
  }

  const normalizedFileProfile = normalizeProfileName(fileProfile);
  if (normalizedFileProfile) {
    const profile = resolveNamedProfile(config ?? {}, normalizedFileProfile);
    Object.assign(resolved, mergeWorkerProfile(resolved, profile));
  }

  const normalizedDirectiveProfile = normalizeProfileName(directiveProfile);
  if (normalizedDirectiveProfile) {
    const profile = resolveNamedProfile(config ?? {}, normalizedDirectiveProfile);
    Object.assign(resolved, mergeWorkerProfile(resolved, profile));
  }

  const normalizedTaskProfile = normalizeProfileName(taskProfile);
  if (normalizedTaskProfile) {
    const profile = resolveNamedProfile(config ?? {}, normalizedTaskProfile);
    Object.assign(resolved, mergeWorkerProfile(resolved, profile));
  }

  return resolved;
}
