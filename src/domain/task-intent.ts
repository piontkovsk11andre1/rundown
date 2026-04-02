/**
 * Supported execution intents inferred from task wording.
 */
export type TaskIntent = "verify-only" | "execute-and-verify";

/**
 * Decision payload returned after classifying task intent.
 */
export interface TaskIntentDecision {
  // Normalized intent used by phase routing.
  intent: TaskIntent;
  // Human-readable reason describing why the intent was chosen.
  reason: string;
}

// Prefix marker that explicitly requests verification without execution.
const EXPLICIT_VERIFY_PREFIX = /^(verify|confirm|check)\s*:/i;

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
    };
  }

  return {
    intent: "execute-and-verify",
    reason: "default",
  };
}
