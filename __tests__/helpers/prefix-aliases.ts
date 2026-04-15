export const VERIFY_PREFIX_ALIASES = ["verify", "confirm", "check"] as const;
export const MEMORY_PREFIX_ALIASES = ["memory", "memorize", "remember", "inventory"] as const;
export const FAST_PREFIX_ALIASES = ["fast", "raw", "quick"] as const;
export const PARALLEL_PREFIX_ALIASES = ["parallel", "concurrent", "par"] as const;
export const FOR_LOOP_PREFIX_ALIASES = ["for", "each", "foreach"] as const;

export interface PrefixAliasGroup<TAlias extends string> {
  canonical: TAlias;
  aliases: readonly TAlias[];
}

export const PREFIX_ALIAS_GROUPS = {
  verify: {
    canonical: VERIFY_PREFIX_ALIASES[0],
    aliases: VERIFY_PREFIX_ALIASES,
  },
  memory: {
    canonical: MEMORY_PREFIX_ALIASES[0],
    aliases: MEMORY_PREFIX_ALIASES,
  },
  fast: {
    canonical: FAST_PREFIX_ALIASES[0],
    aliases: FAST_PREFIX_ALIASES,
  },
  parallel: {
    canonical: PARALLEL_PREFIX_ALIASES[0],
    aliases: PARALLEL_PREFIX_ALIASES,
  },
  forLoop: {
    canonical: FOR_LOOP_PREFIX_ALIASES[0],
    aliases: FOR_LOOP_PREFIX_ALIASES,
  },
} as const satisfies {
  verify: PrefixAliasGroup<(typeof VERIFY_PREFIX_ALIASES)[number]>;
  memory: PrefixAliasGroup<(typeof MEMORY_PREFIX_ALIASES)[number]>;
  fast: PrefixAliasGroup<(typeof FAST_PREFIX_ALIASES)[number]>;
  parallel: PrefixAliasGroup<(typeof PARALLEL_PREFIX_ALIASES)[number]>;
  forLoop: PrefixAliasGroup<(typeof FOR_LOOP_PREFIX_ALIASES)[number]>;
};
