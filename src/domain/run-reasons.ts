/**
 * Canonical run-failure reason values persisted in run metadata.
 *
 * These values are machine-readable and intentionally stable so downstream
 * tooling can reliably classify failures.
 */
export const RUN_REASON_VERIFICATION_FAILED = "verification-failed" as const;

/**
 * Signals likely provider quota/rate-limit responses across worker phases.
 */
export const RUN_REASON_USAGE_LIMIT_DETECTED = "usage-limit-detected" as const;

/**
 * Signals an intentional graceful stop requested by terminal-control prefixes.
 */
export const RUN_REASON_TERMINAL_STOP_REQUESTED = "terminal-stop-requested" as const;

/**
 * Known run-failure reasons emitted by task execution flows.
 */
export type RunFailureReason =
  | typeof RUN_REASON_VERIFICATION_FAILED
  | typeof RUN_REASON_USAGE_LIMIT_DETECTED
  | typeof RUN_REASON_TERMINAL_STOP_REQUESTED;
