import type { Task } from "../domain/parser.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type {
  CommandExecutionOptions,
  CommandExecutor,
  TaskRepairPort,
  TaskVerificationPort,
  TraceWriterPort,
  VerificationStore,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import {
  createRepairAttemptEvent,
  createRepairOutcomeEvent,
  createVerificationEfficiencyEvent,
  createVerificationResultEvent,
} from "../domain/trace.js";

type ArtifactContext = any;

/**
 * Dependency ports required to verify a task and optionally run repair attempts.
 */
export interface VerifyRepairLoopDependencies {
  taskVerification: TaskVerificationPort;
  taskRepair: TaskRepairPort;
  verificationStore: VerificationStore;
  traceWriter: TraceWriterPort;
  output: ApplicationOutputPort;
}

/**
 * Runtime inputs needed to execute a verify-then-repair loop for a single task.
 */
export interface VerifyRepairLoopInput {
  task: Task;
  source: string;
  contextBefore: string;
  verifyTemplate: string;
  repairTemplate: string;
  workerPattern: ParsedWorkerPattern;
  configDir?: string;
  maxRepairAttempts: number;
  allowRepair: boolean;
  templateVars: Record<string, unknown>;
  executionEnv?: Record<string, string>;
  artifactContext: ArtifactContext;
  trace: boolean;
  showAgentOutput?: boolean;
  verbose?: boolean;
  cliBlockExecutor?: CommandExecutor;
  cliExecutionOptions?: CommandExecutionOptions;
  cliExpansionEnabled?: boolean;
}

/**
 * Final verification status returned by the verify/repair orchestration.
 */
export interface VerifyRepairLoopResult {
  valid: boolean;
  failureReason: string | null;
}

/**
 * Runs initial verification and, when allowed, retries task repair until success or exhaustion.
 */
export async function runVerifyRepairLoop(
  dependencies: VerifyRepairLoopDependencies,
  input: VerifyRepairLoopInput,
): Promise<VerifyRepairLoopResult> {
  const emit = dependencies.output.emit.bind(dependencies.output);
  const emitWorkerOutput = (stdout: string, stderr: string): void => {
    if (!input.showAgentOutput) {
      return;
    }

    if (stdout.trim().length > 0) {
      emit({ kind: "text", text: stdout });
    }

    if (stderr.trim().length > 0) {
      emit({ kind: "stderr", text: stderr });
    }
  };
  const repairIndent = "  ";
  const indentRepairMessage = (message: string): string => `${repairIndent}${message}`;
  const formatRepairAttempt = (attemptNumber: number): string => "Repair attempt "
    + attemptNumber + " of " + input.maxRepairAttempts;
  // Trace events are tied to a run id derived from artifact context.
  const runId = resolveTraceRunId(input.artifactContext);
  // Emits pass/fail details for each verification attempt.
  const emitVerificationResult = (valid: boolean, attemptNumber: number): void => {
    if (!input.trace || !runId) {
      return;
    }

    dependencies.traceWriter.write(createVerificationResultEvent({
      timestamp: new Date().toISOString(),
      run_id: runId,
      payload: {
        outcome: valid ? "pass" : "fail",
        failure_reason: valid
          ? null
          : dependencies.verificationStore.read(input.task) ?? "Verification failed (no details).",
        attempt_number: attemptNumber,
      },
    }));
  };

  // Emits metadata before each repair attempt starts.
  const emitRepairAttempt = (attemptNumber: number, previousFailure: string | null): void => {
    if (!input.trace || !runId) {
      return;
    }

    dependencies.traceWriter.write(createRepairAttemptEvent({
      timestamp: new Date().toISOString(),
      run_id: runId,
      payload: {
        attempt_number: attemptNumber,
        max_attempts: input.maxRepairAttempts,
        previous_failure: previousFailure,
      },
    }));
  };

  // Emits summary outcome after the repair loop completes.
  const emitRepairOutcome = (finalValid: boolean, totalAttempts: number): void => {
    if (!input.trace || !runId) {
      return;
    }

    dependencies.traceWriter.write(createRepairOutcomeEvent({
      timestamp: new Date().toISOString(),
      run_id: runId,
      payload: {
        final_valid: finalValid,
        total_attempts: totalAttempts,
      },
    }));
  };

  let verifyAttempts = 0;
  let repairAttempts = 0;
  let firstPassSuccess = false;
  const cumulativeFailureReasons: string[] = [];
  let verificationDurationMs = 0;
  let executionDurationMs = 0;

  // Emits aggregate efficiency metrics for verification and repair behavior.
  const emitVerificationEfficiency = (): void => {
    if (!input.trace || !runId) {
      return;
    }

    const verificationToExecutionRatio = executionDurationMs > 0
      ? verificationDurationMs / executionDurationMs
      : null;

    dependencies.traceWriter.write(createVerificationEfficiencyEvent({
      timestamp: new Date().toISOString(),
      run_id: runId,
      payload: {
        first_pass_success: firstPassSuccess,
        total_verify_attempts: verifyAttempts,
        total_repair_attempts: repairAttempts,
        verification_to_execution_ratio: verificationToExecutionRatio,
        cumulative_failure_reasons: cumulativeFailureReasons,
      },
    }));
  };

  // Always run one initial verification before considering repairs.
  if (input.verbose) {
    emit({ kind: "info", message: "Verify phase: running initial verification (attempt 1)." });
    emit({ kind: "info", message: "Running verification..." });
  }

  const initialVerificationStartedAt = Date.now();
  const { valid, formatWarning } = await dependencies.taskVerification.verify({
    task: input.task,
    source: input.source,
    contextBefore: input.contextBefore,
    template: input.verifyTemplate,
    workerPattern: input.workerPattern,
    mode: "wait",
    configDir: input.configDir,
    templateVars: input.templateVars,
    executionEnv: input.executionEnv,
    artifactContext: input.artifactContext,
    onWorkerOutput: emitWorkerOutput,
    trace: input.trace,
    cliBlockExecutor: input.cliBlockExecutor,
    cliExecutionOptions: input.cliExecutionOptions,
    cliExpansionEnabled: input.cliExpansionEnabled,
  });
  verificationDurationMs += Math.max(0, Date.now() - initialVerificationStartedAt);
  verifyAttempts += 1;

  if (formatWarning) {
    emit({ kind: "warn", message: formatWarning });
  }

  const initialFailureReason = valid
    ? null
    : dependencies.verificationStore.read(input.task) ?? "Verification failed (no details).";

  if (initialFailureReason) {
    cumulativeFailureReasons.push(initialFailureReason);
  }

  firstPassSuccess = valid;
  emitVerificationResult(valid, 1);

  // Successful first-pass verification ends the flow immediately.
  if (valid) {
    dependencies.verificationStore.remove(input.task);
    emitVerificationEfficiency();
    emit({ kind: "success", message: "Verify phase complete: verification passed on initial attempt." });
    if (input.verbose) {
      emit({ kind: "success", message: "Verification passed." });
    }
    return { valid: true, failureReason: null };
  }

  // When repair is disabled, return the latest verification failure.
  if (!input.allowRepair) {
    const failureReason = cumulativeFailureReasons.at(-1) ?? initialFailureReason;
    emitRepairOutcome(false, 0);
    emitVerificationEfficiency();
    emit({ kind: "warn", message: "Repair phase skipped: repair is disabled." });
    emit({ kind: "error", message: "Last validation error: " + (failureReason ?? "Verification failed (no details).") });
    return { valid: false, failureReason };
  }

  // Enter repair mode after a failed initial verification.
  const repairWarningReason = initialFailureReason ?? "Verification failed (no details).";
  emit({
    kind: "warn",
    message: "Verification failed: " + repairWarningReason + ". Running repair (" + input.maxRepairAttempts + " attempt(s))...",
  });
  let attempts = 0;
  let previousFailure = dependencies.verificationStore.read(input.task) ?? "Verification failed (no details).";

  while (attempts < input.maxRepairAttempts) {
    attempts += 1;
    repairAttempts = attempts;
    emitRepairAttempt(attempts, previousFailure);
    emit({ kind: "info", message: indentRepairMessage(formatRepairAttempt(attempts) + ": starting...") });

    // Each repair invocation performs one repair cycle and one verification pass.
    const repairStartedAt = Date.now();
    const result = await dependencies.taskRepair.repair({
      task: input.task,
      source: input.source,
      contextBefore: input.contextBefore,
      repairTemplate: input.repairTemplate,
      verifyTemplate: input.verifyTemplate,
      workerPattern: input.workerPattern,
      maxRetries: 1,
      mode: "wait",
      configDir: input.configDir,
      templateVars: input.templateVars,
      executionEnv: input.executionEnv,
      artifactContext: input.artifactContext,
      onWorkerOutput: emitWorkerOutput,
      trace: input.trace,
      cliBlockExecutor: input.cliBlockExecutor,
      cliExecutionOptions: input.cliExecutionOptions,
      cliExpansionEnabled: input.cliExpansionEnabled,
    });
    executionDurationMs += Math.max(0, Date.now() - repairStartedAt);

    verifyAttempts += 1;
    const repairFailureReason = result.valid
      ? null
      : dependencies.verificationStore.read(input.task) ?? "Verification failed (no details).";

    if (repairFailureReason) {
      cumulativeFailureReasons.push(repairFailureReason);
    }
    emitVerificationResult(result.valid, attempts + 1);

    // Stop on first successful repair and clear stored failure details.
    if (result.valid) {
      emitRepairOutcome(true, attempts);
      dependencies.verificationStore.remove(input.task);
      emitVerificationEfficiency();
      emit({ kind: "info", message: indentRepairMessage(formatRepairAttempt(attempts) + ": passed verification.") });
      emit({ kind: "success", message: indentRepairMessage("Repair succeeded after " + attempts + " attempt(s).") });
      return { valid: true, failureReason: null };
    }

    emit({
      kind: "info",
      message: indentRepairMessage(formatRepairAttempt(attempts) + ": failed verification."),
    });
    emit({
      kind: "warn",
      message: indentRepairMessage("Repair attempt " + attempts + " failed: " + (repairFailureReason ?? "Verification failed (no details).")),
    });

    previousFailure = repairFailureReason ?? "Verification failed (no details).";
  }

  // All repair attempts failed; report the most recent failure reason.
  emitRepairOutcome(false, attempts);
  emitVerificationEfficiency();
  emit({ kind: "warn", message: "Repair phase complete: all repair attempts exhausted." });
  const failureReason = cumulativeFailureReasons.at(-1) ?? initialFailureReason;
  emit({ kind: "error", message: "Last validation error: " + (failureReason ?? "Verification failed (no details).") });
  return { valid: false, failureReason };
}

/**
 * Extracts the trace run id from artifact context when present.
 */
function resolveTraceRunId(artifactContext: ArtifactContext): string | null {
  if (!artifactContext || typeof artifactContext !== "object") {
    return null;
  }

  const runId = (artifactContext as { runId?: unknown }).runId;
  return typeof runId === "string" && runId.length > 0
    ? runId
    : null;
}
