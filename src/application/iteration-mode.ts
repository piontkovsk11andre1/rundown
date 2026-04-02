import { classifyTaskIntent } from "../domain/task-intent.js";
import { type Task } from "../domain/parser.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;

/**
 * Represents the effective verification behavior for a single task iteration.
 *
 * `onlyVerify` means execution should be skipped and only verification should run.
 * `shouldVerify` means verification should run at all, including after execution.
 */
export interface IterationVerificationMode {
  onlyVerify: boolean;
  shouldVerify: boolean;
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
  emit: EmitFn;
}): IterationVerificationMode {
  const {
    configuredOnlyVerify,
    configuredShouldVerify,
    forceExecute,
    task,
    emit,
  } = params;

  // Classify the task text so verify-only directives can influence iteration mode.
  const taskIntent = classifyTaskIntent(task.text);
  // Enter verify-only mode when globally configured or when task intent requires it.
  const onlyVerify = configuredOnlyVerify || (taskIntent.intent === "verify-only" && !forceExecute);
  // Verification is required whenever verify mode is configured or verify-only is active.
  const shouldVerify = configuredShouldVerify || onlyVerify;

  // Explain verify-only intent handling when it is task-derived (not globally forced).
  if (!configuredOnlyVerify && taskIntent.intent === "verify-only") {
    if (forceExecute) {
      // Inform the user that explicit force-execute overrides verify-only intent.
      emit({ kind: "info", message: "Task classified as verify-only (" + taskIntent.reason + "), but --force-execute is enabled; running execution." });
    } else {
      // Inform the user that execution is skipped because verify-only intent is honored.
      emit({ kind: "info", message: "Task classified as verify-only (" + taskIntent.reason + "); skipping execution." });
    }
  }

  return { onlyVerify, shouldVerify };
}
