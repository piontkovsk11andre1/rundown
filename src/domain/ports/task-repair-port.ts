import type { Task } from "../parser.js";
import type { ParsedWorkerPattern } from "../worker-pattern.js";
import type { CommandExecutionOptions, CommandExecutor } from "./command-executor.js";
import type { ProcessRunMode } from "./process-runner.js";

/**
 * Defines all inputs required to run a task repair cycle.
 *
 * The repair flow uses these values to build prompts, execute verification
 * commands, and control retry behavior for iterative fixes.
 */
export interface TaskRepairOptions {
  /** Parsed task metadata used to identify and describe the failing item. */
  task: Task;
  /** Full source markdown content that contains the task definition. */
  source: string;
  /** Markdown content that appears before the selected task in the source. */
  contextBefore: string;
  /** Template used to generate the repair prompt sent to the worker. */
  repairTemplate: string;
  /** Template used to generate the verification prompt sent to the worker. */
  verifyTemplate: string;
  /** Parsed worker pattern used to execute the worker process. */
  workerPattern: ParsedWorkerPattern;
  /** Maximum number of repair attempts before the process stops. */
  maxRetries: number;
  /** Optional execution mode for the spawned process. */
  mode?: ProcessRunMode;
  /** Optional callback invoked with raw worker stdout/stderr after each repair attempt. */
  onWorkerOutput?: (stdout: string, stderr: string) => void;
  /** Enables verbose trace output for debugging repair behavior. */
  trace?: boolean;
  /** Working directory used when executing repair and verification steps. */
  cwd?: string;
  /** Directory that contains configuration files needed by the workflow. */
  configDir?: string;
  /** Additional template variables injected into repair and verify templates. */
  templateVars?: Record<string, unknown>;
  /** Optional additional environment variables for worker and CLI command execution. */
  executionEnv?: Record<string, string>;
  /** Optional artifact payload provided as additional repair context. */
  artifactContext?: unknown;
  /** Optional CLI block executor used for command expansion workflows. */
  cliBlockExecutor?: CommandExecutor;
  /** Optional execution options passed to CLI command invocations. */
  cliExecutionOptions?: CommandExecutionOptions;
  /** Enables CLI block expansion before command execution when supported. */
  cliExpansionEnabled?: boolean;
}

/**
 * Represents the outcome of a task repair run.
 */
export interface TaskRepairResult {
  /** Indicates whether validation succeeded after repair attempts. */
  valid: boolean;
  /** Total number of repair attempts performed for this run. */
  attempts: number;
  /** Raw stdout from the last repair worker run, when available. */
  repairStdout?: string;
  /** Raw stdout from the last verification worker run, when available. */
  verificationStdout?: string;
}

export interface TaskResolveAttemptRecord {
  attempt: number;
  repairStdout: string | undefined;
  verificationStdout: string | undefined;
  failureReason: string | null;
}

export interface TaskResolveOptions {
  task: Task;
  source: string;
  contextBefore: string;
  resolveTemplate: string;
  workerPattern: ParsedWorkerPattern;
  verificationFailureMessage: string;
  executionStdout?: string;
  repairAttemptHistory: TaskResolveAttemptRecord[];
  mode?: ProcessRunMode;
  onWorkerOutput?: (stdout: string, stderr: string) => void;
  trace?: boolean;
  cwd?: string;
  configDir?: string;
  templateVars?: Record<string, unknown>;
  executionEnv?: Record<string, string>;
  artifactContext?: unknown;
  cliBlockExecutor?: CommandExecutor;
  cliExecutionOptions?: CommandExecutionOptions;
  cliExpansionEnabled?: boolean;
}

export interface TaskResolveResult {
  resolved: boolean;
  diagnosis: string | null;
}

/**
 * Contract for services that attempt to repair failing tasks.
 */
export interface TaskRepairPort {
  /**
   * Executes the repair workflow and returns validation status and attempt count.
   */
  repair(options: TaskRepairOptions): Promise<TaskRepairResult>;
  resolve?(options: TaskResolveOptions): Promise<TaskResolveResult>;
}
