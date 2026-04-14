import { classifyTaskIntent, type TaskIntentDecision } from "../domain/task-intent.js";
import { type Task } from "../domain/parser.js";
import type { ToolResolverPort } from "../domain/ports/tool-resolver-port.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { parsePrefixChain, type PrefixChain } from "../domain/prefix-chain.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

function applyInheritedTaskIntent(taskIntent: TaskIntentDecision, inheritedIntent: Task["intent"]): TaskIntentDecision {
  if (!inheritedIntent || taskIntent.intent !== "execute-and-verify") {
    return taskIntent;
  }

  return {
    ...taskIntent,
    intent: inheritedIntent,
    reason: "inherited directive intent",
  };
}

/**
 * Represents the effective verification behavior for a single task iteration.
 *
 * `onlyVerify` means execution should be skipped and only verification should run.
 * `shouldVerify` means verification should run at all, including after execution.
 */
export interface IterationVerificationMode {
  onlyVerify: boolean;
  shouldVerify: boolean;
  taskIntentDecision: TaskIntentDecision;
  prefixChain: PrefixChain;
}

/**
 * Resolves whether the current iteration should execute, verify, or verify only.
 *
 * The decision combines global CLI/config flags with task-level intent classification.
 * Verify-only intent can be overridden by `--force-execute`, in which case execution
 * proceeds and an informational message is emitted to explain the override.
 */
export function resolveIterationVerificationMode(params: {
  configuredOnlyVerify: boolean;
  configuredShouldVerify: boolean;
  forceExecute: boolean;
  task: Task;
  toolResolver?: ToolResolverPort;
  emit: EmitFn;
}): IterationVerificationMode {
  const {
    configuredOnlyVerify,
    configuredShouldVerify,
    forceExecute,
    task,
    toolResolver,
    emit,
  } = params;

  // Classify explicit text prefixes, then apply any inherited parser directive intent.
  const taskIntent = applyInheritedTaskIntent(
    classifyTaskIntent(task.text, toolResolver),
    task.intent,
  );
  // Parse the unified prefix chain for tool-based dispatch.
  const prefixChain = parsePrefixChain(task.text, toolResolver);

  // Determine verify-only from either legacy intent or prefix chain handler.
  const prefixChainIsVerifyOnly = prefixChain.handler?.tool.frontmatter?.skipExecution === true
    && prefixChain.handler?.tool.frontmatter?.shouldVerify === true;
  const isFastExecution = taskIntent.intent === "fast-execution";
  const isTaskIntentVerifyOnly = taskIntent.intent === "verify-only";
  const hasTaskDerivedVerifyOnly = isTaskIntentVerifyOnly || prefixChainIsVerifyOnly;
  const shouldSkipExecutionForVerifyOnly = hasTaskDerivedVerifyOnly && !forceExecute;
  // Enter verify-only mode when globally configured or when task intent requires it,
  // unless the task is explicitly marked as fast-execution.
  const onlyVerify = !isFastExecution
    && (configuredOnlyVerify || shouldSkipExecutionForVerifyOnly);
  // Verification is required whenever verify mode is configured or verify-only is active,
  // except for explicit fast-execution tasks.
  const shouldVerify = !isFastExecution && (configuredShouldVerify || onlyVerify);

  // Explain verify-only intent handling when it is task-derived (not globally forced).
  if (!isFastExecution && !configuredOnlyVerify && hasTaskDerivedVerifyOnly) {
    if (forceExecute) {
      // Inform the user that explicit force-execute overrides verify-only intent.
      emit({ kind: "info", message: "Task classified as verify-only (" + taskIntent.reason + "), but --force-execute is enabled; running execution." });
    } else {
      // Inform the user that execution is skipped because verify-only intent is honored.
      emit({ kind: "info", message: "Task classified as verify-only (" + taskIntent.reason + "); skipping execution." });
    }
  }

  if (isFastExecution && (configuredShouldVerify || configuredOnlyVerify || hasTaskDerivedVerifyOnly)) {
    emit({ kind: "info", message: "Task uses fast/raw/quick intent (" + taskIntent.reason + "); skipping verification." });
  }

  return { onlyVerify, shouldVerify, taskIntentDecision: taskIntent, prefixChain };
}
