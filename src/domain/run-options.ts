export interface RunBehaviorInput {
  verify: boolean;
  onlyVerify: boolean;
  noRepair: boolean;
  repairAttempts: number;
}

export interface RunBehavior {
  shouldVerify: boolean;
  onlyVerify: boolean;
  allowRepair: boolean;
  maxRepairAttempts: number;
}

export interface WorkerRequirementInput {
  workerCommand: string[];
  hasConfigWorker: boolean;
  isInlineCli: boolean;
  isRundownTask: boolean;
  shouldVerify: boolean;
  onlyVerify: boolean;
}

export function resolveRunBehavior(input: RunBehaviorInput): RunBehavior {
  const maxRepairAttempts = Number.isFinite(input.repairAttempts) && input.repairAttempts > 0
    ? Math.floor(input.repairAttempts)
    : 0;
  const onlyVerify = input.onlyVerify;
  const shouldVerify = input.verify || onlyVerify;
  const allowRepair = !input.noRepair && maxRepairAttempts > 0;

  return {
    shouldVerify,
    onlyVerify,
    allowRepair,
    maxRepairAttempts,
  };
}

export function requiresWorkerCommand(input: WorkerRequirementInput): boolean {
  if (input.workerCommand.length > 0) {
    return false;
  }

  if (input.hasConfigWorker) {
    return false;
  }

  if (input.isRundownTask) {
    return false;
  }

  if (input.onlyVerify) {
    return true;
  }

  if (!input.isInlineCli) {
    return true;
  }

  return input.shouldVerify;
}
