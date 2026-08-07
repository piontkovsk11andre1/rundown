/**
 * Raw run-behavior flags provided by CLI/config input.
 */
export interface RunBehaviorInput {
  // Enables verification after execution.
  verify: boolean;
  // Runs verification without executing task implementation.
  onlyVerify: boolean;
  // Disables repair attempts when verification fails.
  noRepair: boolean;
  // Maximum number of repair retries requested by the user.
  repairAttempts: number;
  // Maximum number of resolve-informed repair retries requested by the user.
  resolveRepairAttempts?: number;
}

/**
 * Normalized run-behavior settings used by orchestration logic.
 */
export interface RunBehavior {
  // Indicates whether any verification phase should run.
  shouldVerify: boolean;
  // Indicates verify-only mode.
  onlyVerify: boolean;
  // Indicates whether repair loops are allowed.
  allowRepair: boolean;
  // Effective repair-attempt ceiling after normalization.
  maxRepairAttempts: number;
  // Effective resolve-informed repair-attempt ceiling after normalization.
  maxResolveRepairAttempts: number;
}

/**
 * Inputs required to decide whether a worker command must be provided.
 */
export interface WorkerRequirementInput {
  // Explicit worker command configured for this run.
  workerCommand: string[];
  // True when a worker is defined in configuration.
  hasConfigWorker: boolean;
  // True when the selected task is represented by an inline CLI block.
  isInlineCli: boolean;
  // Effective verification flag for this run.
  shouldVerify: boolean;
  // True when execution is skipped and only verification is requested.
  onlyVerify: boolean;
}

/**
 * Converts raw behavior flags into normalized execution/verification settings.
 *
 * @param input Raw run-behavior input flags.
 * @returns Normalized behavior used by the run pipeline.
 */
export function resolveRunBehavior(input: RunBehaviorInput): RunBehavior {
  // Clamp repair attempts to a non-negative integer.
  const maxRepairAttempts = Number.isFinite(input.repairAttempts) && input.repairAttempts > 0
    ? Math.floor(input.repairAttempts)
    : 0;
  const resolveRepairAttempts = input.resolveRepairAttempts ?? 1;
  const maxResolveRepairAttempts = Number.isFinite(resolveRepairAttempts)
    && resolveRepairAttempts > 0
    ? Math.floor(resolveRepairAttempts)
    : 1;
  // Preserve explicit verify-only mode.
  const onlyVerify = input.onlyVerify;
  // Verify when requested directly or implied by verify-only mode.
  const shouldVerify = input.verify || onlyVerify;
  // Repair is allowed only when not disabled and attempts are available.
  const allowRepair = !input.noRepair && maxRepairAttempts > 0;

  return {
    shouldVerify,
    onlyVerify,
    allowRepair,
    maxRepairAttempts,
    maxResolveRepairAttempts,
  };
}

/**
 * Determines whether the current run requires an explicit worker command.
 *
 * @param input Worker resolution inputs for the run.
 * @returns `true` when no implicit worker source applies.
 */
export function requiresWorkerCommand(input: WorkerRequirementInput): boolean {
  // A command provided directly by CLI always satisfies the requirement.
  if (input.workerCommand.length > 0) {
    return false;
  }

  // Config-defined workers also satisfy the requirement.
  if (input.hasConfigWorker) {
    return false;
  }

  // Verify-only mode always requires a worker to perform verification.
  if (input.onlyVerify) {
    return true;
  }

  // Non-inline tasks require a worker command to execute.
  if (!input.isInlineCli) {
    return true;
  }

  // Inline CLI tasks require a worker only when verification is enabled.
  return input.shouldVerify;
}
