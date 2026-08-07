export const HARNESS_PRESET_KEYS = [
  "opencode",
  "claude",
  "gemini",
  "codex",
  "aider",
  "cursor",
  "pi",
] as const;

export type HarnessPresetKey = typeof HARNESS_PRESET_KEYS[number];

export interface HarnessPresetPayload {
  workers: {
    default: string[];
    tui?: string[];
    fallbacks?: string[][];
  };
  commands?: {
    discuss?: string[];
  };
}

export interface HarnessPresetRegistryEntry {
  key: HarnessPresetKey;
  aliases: readonly string[];
  payload: HarnessPresetPayload;
}

const HARNESS_PRESET_PAYLOADS: Record<HarnessPresetKey, HarnessPresetPayload> = {
  opencode: {
    workers: {
      default: ["opencode", "run", "$bootstrap"],
      tui: ["opencode", "--prompt", "$bootstrap"],
    },
    commands: {
      discuss: ["opencode"],
    },
  },
  claude: {
    workers: {
      default: ["claude", "run", "--file", "$file", "$bootstrap"],
      tui: ["claude"],
    },
    commands: {
      discuss: ["claude"],
    },
  },
  gemini: {
    workers: {
      default: ["gemini", "run", "--file", "$file", "$bootstrap"],
      tui: ["gemini"],
    },
    commands: {
      discuss: ["gemini"],
    },
  },
  codex: {
    workers: {
      default: ["codex", "run", "--file", "$file", "$bootstrap"],
      tui: ["codex"],
    },
    commands: {
      discuss: ["codex"],
    },
  },
  aider: {
    workers: {
      default: ["aider", "run", "--file", "$file", "$bootstrap"],
      tui: ["aider"],
    },
    commands: {
      discuss: ["aider"],
    },
  },
  cursor: {
    workers: {
      default: ["cursor", "run", "--file", "$file", "$bootstrap"],
      tui: ["cursor"],
    },
    commands: {
      discuss: ["cursor"],
    },
  },
  pi: {
    workers: {
      default: ["pi", "run", "--file", "$file", "$bootstrap"],
      tui: ["pi"],
    },
    commands: {
      discuss: ["pi"],
    },
  },
};

const HARNESS_PRESET_ALIAS_ENTRIES = [
  ["opencode", ["open-code"]],
  ["claude", ["claude-code", "claudecode"]],
  ["gemini", ["gemini-cli", "google-gemini"]],
  ["codex", ["openai-codex"]],
  ["aider", []],
  ["cursor", ["cursor-cli", "cursor-agent"]],
  ["pi", ["pi-cli"]],
] as const satisfies readonly [HarnessPresetKey, readonly string[]][];

const HARNESS_PRESET_RESOLUTION_INDEX = new Map<string, HarnessPresetKey>();

export const HARNESS_PRESET_REGISTRY: Record<HarnessPresetKey, HarnessPresetRegistryEntry> =
  HARNESS_PRESET_ALIAS_ENTRIES.reduce<Record<HarnessPresetKey, HarnessPresetRegistryEntry>>((registry, [key, aliases]) => {
    const dedupedAliases = [key, ...aliases]
      .map((alias) => normalizeHarnessPresetAlias(alias))
      .filter((alias, index, all) => all.indexOf(alias) === index);

    registry[key] = {
      key,
      aliases: dedupedAliases,
      payload: cloneHarnessPresetPayload(HARNESS_PRESET_PAYLOADS[key]),
    };

    for (const alias of dedupedAliases) {
      HARNESS_PRESET_RESOLUTION_INDEX.set(alias, key);
    }

    return registry;
  }, {} as Record<HarnessPresetKey, HarnessPresetRegistryEntry>);

export function listHarnessPresetKeys(): readonly HarnessPresetKey[] {
  return HARNESS_PRESET_KEYS;
}

export function listHarnessPresetEntries(): readonly HarnessPresetRegistryEntry[] {
  return HARNESS_PRESET_KEYS.map((key) => HARNESS_PRESET_REGISTRY[key]);
}

export function getHarnessPresetPayload(key: HarnessPresetKey): HarnessPresetPayload {
  return cloneHarnessPresetPayload(HARNESS_PRESET_PAYLOADS[key]);
}

export function resolveHarnessPresetKey(alias: string): HarnessPresetKey | undefined {
  const normalizedAlias = normalizeHarnessPresetAlias(alias);
  if (normalizedAlias.length === 0) {
    return undefined;
  }

  return HARNESS_PRESET_RESOLUTION_INDEX.get(normalizedAlias);
}

export function normalizeHarnessPresetAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

function cloneHarnessPresetPayload(payload: HarnessPresetPayload): HarnessPresetPayload {
  return {
    workers: {
      default: [...payload.workers.default],
      ...(payload.workers.tui ? { tui: [...payload.workers.tui] } : {}),
      ...(payload.workers.fallbacks
        ? {
          fallbacks: payload.workers.fallbacks.map((command) => [...command]),
        }
        : {}),
    },
    ...(payload.commands
      ? {
        commands: {
          ...(payload.commands.discuss ? { discuss: [...payload.commands.discuss] } : {}),
        },
      }
      : {}),
  };
}
