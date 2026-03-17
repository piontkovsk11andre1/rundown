export interface RunBehaviorInput {
  validate: boolean;
  onlyValidate: boolean;
  noCorrect: boolean;
  retries: number;
}

export interface RunBehavior {
  shouldValidate: boolean;
  onlyValidate: boolean;
  allowCorrection: boolean;
  maxRetries: number;
}

export interface WorkerRequirementInput {
  workerCommand: string[];
  isInlineCli: boolean;
  shouldValidate: boolean;
  onlyValidate: boolean;
}

export function resolveRunBehavior(input: RunBehaviorInput): RunBehavior {
  const maxRetries = Number.isFinite(input.retries) && input.retries > 0
    ? Math.floor(input.retries)
    : 0;
  const onlyValidate = input.onlyValidate;
  const shouldValidate = input.validate || onlyValidate;
  const allowCorrection = !input.noCorrect && maxRetries > 0;

  return {
    shouldValidate,
    onlyValidate,
    allowCorrection,
    maxRetries,
  };
}

export function requiresWorkerCommand(input: WorkerRequirementInput): boolean {
  if (input.workerCommand.length > 0) {
    return false;
  }

  if (input.onlyValidate) {
    return true;
  }

  if (!input.isInlineCli) {
    return true;
  }

  return input.shouldValidate;
}