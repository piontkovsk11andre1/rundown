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
 * Worker configuration loaded from user or project settings.
 */
export interface WorkerConfig {
  // Baseline profile applied first to all command executions.
  defaults?: WorkerProfile;
  // Per-command overrides keyed by command name.
  commands?: Record<string, WorkerProfile>;
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
 * 4) File-level named profile.
 * 5) Directive-level named profile.
 *
 * @param config Optional worker configuration source.
 * @param commandName Command currently being executed.
 * @param fileProfile Profile name derived from file-level metadata.
 * @param directiveProfile Profile name derived from task/directive metadata.
 * @param cliWorker Optional worker executable tokens passed via CLI.
 * @returns Resolved worker executable and argument list.
 */
export function resolveWorkerConfig(
  config: WorkerConfig | undefined,
  commandName: string,
  fileProfile: string | undefined,
  directiveProfile: string | undefined,
  cliWorker: string[] | undefined,
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

  return resolved;
}
