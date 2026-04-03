import type { ProcessRunMode } from "./process-runner.js";

/**
 * Selects how prompt content is delivered to the worker process.
 *
 * `file` writes prompt content to a temporary file and passes the path,
 * while `arg` passes prompt content directly as a command argument.
 */
export type PromptTransport = "file" | "arg";

/**
 * Captures the normalized result of a worker process execution.
 */
export interface WorkerRunResult {
  // Exit status reported by the worker process, or null if unavailable.
  exitCode: number | null;
  // Standard output emitted by the worker process.
  stdout: string;
  // Standard error emitted by the worker process.
  stderr: string;
}

/**
 * Defines options required to execute a worker command.
 *
 * These options control command invocation, prompt transport, trace behavior,
 * output capture, and optional artifact metadata for persisted run records.
 */
export interface WorkerExecutionOptions {
  // Full command and arguments used to launch the worker process.
  command: string[];
  // Rendered prompt content sent to the worker.
  prompt: string;
  // Process runner mode controlling execution behavior.
  mode: ProcessRunMode;
  // Strategy used to send prompt content to the worker.
  transport: PromptTransport;
  // Enables trace collection when true.
  trace?: boolean;
  // Captures worker stdout and stderr for later consumption.
  captureOutput?: boolean;
  // Working directory used for command execution.
  cwd: string;
  // Optional configuration directory forwarded to worker runtime.
  configDir?: string;
  // Optional context object recorded alongside artifacts.
  artifactContext?: unknown;
  // Optional artifact phase identifier for run segmentation.
  artifactPhase?: "execute" | "verify" | "repair" | "worker" | "plan" | "discuss";
  // Optional human-readable artifact phase label.
  artifactPhaseLabel?: string;
  // Optional additional metadata attached to generated artifacts.
  artifactExtra?: Record<string, unknown>;
}

/**
 * Provides options for executing a direct inline CLI command.
 */
export interface InlineCliExecutionOptions {
  // Optional context object recorded alongside artifacts.
  artifactContext?: unknown;
  // Keeps generated artifacts when true.
  keepArtifacts?: boolean;
  // Optional additional metadata attached to generated artifacts.
  artifactExtra?: Record<string, unknown>;
}

/**
 * Provides options for executing a nested Rundown task invocation.
 *
 * Parent-prefixed options forward execution state from the current worker so
 * child runs can preserve behavior and inheritance semantics.
 */
export interface RundownTaskExecutionOptions {
  // Optional context object recorded alongside artifacts.
  artifactContext?: unknown;
  // Keeps generated artifacts when true.
  keepArtifacts?: boolean;
  // Optional additional metadata attached to generated artifacts.
  artifactExtra?: Record<string, unknown>;
  // Explicit command override used to invoke Rundown.
  rundownCommand?: string[];
  // Parent worker command forwarded to nested execution.
  parentWorkerCommand?: string[];
  // Parent prompt transport mode forwarded to nested execution.
  parentTransport?: string;
  // Parent keep-artifacts flag forwarded to nested execution.
  parentKeepArtifacts?: boolean;
  // Parent output visibility flag forwarded to nested execution.
  parentShowAgentOutput?: boolean;
  // Parent CLI block handling flag forwarded to nested execution.
  parentIgnoreCliBlock?: boolean;
  // Parent verification flag forwarded to nested execution.
  parentVerify?: boolean;
  // Parent no-repair flag forwarded to nested execution.
  parentNoRepair?: boolean;
  // Parent repair attempts limit forwarded to nested execution.
  parentRepairAttempts?: number;
}

/**
 * Explicit delegated rundown subcommands currently supported inline.
 */
export type DelegatedRundownSubcommand = "run" | "make";

/**
 * Defines the worker execution gateway used by domain services.
 *
 * Implementations encapsulate process-level details while exposing uniform
 * methods for raw worker execution, inline CLI invocation, and nested Rundown
 * task execution.
 */
export interface WorkerExecutorPort {
  /** Executes the configured worker command and returns the process result. */
  runWorker(options: WorkerExecutionOptions): Promise<WorkerRunResult>;
  /** Executes an inline CLI command in the provided working directory. */
  executeInlineCli(
    command: string,
    cwd: string,
    options?: InlineCliExecutionOptions,
  ): Promise<WorkerRunResult>;
  /** Executes a nested Rundown task command in the provided working directory. */
  executeRundownTask(
    subcommand: DelegatedRundownSubcommand,
    args: string[],
    cwd: string,
    options?: RundownTaskExecutionOptions,
  ): Promise<WorkerRunResult>;
}
