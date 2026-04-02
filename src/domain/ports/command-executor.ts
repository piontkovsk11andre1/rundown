/**
 * Captures the normalized result of a command execution.
 */
export interface CommandResult {
  // Exit status returned by the command process, or null if unavailable.
  exitCode: number | null;
  // Standard output emitted by the command process.
  stdout: string;
  // Standard error emitted by the command process.
  stderr: string;
}

/**
 * Defines optional controls and metadata for command execution.
 */
export interface CommandExecutionOptions {
  // Maximum execution time in milliseconds before timeout handling applies.
  timeoutMs?: number;
  // Optional context object recorded alongside generated artifacts.
  artifactContext?: unknown;
  // Optional artifact phase identifier used for run segmentation.
  artifactPhase?: "execute" | "verify" | "repair" | "worker" | "plan" | "discuss";
  // Optional human-readable label for the artifact phase.
  artifactPhaseLabel?: string;
  // Optional additional metadata attached to generated artifacts.
  artifactExtra?: Record<string, unknown>;
  // Optional sequence number for this command within a larger execution.
  artifactCommandOrdinal?: number;
  // Optional callback invoked after command completion with execution metrics.
  onCommandExecuted?: (execution: {
    // Raw command string that was executed.
    command: string;
    // Exit status returned by the command process, or null if unavailable.
    exitCode: number | null;
    // Number of characters written to standard output.
    stdoutLength: number;
    // Number of characters written to standard error.
    stderrLength: number;
    // Total command runtime in milliseconds.
    durationMs: number;
  }) => void | Promise<void>;
}

/** Default timeout, in milliseconds, for CLI block command execution. */
export const DEFAULT_CLI_BLOCK_EXEC_TIMEOUT_MS = 30_000;

/**
 * Defines the command execution gateway used by domain services.
 */
export interface CommandExecutor {
  /**
   * Executes a command in the provided working directory.
   *
   * Returns normalized process output and exit status for downstream handling.
   */
  execute(
    command: string,
    cwd: string,
    options?: CommandExecutionOptions,
  ): Promise<CommandResult>;
}
