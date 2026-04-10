import type { ToolResolverPort } from "./ports/tool-resolver-port.js";

/**
 * Supported execution intents inferred from task wording.
 */
export type TaskIntent = "verify-only" | "memory-capture" | "tool-expansion" | "fast-execution" | "parallel-group" | "execute-and-verify";

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
  // Resolved tool template name when intent is tool-expansion.
  toolName?: string;
  // Tool payload text when intent is tool-expansion.
  toolPayload?: string;
}

// Prefix marker that explicitly requests verification without execution.
const EXPLICIT_VERIFY_PREFIX = /^(verify|confirm|check)\s*:/i;
// Prefix marker that requests memory capture execution semantics.
const MEMORY_CAPTURE_PREFIX = /^(memory|memorize|remember|inventory)\s*:\s*/i;
// Prefix marker that groups direct child tasks for parallel execution.
const PARALLEL_GROUP_PREFIX = /^(parallel|concurrent|par)\s*:\s*/i;
// Prefix marker that requests execution without verification.
const FAST_EXECUTION_PREFIX = /^(fast|raw)\s*:/i;

function extractParallelGroupPayload(taskText: string): string | null {
  const prefixMatch = taskText.match(PARALLEL_GROUP_PREFIX);
  if (!prefixMatch) {
    return null;
  }

  return taskText.slice(prefixMatch[0].length).trim();
}

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

function extractToolExpansionParts(taskText: string): {
  toolName: string;
  payload: string;
} | null {
  const separatorIndex = taskText.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }

  const toolName = taskText.slice(0, separatorIndex).trim();
  if (toolName.length === 0) {
    return null;
  }

  return {
    toolName,
    payload: taskText.slice(separatorIndex + 1).trim(),
  };
}

/**
 * Classifies task text into a verification-only or execute-and-verify intent.
 *
 * @param taskText Raw task text selected from the source Markdown item.
 * @returns Intent decision containing both the chosen intent and rationale.
 */
export function classifyTaskIntent(taskText: string, toolResolver?: ToolResolverPort): TaskIntentDecision {
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

  const parallelPayload = extractParallelGroupPayload(normalized);
  if (parallelPayload !== null) {
    return {
      intent: "parallel-group",
      reason: "explicit parallel marker",
      normalizedTaskText: parallelPayload,
      hasEmptyPayload: parallelPayload.length === 0,
    };
  }

  const fastExecutionPrefixMatch = normalized.match(FAST_EXECUTION_PREFIX);
  if (fastExecutionPrefixMatch) {
    const payload = normalized.slice(fastExecutionPrefixMatch[0].length).trim();
    return {
      intent: "fast-execution",
      reason: "explicit fast marker",
      normalizedTaskText: payload,
      hasEmptyPayload: payload.length === 0,
    };
  }

  const toolExpansion = extractToolExpansionParts(normalized);
  if (toolExpansion !== null && toolResolver) {
    const resolvedTool = toolResolver.resolve(toolExpansion.toolName);
    if (resolvedTool) {
      return {
        intent: "tool-expansion",
        reason: "resolved tool template",
        normalizedTaskText: toolExpansion.payload,
        hasEmptyPayload: toolExpansion.payload.length === 0,
        toolName: resolvedTool.name,
        toolPayload: toolExpansion.payload,
      };
    }
  }

  return {
    intent: "execute-and-verify",
    reason: "default",
    normalizedTaskText: normalized,
    hasEmptyPayload: false,
  };
}
