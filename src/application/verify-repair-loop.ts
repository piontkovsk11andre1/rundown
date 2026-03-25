import type { Task } from "../domain/parser.js";
import type {
  PromptTransport,
  TaskRepairPort,
  TaskVerificationPort,
  VerificationSidecar,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

type ArtifactContext = any;

export interface VerifyRepairLoopDependencies {
  taskVerification: TaskVerificationPort;
  taskRepair: TaskRepairPort;
  verificationSidecar: VerificationSidecar;
  output: ApplicationOutputPort;
}

export interface VerifyRepairLoopInput {
  task: Task;
  source: string;
  contextBefore: string;
  verifyTemplate: string;
  repairTemplate: string;
  workerCommand: string[];
  transport: PromptTransport;
  maxRepairAttempts: number;
  allowRepair: boolean;
  templateVars: Record<string, unknown>;
  artifactContext: ArtifactContext;
}

export async function runVerifyRepairLoop(
  dependencies: VerifyRepairLoopDependencies,
  input: VerifyRepairLoopInput,
): Promise<boolean> {
  const emit = dependencies.output.emit.bind(dependencies.output);
  emit({ kind: "info", message: "Running verification..." });

  const valid = await dependencies.taskVerification.verify({
    task: input.task,
    source: input.source,
    contextBefore: input.contextBefore,
    template: input.verifyTemplate,
    command: input.workerCommand,
    mode: "wait",
    transport: input.transport,
    templateVars: input.templateVars,
    artifactContext: input.artifactContext,
  });

  if (valid) {
    dependencies.verificationSidecar.remove(input.task);
    emit({ kind: "success", message: "Verification passed." });
    return true;
  }

  if (!input.allowRepair) {
    return false;
  }

  emit({ kind: "warn", message: "Verification failed. Running repair (" + input.maxRepairAttempts + " attempt(s))..." });
  const result = await dependencies.taskRepair.repair({
    task: input.task,
    source: input.source,
    contextBefore: input.contextBefore,
    repairTemplate: input.repairTemplate,
    verifyTemplate: input.verifyTemplate,
    command: input.workerCommand,
    maxRetries: input.maxRepairAttempts,
    mode: "wait",
    transport: input.transport,
    templateVars: input.templateVars,
    artifactContext: input.artifactContext,
  });

  if (!result.valid) {
    return false;
  }

  dependencies.verificationSidecar.remove(input.task);
  emit({ kind: "success", message: "Repair succeeded after " + result.attempts + " attempt(s)." });
  return true;
}
