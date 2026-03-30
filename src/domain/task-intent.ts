export type TaskIntent = "verify-only" | "execute-and-verify";

export interface TaskIntentDecision {
  intent: TaskIntent;
  reason: string;
}

const EXPLICIT_VERIFY_PREFIX = /^(verify|confirm|check)\s*:/i;

export function classifyTaskIntent(taskText: string): TaskIntentDecision {
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
