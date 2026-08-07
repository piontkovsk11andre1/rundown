export const PROVIDER_PRESET_KEYS = [
  "opencode",
  "claude",
  "gemini",
  "codex",
  "aider",
  "cursor",
  "pi",
] as const;

export type ProviderPresetKey = typeof PROVIDER_PRESET_KEYS[number];

export interface ProviderPresetPayload {
  workers: {
    default: string[];
    interactive?: string[];
  };
  profiles?: Record<string, string[]>;
  fallbacks?: Record<string, string[][] | undefined>;
}

export interface ProviderPresetRegistryEntry {
  key: ProviderPresetKey;
  aliases: readonly string[];
  payload: ProviderPresetPayload;
}

const PROVIDER_PRESET_PAYLOADS: Record<ProviderPresetKey, ProviderPresetPayload> = {
  opencode: {
    workers: {
      default: ["opencode", "run", "$bootstrap"],
      interactive: ["opencode", "--prompt", "$bootstrap"],
    },
  },
  claude: {
    workers: {
      default: ["claude", "run", "--file", "$file", "$bootstrap"],
      interactive: ["claude"],
    },
  },
  gemini: {
    workers: {
      default: ["gemini", "run", "--file", "$file", "$bootstrap"],
      interactive: ["gemini"],
    },
  },
  codex: {
    workers: {
      default: ["codex", "run", "--file", "$file", "$bootstrap"],
      interactive: ["codex"],
    },
  },
  aider: {
    workers: {
      default: ["aider", "run", "--file", "$file", "$bootstrap"],
      interactive: ["aider"],
    },
  },
  cursor: {
    workers: {
      default: ["cursor", "run", "--file", "$file", "$bootstrap"],
      interactive: ["cursor"],
    },
  },
  pi: {
    workers: {
      default: ["pi", "run", "--file", "$file", "$bootstrap"],
      interactive: ["pi"],
    },
  },
};

const PROVIDER_PRESET_ALIAS_ENTRIES = [
  ["opencode", ["open-code"]],
  ["claude", ["claude-code", "claudecode"]],
  ["gemini", ["gemini-cli", "google-gemini"]],
  ["codex", ["openai-codex"]],
  ["aider", []],
  ["cursor", ["cursor-cli", "cursor-agent"]],
  ["pi", ["pi-cli"]],
] as const satisfies readonly [ProviderPresetKey, readonly string[]][];

const PROVIDER_PRESET_RESOLUTION_INDEX = new Map<string, ProviderPresetKey>();

export const PROVIDER_PRESET_REGISTRY: Record<ProviderPresetKey, ProviderPresetRegistryEntry> =
  PROVIDER_PRESET_ALIAS_ENTRIES.reduce<Record<ProviderPresetKey, ProviderPresetRegistryEntry>>((registry, [key, aliases]) => {
    const dedupedAliases = [key, ...aliases]
      .map((alias) => normalizeProviderPresetAlias(alias))
      .filter((alias, index, all) => all.indexOf(alias) === index);

    registry[key] = {
      key,
      aliases: dedupedAliases,
      payload: cloneProviderPresetPayload(PROVIDER_PRESET_PAYLOADS[key]),
    };

    for (const alias of dedupedAliases) {
      PROVIDER_PRESET_RESOLUTION_INDEX.set(alias, key);
    }

    return registry;
  }, {} as Record<ProviderPresetKey, ProviderPresetRegistryEntry>);

export function listProviderPresetKeys(): readonly ProviderPresetKey[] {
  return PROVIDER_PRESET_KEYS;
}

export function listProviderPresetEntries(): readonly ProviderPresetRegistryEntry[] {
  return PROVIDER_PRESET_KEYS.map((key) => PROVIDER_PRESET_REGISTRY[key]);
}

export function getProviderPresetPayload(key: ProviderPresetKey): ProviderPresetPayload {
  return cloneProviderPresetPayload(PROVIDER_PRESET_PAYLOADS[key]);
}

export function resolveProviderPresetKey(alias: string): ProviderPresetKey | undefined {
  const normalizedAlias = normalizeProviderPresetAlias(alias);
  if (normalizedAlias.length === 0) {
    return undefined;
  }

  return PROVIDER_PRESET_RESOLUTION_INDEX.get(normalizedAlias);
}

export function normalizeProviderPresetAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

function cloneProviderPresetPayload(payload: ProviderPresetPayload): ProviderPresetPayload {
  return {
    workers: {
      default: [...payload.workers.default],
      ...(payload.workers.interactive ? { interactive: [...payload.workers.interactive] } : {}),
    },
    ...(payload.profiles
      ? {
        profiles: Object.fromEntries(
          Object.entries(payload.profiles).map(([name, command]) => [name, [...command]]),
        ),
      }
      : {}),
    ...(payload.fallbacks
      ? {
        fallbacks: Object.fromEntries(
          Object.entries(payload.fallbacks).map(([name, commands]) => [
            name,
            commands?.map((command) => [...command]),
          ]),
        ),
      }
      : {}),
  };
}
