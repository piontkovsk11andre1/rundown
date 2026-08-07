/**
 * Defines how a process should be executed by the runner.
 */
export type ProcessRunMode = "wait" | "tui" | "detached";

/**
 * Represents all inputs required to execute a process invocation.
 */
export interface ProcessRunOptions {
  // Executable name or full command path to run.
  command: string;
  // Ordered command-line arguments passed to the command.
  args: string[];
  // Working directory where the process should start.
  cwd: string;
  // Execution strategy that controls lifecycle and I/O behavior.
  mode: ProcessRunMode;
  // When true, executes the command through the system shell.
  shell?: boolean;
  // Environment variables merged with the current process environment.
  env?: Record<string, string | undefined>;
  // Maximum runtime in milliseconds before the process is terminated.
  timeoutMs?: number;
}

/**
 * Captures the result produced by a completed process execution.
 */
export interface ProcessRunResult {
  // Exit status reported by the operating system, when available.
  exitCode: number | null;
  // Full standard output captured from the process.
  stdout: string;
  // Full standard error captured from the process.
  stderr: string;
}

/**
 * Port abstraction for executing operating-system processes.
 */
export interface ProcessRunner {
  /**
   * Runs a process using the provided options and returns the captured result.
   */
  run(options: ProcessRunOptions): Promise<ProcessRunResult>;
}
