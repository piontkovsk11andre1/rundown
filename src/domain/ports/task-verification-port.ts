import type { Task } from "../parser.js";
import type { ParsedWorkerPattern } from "../worker-pattern.js";
import type { CommandExecutionOptions, CommandExecutor } from "./command-executor.js";
import type { ProcessRunMode } from "./process-runner.js";

/**
 * Defines the complete input required to verify a single migration task.
 *
 * This contract carries both authored content (source/template/context) and
 * runtime execution controls (command, transport, tracing, CLI behavior).
 */
export interface TaskVerificationOptions {
  // The parsed task descriptor selected from the migration source.
  task: Task;
  // Full markdown source that contains the selected task.
  source: string;
  // Source text that appears before the selected task, used as context.
  contextBefore: string;
  // Prompt template used to render the worker verification request.
  template: string;
  // Parsed worker pattern used to execute the verifier worker.
  workerPattern: ParsedWorkerPattern;
  // Optional process execution mode (for example, inherited or captured output).
  mode?: ProcessRunMode;
  // Enables verbose tracing output when true.
  trace?: boolean;
  // Working directory for worker execution.
  cwd?: string;
  // Directory containing configuration files used during verification.
  configDir?: string;
  // Additional template variables merged into prompt rendering.
  templateVars?: Record<string, unknown>;
  // Optional additional environment variables for worker and CLI command execution.
  executionEnv?: Record<string, string>;
  // Opaque artifact context forwarded to the verification implementation.
  artifactContext?: unknown;
  // Optional executor used to run embedded CLI blocks.
  cliBlockExecutor?: CommandExecutor;
  // Optional execution options applied when running CLI block commands.
  cliExecutionOptions?: CommandExecutionOptions;
  // Controls whether CLI block command expansion is enabled.
  cliExpansionEnabled?: boolean;
}

/**
 * Result returned by the verification port.
 */
export interface TaskVerificationResult {
  valid: boolean;
  formatWarning?: string;
}

/**
 * Port abstraction responsible for validating task execution outcomes.
 */
export interface TaskVerificationPort {
  /**
   * Verifies the selected task and returns verification status.
   */
  verify(options: TaskVerificationOptions): Promise<TaskVerificationResult>;
}
