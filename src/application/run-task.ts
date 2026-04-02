/**
 * Backward-compatible entry point for run-task execution exports.
 *
 * This module preserves the historical `run-task` import path while delegating
 * to the implementation split in `run-task-execution.ts`.
 */
export {
  // Factory that builds the full run-command execution pipeline.
  createRunTaskExecution,
  // Legacy alias retained for callers still importing `createRunTask`.
  createRunTaskExecution as createRunTask,
  // Finalizes run artifacts and records terminal run status.
  finalizeRunArtifacts,
  // Resolves worker command arguments for automation-mode execution.
  getAutomationWorkerCommand,
  // Detects whether the configured worker command targets OpenCode.
  isOpenCodeWorkerCommand,
  // Converts selected task data into runtime metadata for execution.
  toRuntimeTaskMetadata,
} from "./run-task-execution.js";

/**
 * Public run-task type surface re-exported for compatibility.
 */
export type {
  // Prompt delivery strategy for worker execution.
  PromptTransport,
  // Required dependencies for constructing the run executor.
  RunTaskDependencies,
  // Runtime options supported by a single run invocation.
  RunTaskOptions,
  // Worker process mode (foreground, detached, etc.).
  RunnerMode,
  // Normalized task metadata consumed during execution.
  RuntimeTaskMetadata,
  // Selected task details returned by task selection.
  TaskSelectionResult,
} from "./run-task-execution.js";
