import type { Task } from "../parser.js";
import type { CommandExecutionOptions, CommandExecutor } from "./command-executor.js";
import type { ProcessRunMode } from "./process-runner.js";
import type { PromptTransport } from "./worker-executor-port.js";

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
  /** Base command and arguments used to execute the worker process. */
  command: string[];
  /** Maximum number of repair attempts before the process stops. */
  maxRetries: number;
  /** Optional execution mode for the spawned process. */
  mode?: ProcessRunMode;
  /** Optional transport strategy for delivering prompts to the worker. */
  transport?: PromptTransport;
  /** Enables verbose trace output for debugging repair behavior. */
  trace?: boolean;
  /** Working directory used when executing repair and verification steps. */
  cwd?: string;
  /** Directory that contains configuration files needed by the workflow. */
  configDir?: string;
  /** Additional template variables injected into repair and verify templates. */
  templateVars?: Record<string, unknown>;
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
}

/**
 * Contract for services that attempt to repair failing tasks.
 */
export interface TaskRepairPort {
  /**
   * Executes the repair workflow and returns validation status and attempt count.
   */
  repair(options: TaskRepairOptions): Promise<TaskRepairResult>;
}
