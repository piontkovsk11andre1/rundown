/**
 * Supported execution intents inferred from task wording.
 */
export type TaskIntent = "verify-only" | "memory-capture" | "execute-and-verify";

/**
 * Decision payload returned after classifying task intent.
 */
export interface TaskIntentDecision {
  // Normalized intent used by phase routing.
  intent: TaskIntent;
  // Human-readable reason describing why the intent was chosen.
  reason: string;
  // Normalized task text to execute/verify after intent-specific parsing.
  normalizedTaskText: string;
  // Indicates that a prefixed intent was detected but no payload text was provided.
  hasEmptyPayload: boolean;
  // Canonical memory prefix alias when intent is memory-capture.
  memoryCapturePrefix?: "memory" | "memorize" | "remember" | "inventory";
}

// Prefix marker that explicitly requests verification without execution.
const EXPLICIT_VERIFY_PREFIX = /^(verify|confirm|check)\s*:/i;
// Prefix marker that requests memory capture execution semantics.
const MEMORY_CAPTURE_PREFIX = /^(memory|memorize|remember|inventory)\s*:\s*/i;

function extractMemoryCaptureParts(taskText: string): {
  payload: string;
  prefix: "memory" | "memorize" | "remember" | "inventory";
} | null {
  const prefixMatch = taskText.match(MEMORY_CAPTURE_PREFIX);
  const prefix = prefixMatch?.[1];
  if (!prefixMatch || !prefix) {
    return null;
  }

  const normalizedPrefix = prefix.toLowerCase();
  if (
    normalizedPrefix !== "memory"
    && normalizedPrefix !== "memorize"
    && normalizedPrefix !== "remember"
    && normalizedPrefix !== "inventory"
  ) {
    return null;
  }

  return {
    payload: taskText.slice(prefixMatch[0].length).trim(),
    prefix: normalizedPrefix,
  };
}

/**
 * Classifies task text into a verification-only or execute-and-verify intent.
 *
 * @param taskText Raw task text selected from the source Markdown item.
 * @returns Intent decision containing both the chosen intent and rationale.
 */
export function classifyTaskIntent(taskText: string): TaskIntentDecision {
  // Trim whitespace so explicit prefix checks are stable across formatting.
  const normalized = taskText.trim();

  if (EXPLICIT_VERIFY_PREFIX.test(normalized)) {
    return {
      intent: "verify-only",
      reason: "explicit marker",
      normalizedTaskText: normalized,
      hasEmptyPayload: false,
    };
  }

  const memoryCapture = extractMemoryCaptureParts(normalized);
  if (memoryCapture !== null) {
    return {
      intent: "memory-capture",
      reason: "explicit memory marker",
      normalizedTaskText: memoryCapture.payload,
      hasEmptyPayload: memoryCapture.payload.length === 0,
      memoryCapturePrefix: memoryCapture.prefix,
    };
  }

  return {
    intent: "execute-and-verify",
    reason: "default",
    normalizedTaskText: normalized,
    hasEmptyPayload: false,
  };
}
