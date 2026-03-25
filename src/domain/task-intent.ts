export type TaskIntent = "verify-only" | "execute-and-verify";

export interface TaskIntentDecision {
  intent: TaskIntent;
  reason: string;
}

const EXPLICIT_VERIFY_PREFIX = /^(?:\[(verify|confirm|validate|check)\]\s*|(verify|confirm|validate|check)\s*:)/i;
const VERIFY_VERB = /\b(verify|confirm|validate|check|assert|ensure)\b/i;
const IMPLEMENTATION_VERB = /\b(implement|add|create|build|refactor|fix|update|write|introduce|remove|rename)\b/i;

export function classifyTaskIntent(taskText: string): TaskIntentDecision {
  const normalized = taskText.trim();

  if (EXPLICIT_VERIFY_PREFIX.test(normalized)) {
    return {
      intent: "verify-only",
      reason: "explicit marker",
    };
  }

  const hasVerifyVerb = VERIFY_VERB.test(normalized);
  const hasImplementationVerb = IMPLEMENTATION_VERB.test(normalized);

  if (hasVerifyVerb && !hasImplementationVerb) {
    return {
      intent: "verify-only",
      reason: "verification-verb fallback",
    };
  }

  return {
    intent: "execute-and-verify",
    reason: hasVerifyVerb && hasImplementationVerb
      ? "mixed intent defaults to execute-and-verify"
      : "default execute-and-verify",
  };
}
