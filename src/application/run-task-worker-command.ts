import type { ProcessRunMode } from "../domain/ports/index.js";

/**
 * Run mode accepted by worker-command normalization helpers.
 */
export type RunnerMode = ProcessRunMode;

/**
 * Normalizes the worker command used for automation execution.
 *
 * In TUI mode, OpenCode requires an explicit `run` subcommand when only the
 * executable name is provided, so this helper appends it when needed.
 */
export function getAutomationWorkerCommand(
  workerCommand: string[],
  mode: RunnerMode,
): string[] {
  // Non-TUI modes pass through the command unchanged.
  if (mode !== "tui") {
    return workerCommand;
  }

  // Only OpenCode worker commands need TUI-specific normalization.
  if (!isOpenCodeWorkerCommand(workerCommand)) {
    return workerCommand;
  }

  // Preserve explicit subcommands; otherwise default to `opencode run`.
  return workerCommand.length > 1
    ? workerCommand
    : [workerCommand[0], "run"];
}

/**
 * Detects whether a worker command targets the OpenCode executable.
 *
 * The check supports bare executable names and common OS-specific path forms.
 */
export function isOpenCodeWorkerCommand(workerCommand: string[]): boolean {
  // Empty commands cannot map to a known worker executable.
  if (workerCommand.length === 0) {
    return false;
  }

  // Normalize case so executable matching is platform-consistent.
  const command = workerCommand[0].toLowerCase();
  return command === "opencode"
    || command.endsWith("/opencode")
    || command.endsWith("\\opencode")
    || command.endsWith("/opencode.cmd")
    || command.endsWith("\\opencode.cmd")
    || command.endsWith("/opencode.exe")
    || command.endsWith("\\opencode.exe")
    || command.endsWith("/opencode.ps1")
    || command.endsWith("\\opencode.ps1");
}
