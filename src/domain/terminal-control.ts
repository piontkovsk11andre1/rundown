/**
 * Canonical terminal-control aliases.
 *
 * These prefixes express intentional early stop semantics, distinct from
 * optional sibling skipping (`optional:`/`skip:`).
 */
export const TERMINAL_PREFIX_ALIASES = ["quit", "exit", "end", "break", "return"] as const;

/**
 * Supported terminal-control prefix names.
 */
export type TerminalPrefixAlias = (typeof TERMINAL_PREFIX_ALIASES)[number];

/**
 * Payload classification for terminal-control prefixes.
 *
 * - `unconditional`: empty payload -> stop immediately.
 * - `conditional`: non-empty payload -> evaluate yes/no first.
 */
export type TerminalPayloadMode = "unconditional" | "conditional";

/**
 * Stable signal emitted by tool handlers to request graceful run/loop stop.
 */
export interface TerminalStopSignal {
  requestedBy: TerminalPrefixAlias;
  mode: TerminalPayloadMode;
  reason: string;
  stopRun: boolean;
  stopLoop: boolean;
  exitCode: number;
}

/**
 * Optional policy override for intentional terminal stop exits.
 */
export interface TerminalStopExitPolicy {
  /**
   * When true, intentional terminal stops are returned as failure.
   */
  treatIntentionalStopAsFailure?: boolean;
  /**
   * Custom exit code used only when `treatIntentionalStopAsFailure` is true.
   */
  failureExitCode?: number;
}

/**
 * Default intentional stop policy: graceful success.
 */
export const DEFAULT_TERMINAL_STOP_EXIT_POLICY: Required<TerminalStopExitPolicy> = {
  treatIntentionalStopAsFailure: false,
  failureExitCode: 1,
};

/**
 * Resolves exit code for intentional terminal-stop flow.
 */
export function resolveTerminalStopExitCode(policy?: TerminalStopExitPolicy): number {
  const effectivePolicy: Required<TerminalStopExitPolicy> = {
    ...DEFAULT_TERMINAL_STOP_EXIT_POLICY,
    ...(policy ?? {}),
  };

  if (effectivePolicy.treatIntentionalStopAsFailure) {
    return effectivePolicy.failureExitCode;
  }

  return 0;
}

/**
 * Classifies terminal payload text into unconditional or conditional mode.
 */
export function classifyTerminalPayload(payload: string): {
  mode: TerminalPayloadMode;
  condition: string;
} {
  const condition = payload.trim();
  if (condition.length === 0) {
    return {
      mode: "unconditional",
      condition: "",
    };
  }

  return {
    mode: "conditional",
    condition,
  };
}
