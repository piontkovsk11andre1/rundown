import type { SubItem } from "./parser.js";

export interface WorkerProfile {
  worker?: string[];
  workerArgs?: string[];
}

export interface WorkerConfig {
  defaults?: WorkerProfile;
  commands?: Record<string, WorkerProfile>;
  profiles?: Record<string, WorkerProfile>;
}

export interface ResolvedWorker {
  worker: string[];
  workerArgs: string[];
}

const PROFILE_SUBITEM_PATTERN = /^profile\s*:\s*(.+)$/i;

function normalizeProfileName(profileName: string | undefined): string | undefined {
  if (typeof profileName !== "string") {
    return undefined;
  }

  const trimmed = profileName.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

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

function resolveNamedProfile(config: WorkerConfig, profileName: string): WorkerProfile {
  const profile = config.profiles?.[profileName];
  if (!profile) {
    throw new Error(`Unknown worker profile: ${profileName}`);
  }

  return profile;
}

function mergeWorkerProfile(base: ResolvedWorker, override: WorkerProfile): ResolvedWorker {
  return {
    worker: override.worker ? [...override.worker] : [...base.worker],
    workerArgs: [...base.workerArgs, ...(override.workerArgs ?? [])],
  };
}

export function resolveWorkerConfig(
  config: WorkerConfig | undefined,
  commandName: string,
  fileProfile: string | undefined,
  directiveProfile: string | undefined,
  cliWorker: string[] | undefined,
): ResolvedWorker {
  if (Array.isArray(cliWorker) && cliWorker.length > 0) {
    return {
      worker: [...cliWorker],
      workerArgs: [],
    };
  }

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
