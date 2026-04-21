import type { Task } from "../domain/parser.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type {
  CommandExecutionOptions,
  CommandExecutor,
  ProcessRunMode,
  TaskRepairPort,
  TaskVerificationPort,
  TraceWriterPort,
  VerificationStore,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import {
  createRepairAttemptEvent,
  createRepairOutcomeEvent,
  createResolveAttemptEvent,
  createResolveOutcomeEvent,
  createUsageLimitDetectedEvent,
  createVerificationEfficiencyEvent,
  createVerificationResultEvent,
} from "../domain/trace.js";
import {
  areOutputsSuspiciouslySimilar,
  containsKnownUsageLimitPattern,
} from "../domain/services/output-similarity.js";
import { msg, type LocaleMessages } from "../domain/locale.js";

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
  resolveTemplate?: string;
  executionStdout?: string;
  workerPattern: ParsedWorkerPattern;
  resolveWorkerPattern?: (input: {
    phase: "verify" | "repair" | "resolve" | "resolveRepair";
    attempt?: number;
  }) => ParsedWorkerPattern;
  configDir?: string;
  maxRepairAttempts: number;
  maxResolveRepairAttempts?: number;
  allowRepair: boolean;
  templateVars: Record<string, unknown>;
  lastValidationError?: string;
  targetArtifactPath?: string;
  targetArtifactPathDisplay?: string;
  controllingTaskPath?: string;
  controllingTaskPathDisplay?: string;
  controllingTaskFile?: string;
  selectedTaskMetadata?: string;
  executionEnv?: Record<string, string>;
  artifactContext: ArtifactContext;
  trace: boolean;
  showAgentOutput?: boolean;
  verbose?: boolean;
  cliBlockExecutor?: CommandExecutor;
  cliExecutionOptions?: CommandExecutionOptions;
  cliExpansionEnabled?: boolean;
  runMode?: ProcessRunMode;
  executionOutputCaptured?: boolean;
  isInlineCliTask?: boolean;
  isToolExpansionTask?: boolean;
  onVerificationEfficiency?: (metrics: { verifyAttempts: number; repairAttempts: number }) => void;
  localeMessages?: LocaleMessages;
}

/**
 * Final verification status returned by the verify/repair orchestration.
 */
export interface VerifyRepairLoopResult {
  valid: boolean;
  failureReason: string | null;
  usageLimitDetected?: boolean;
}

export interface RepairAttemptRecord {
  attempt: number;
  repairStdout: string | undefined;
  verificationStdout: string | undefined;
  failureReason: string | null;
}

interface RepairValidationErrorClassification {
  contentShapeValidationError: string;
  taskStateValidationError: string;
}

/**
 * Runs initial verification and, when allowed, retries task repair until success or exhaustion.
 */
export async function runVerifyRepairLoop(
  dependencies: VerifyRepairLoopDependencies,
  input: VerifyRepairLoopInput,
): Promise<VerifyRepairLoopResult> {
  const resolvePhaseWorkerPattern = (
    phase: "verify" | "repair" | "resolve" | "resolveRepair",
    attempt?: number,
  ): ParsedWorkerPattern => {
    if (!input.resolveWorkerPattern) {
      return input.workerPattern;
    }

    return input.resolveWorkerPattern({ phase, attempt });
  };
  const isExplicitlyEmptyOutput = (stdout: string | undefined): boolean =>
    typeof stdout === "string" && stdout.trim().length === 0;
  const emit = dependencies.output.emit.bind(dependencies.output);
  const localeMessages = input.localeMessages ?? {};
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
  const maxResolveRepairAttempts = Number.isFinite(input.maxResolveRepairAttempts)
    && (input.maxResolveRepairAttempts ?? 0) > 0
    ? Math.floor(input.maxResolveRepairAttempts ?? 1)
    : 1;
  const formatResolveRepairAttempt = (attemptNumber: number): string => "Resolve-informed repair attempt "
    + attemptNumber + " of " + maxResolveRepairAttempts;
  const summarizeDiagnosis = (diagnosis: string | null): string => {
    if (!diagnosis) {
      return "(no diagnosis provided)";
    }

    const normalized = diagnosis.replace(/\s+/g, " ").trim();
    if (normalized.length <= 240) {
      return normalized;
    }

    return normalized.slice(0, 237) + "...";
  };
  const seededResolveDiagnosis = typeof input.templateVars.resolvedDiagnosis === "string"
    && input.templateVars.resolvedDiagnosis.trim().length > 0
    ? input.templateVars.resolvedDiagnosis.trim()
    : null;
  const buildRepairTemplateVars = (
    failureReason: string | null | undefined,
    diagnosis: string | null,
  ): Record<string, unknown> => ({
    ...input.templateVars,
    ...(failureReason !== undefined ? { lastValidationError: failureReason } : {}),
    ...classifyRepairValidationErrors(failureReason),
    ...(diagnosis ? { resolvedDiagnosis: diagnosis } : {}),
    ...(input.targetArtifactPath !== undefined ? { targetArtifactPath: input.targetArtifactPath } : {}),
    ...(input.targetArtifactPathDisplay !== undefined
      ? { targetArtifactPathDisplay: input.targetArtifactPathDisplay }
      : {}),
    ...(input.controllingTaskPath !== undefined ? { controllingTaskPath: input.controllingTaskPath } : {}),
    ...(input.controllingTaskPathDisplay !== undefined
      ? { controllingTaskPathDisplay: input.controllingTaskPathDisplay }
      : {}),
    ...(input.controllingTaskFile !== undefined ? { controllingTaskFile: input.controllingTaskFile } : {}),
    ...(input.selectedTaskMetadata !== undefined ? { selectedTaskMetadata: input.selectedTaskMetadata } : {}),
  });
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

  const emitUsageLimitDetected = (payload: {
    phase: "execute" | "verify" | "repair" | "resolve";
    reason: string;
    similarityDetected: boolean;
    knownPatternDetected: boolean;
    executionStdout: string | null;
    matchedPhase: "execute" | "verify" | "repair" | "resolve";
    matchedStdout: string | null;
  }): void => {
    if (!input.trace || !runId) {
      return;
    }

    dependencies.traceWriter.write(createUsageLimitDetectedEvent({
      timestamp: new Date().toISOString(),
      run_id: runId,
      payload: {
        phase: payload.phase,
        reason: payload.reason,
        similarity_detected: payload.similarityDetected,
        known_pattern_detected: payload.knownPatternDetected,
        execution_stdout: payload.executionStdout,
        matched_phase: payload.matchedPhase,
        matched_stdout: payload.matchedStdout,
      },
    }));
  };

  // Emits metadata when the resolve phase begins.
  const emitResolveAttempt = (previousFailure: string | null, exhaustedRepairAttempts: number): void => {
    if (!input.trace || !runId) {
      return;
    }

    dependencies.traceWriter.write(createResolveAttemptEvent({
      timestamp: new Date().toISOString(),
      run_id: runId,
      payload: {
        exhausted_repair_attempts: exhaustedRepairAttempts,
        max_repair_attempts: input.maxRepairAttempts,
        previous_failure: previousFailure,
      },
    }));
  };

  // Emits resolved/unresolved status after the resolve phase completes.
  const emitResolveOutcome = (resolved: boolean, diagnosis: string | null): void => {
    if (!input.trace || !runId) {
      return;
    }

    dependencies.traceWriter.write(createResolveOutcomeEvent({
      timestamp: new Date().toISOString(),
      run_id: runId,
      payload: {
        resolved,
        diagnosis,
      },
    }));
  };

  const detectUsageLimitInOutputs = (
    phase: "verify" | "repair" | "resolve",
    outputs: Array<{ stdout: string | undefined; matchedPhase: "verify" | "repair" | "resolve" }>,
    similarityFailureReason: string,
    patternFailureReason: string,
  ): VerifyRepairLoopResult | null => {
    if (
      !shouldRunUsageLimitDetection
      || typeof input.executionStdout !== "string"
    ) {
      return null;
    }

    for (const output of outputs) {
      if (typeof output.stdout !== "string") {
        continue;
      }

      if (containsKnownUsageLimitPattern(output.stdout)) {
        emitUsageLimitDetected({
          phase,
          reason: patternFailureReason,
          similarityDetected: false,
          knownPatternDetected: true,
          executionStdout: input.executionStdout,
          matchedPhase: output.matchedPhase,
          matchedStdout: output.stdout,
        });
        cumulativeFailureReasons.push(patternFailureReason);
        emitRepairOutcome(false, totalRepairAttempts);
        emitVerificationEfficiency();
        emit({ kind: "error", message: patternFailureReason });
        return {
          valid: false,
          failureReason: patternFailureReason,
          usageLimitDetected: true,
        };
      }

      if (areOutputsSuspiciouslySimilar(input.executionStdout, output.stdout)) {
        emitUsageLimitDetected({
          phase,
          reason: similarityFailureReason,
          similarityDetected: true,
          knownPatternDetected: false,
          executionStdout: input.executionStdout,
          matchedPhase: output.matchedPhase,
          matchedStdout: output.stdout,
        });
        cumulativeFailureReasons.push(similarityFailureReason);
        emitRepairOutcome(false, totalRepairAttempts);
        emitVerificationEfficiency();
        emit({ kind: "error", message: similarityFailureReason });
        return {
          valid: false,
          failureReason: similarityFailureReason,
          usageLimitDetected: true,
        };
      }
    }

    return null;
  };

  let verifyAttempts = 0;
  let repairAttempts = 0;
  let totalRepairAttempts = 0;
  let firstPassSuccess = false;
  const cumulativeFailureReasons: string[] = [];
  let verificationDurationMs = 0;
  let executionDurationMs = 0;
  const shouldRunUsageLimitDetection = process.env.RUNDOWN_TEST_MODE !== "1"
    && input.runMode !== "detached"
    && (input.runMode !== "tui" || input.executionOutputCaptured === true)
    && input.isInlineCliTask !== true
    && input.isToolExpansionTask !== true;

  // Emits aggregate efficiency metrics for verification and repair behavior.
  const emitVerificationEfficiency = (): void => {
    input.onVerificationEfficiency?.({
      verifyAttempts,
      repairAttempts,
    });

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

  if (
    shouldRunUsageLimitDetection
    &&
    typeof input.executionStdout === "string"
    && containsKnownUsageLimitPattern(input.executionStdout)
  ) {
    const usageLimitFailureReason = "Possible API usage limit detected: execution output matches a known usage-limit or quota error pattern; aborting verify/repair to avoid wasting quota. Please check your API quota and rate-limit status.";
    emitUsageLimitDetected({
      phase: "execute",
      reason: usageLimitFailureReason,
      similarityDetected: false,
      knownPatternDetected: true,
      executionStdout: input.executionStdout,
      matchedPhase: "execute",
      matchedStdout: input.executionStdout,
    });
    cumulativeFailureReasons.push(usageLimitFailureReason);
    emitRepairOutcome(false, 0);
    emitVerificationEfficiency();
    emit({ kind: "error", message: usageLimitFailureReason });
    return {
      valid: false,
      failureReason: usageLimitFailureReason,
      usageLimitDetected: true,
    };
  }

  // Always run one initial verification before considering repairs.
  if (input.verbose) {
    emit({ kind: "info", message: msg("verify.initial-verbose", {}, localeMessages) });
    emit({ kind: "info", message: msg("verify.running-verbose", {}, localeMessages) });
  }

  const initialVerificationStartedAt = Date.now();
  const verifyWorkerPattern = resolvePhaseWorkerPattern("verify", 1);
  const { valid, formatWarning, stdout: verificationStdout } = await dependencies.taskVerification.verify({
    task: input.task,
    source: input.source,
    contextBefore: input.contextBefore,
    template: input.verifyTemplate,
    workerPattern: verifyWorkerPattern,
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

  if (
    shouldRunUsageLimitDetection
    && !valid
    &&
    typeof input.executionStdout === "string"
    && typeof verificationStdout === "string"
    && areOutputsSuspiciouslySimilar(input.executionStdout, verificationStdout)
  ) {
    const usageLimitFailureReason = msg("verify.usage-limit", {}, localeMessages);
    emitUsageLimitDetected({
      phase: "verify",
      reason: usageLimitFailureReason,
      similarityDetected: true,
      knownPatternDetected: false,
      executionStdout: input.executionStdout,
      matchedPhase: "verify",
      matchedStdout: verificationStdout,
    });
    cumulativeFailureReasons.push(usageLimitFailureReason);
    emitRepairOutcome(false, 0);
    emitVerificationEfficiency();
    emit({ kind: "error", message: usageLimitFailureReason });
    return {
      valid: false,
      failureReason: usageLimitFailureReason,
      usageLimitDetected: true,
    };
  }

  if (initialFailureReason) {
    cumulativeFailureReasons.push(initialFailureReason);
  }

  firstPassSuccess = valid;
  emitVerificationResult(valid, 1);

  // Successful first-pass verification ends the flow immediately.
  if (valid) {
    dependencies.verificationStore.remove(input.task);
    emitVerificationEfficiency();
    emit({ kind: "success", message: msg("verify.passed-initial", {}, localeMessages) });
    if (input.verbose) {
      emit({ kind: "success", message: msg("verify.passed-verbose", {}, localeMessages) });
    }
    return { valid: true, failureReason: null };
  }

  // When repair is disabled, return the latest verification failure.
  if (!input.allowRepair) {
    const failureReason = cumulativeFailureReasons.at(-1) ?? initialFailureReason;
    emitRepairOutcome(false, 0);
    emitVerificationEfficiency();
    emit({ kind: "warn", message: msg("verify.repair-disabled", {}, localeMessages) });
    emit({
      kind: "error",
      message: msg("verify.last-error", {
        reason: failureReason ?? "Verification failed (no details).",
      }, localeMessages),
    });
    return { valid: false, failureReason };
  }

  // Enter repair mode after a failed initial verification.
  const repairWarningReason = initialFailureReason ?? "Verification failed (no details).";
  emit({
    kind: "warn",
    message: msg("verify.repair-starting", {
      reason: repairWarningReason,
      count: String(input.maxRepairAttempts),
    }, localeMessages),
  });
  let attempts = 0;
  let previousFailure = dependencies.verificationStore.read(input.task) ?? "Verification failed (no details).";
  const initialVerificationStdout = verificationStdout;
  const repairAttemptHistory: RepairAttemptRecord[] = [];

  while (attempts < input.maxRepairAttempts) {
    attempts += 1;
    repairAttempts = attempts;
    totalRepairAttempts = attempts;
    emitRepairAttempt(attempts, previousFailure);
    emit({
      kind: "info",
      message: msg("verify.repair-attempt-start", { n: String(attempts) }, localeMessages),
    });

    // Each repair invocation performs one repair cycle and one verification pass.
    const repairStartedAt = Date.now();
    const repairWorkerPattern = resolvePhaseWorkerPattern("repair", attempts);
    const result = await dependencies.taskRepair.repair({
      task: input.task,
      source: input.source,
      contextBefore: input.contextBefore,
      repairTemplate: input.repairTemplate,
      verifyTemplate: input.verifyTemplate,
      workerPattern: repairWorkerPattern,
      maxRetries: 1,
      mode: "wait",
      configDir: input.configDir,
      templateVars: buildRepairTemplateVars(previousFailure, null),
      executionEnv: input.executionEnv,
      artifactContext: input.artifactContext,
      onWorkerOutput: emitWorkerOutput,
      trace: input.trace,
      cliBlockExecutor: input.cliBlockExecutor,
      cliExecutionOptions: input.cliExecutionOptions,
      cliExpansionEnabled: input.cliExpansionEnabled,
    });
    executionDurationMs += Math.max(0, Date.now() - repairStartedAt);

    const attemptRecord: RepairAttemptRecord = {
      attempt: attempts,
      repairStdout: result.repairStdout,
      verificationStdout: result.verificationStdout,
      failureReason: null,
    };
    repairAttemptHistory.push(attemptRecord);

    const allPhaseOutputsEmpty = isExplicitlyEmptyOutput(input.executionStdout)
      && isExplicitlyEmptyOutput(initialVerificationStdout)
      && isExplicitlyEmptyOutput(result.repairStdout)
      && isExplicitlyEmptyOutput(result.verificationStdout);

    if (allPhaseOutputsEmpty) {
      const emptyOutputFailureReason = msg("verify.empty-output", {}, localeMessages);
      attemptRecord.failureReason = emptyOutputFailureReason;
      cumulativeFailureReasons.push(emptyOutputFailureReason);
      emitRepairOutcome(false, attempts);
      emitVerificationEfficiency();
      emit({ kind: "error", message: emptyOutputFailureReason });
      return {
        valid: false,
        failureReason: emptyOutputFailureReason,
      };
    }

    if (
      shouldRunUsageLimitDetection
      && !result.valid
      && typeof input.executionStdout === "string"
    ) {
      const repairOutputMatched = typeof result.repairStdout === "string"
        && areOutputsSuspiciouslySimilar(input.executionStdout, result.repairStdout);
      const reVerificationOutputMatched = typeof result.verificationStdout === "string"
        && areOutputsSuspiciouslySimilar(input.executionStdout, result.verificationStdout);

      if (repairOutputMatched || reVerificationOutputMatched) {
        const usageLimitFailureReason = msg("verify.usage-limit-repair", {}, localeMessages);
        attemptRecord.failureReason = usageLimitFailureReason;
        emitUsageLimitDetected({
          phase: "repair",
          reason: usageLimitFailureReason,
          similarityDetected: true,
          knownPatternDetected: false,
          executionStdout: input.executionStdout,
          matchedPhase: repairOutputMatched ? "repair" : "verify",
          matchedStdout: repairOutputMatched
            ? (result.repairStdout ?? null)
            : (result.verificationStdout ?? null),
        });
        cumulativeFailureReasons.push(usageLimitFailureReason);
        emitRepairOutcome(false, attempts);
        emitVerificationEfficiency();
        emit({ kind: "error", message: usageLimitFailureReason });
        return {
          valid: false,
          failureReason: usageLimitFailureReason,
          usageLimitDetected: true,
        };
      }
    }

    verifyAttempts += 1;
    const repairFailureReason = result.valid
      ? null
      : dependencies.verificationStore.read(input.task) ?? "Verification failed (no details).";
    attemptRecord.failureReason = repairFailureReason;

    if (repairFailureReason) {
      cumulativeFailureReasons.push(repairFailureReason);
    }
    emitVerificationResult(result.valid, attempts + 1);

    // Stop on first successful repair and clear stored failure details.
    if (result.valid) {
      emitRepairOutcome(true, attempts);
      dependencies.verificationStore.remove(input.task);
      emitVerificationEfficiency();
      emit({
        kind: "info",
        message: msg("verify.repair-attempt-passed", { n: String(attempts) }, localeMessages),
      });
      emit({
        kind: "success",
        message: msg("verify.repair-succeeded", { n: String(attempts) }, localeMessages),
      });
      return { valid: true, failureReason: null };
    }

    emit({
      kind: "info",
      message: msg("verify.repair-attempt-failed", { n: String(attempts) }, localeMessages),
    });
    emit({
      kind: "warn",
      message: msg("verify.repair-attempt-warn", {
        n: String(attempts),
        reason: repairFailureReason ?? "Verification failed (no details).",
      }, localeMessages),
    });

    previousFailure = repairFailureReason ?? "Verification failed (no details).";
  }

  let resolveDiagnosis = seededResolveDiagnosis;
  if (!resolveDiagnosis && input.maxRepairAttempts >= 2 && input.resolveTemplate && dependencies.taskRepair.resolve) {
    emitResolveAttempt(previousFailure, attempts);
    emit({
      kind: "warn",
      message: msg("verify.repair-exhausted", {}, localeMessages),
    });
    emit({
      kind: "info",
      message: msg("verify.resolve-collecting", { count: String(attempts) }, localeMessages),
    });

    const resolveResult = await dependencies.taskRepair.resolve({
      task: input.task,
      source: input.source,
      contextBefore: input.contextBefore,
      resolveTemplate: input.resolveTemplate,
      workerPattern: resolvePhaseWorkerPattern("resolve"),
      verificationFailureMessage: previousFailure,
      executionStdout: input.executionStdout,
      repairAttemptHistory,
      mode: "wait",
      configDir: input.configDir,
      templateVars: buildRepairTemplateVars(previousFailure, null),
      executionEnv: input.executionEnv,
      artifactContext: input.artifactContext,
      onWorkerOutput: emitWorkerOutput,
      trace: input.trace,
      cliBlockExecutor: input.cliBlockExecutor,
      cliExecutionOptions: input.cliExecutionOptions,
      cliExpansionEnabled: input.cliExpansionEnabled,
    });

    emitResolveOutcome(resolveResult.resolved, resolveResult.diagnosis);

    const resolveFailureReason = resolveResult.diagnosis ?? "Resolve phase returned no diagnosis.";
    if (!resolveResult.resolved) {
      cumulativeFailureReasons.push(resolveFailureReason);
      emit({
        kind: "warn",
        message: msg("verify.resolve-unresolved", {
          diagnosis: summarizeDiagnosis(resolveFailureReason),
        }, localeMessages),
      });
      emitRepairOutcome(false, totalRepairAttempts);
      emitVerificationEfficiency();
      emit({
        kind: "error",
        message: msg("verify.resolve-diagnose-error", {
          reason: resolveFailureReason,
        }, localeMessages),
      });
      return {
        valid: false,
        failureReason: resolveFailureReason,
      };
    }

    resolveDiagnosis = resolveFailureReason;
    emit({
      kind: "success",
      message: msg("verify.resolve-succeeded", {}, localeMessages),
    });
    emit({
      kind: "info",
      message: msg("verify.resolve-diagnosis", {
        diagnosis: summarizeDiagnosis(resolveDiagnosis),
      }, localeMessages),
    });
    emit({
      kind: "info",
      message: "Resolve phase identified a diagnosis; running resolve-informed repair.",
    });
  }

  if (resolveDiagnosis && maxResolveRepairAttempts > 0) {
    const resolveOutputUsageLimitResult = detectUsageLimitInOutputs(
      "resolve",
      [{ stdout: resolveDiagnosis, matchedPhase: "resolve" }],
      "Possible API usage limit detected: resolve output is identical or near-identical to execution output; aborting verify/repair to avoid wasting quota. Please check your API quota and rate-limit status.",
      "Possible API usage limit detected: resolve output matches a known usage-limit or quota error pattern; aborting verify/repair to avoid wasting quota. Please check your API quota and rate-limit status.",
    );
    if (resolveOutputUsageLimitResult) {
      return resolveOutputUsageLimitResult;
    }

    emit({
      kind: "warn",
      message: "Resolve-informed repair phase: attempting up to "
        + maxResolveRepairAttempts
        + " repair attempt(s) using diagnosis context.",
    });

    let resolveRepairAttempts = 0;
    while (resolveRepairAttempts < maxResolveRepairAttempts) {
      resolveRepairAttempts += 1;
      repairAttempts = attempts + resolveRepairAttempts;
      totalRepairAttempts = repairAttempts;
      emit({
        kind: "info",
        message: indentRepairMessage("Applying resolve diagnosis to repair attempt "
          + resolveRepairAttempts
          + "."),
      });
      emit({
        kind: "info",
        message: indentRepairMessage(formatResolveRepairAttempt(resolveRepairAttempts) + ": starting..."),
      });

      const resolveRepairResult = await dependencies.taskRepair.repair({
        task: input.task,
        source: input.source,
        contextBefore: input.contextBefore,
        repairTemplate: input.repairTemplate,
        verifyTemplate: input.verifyTemplate,
        workerPattern: resolvePhaseWorkerPattern("resolveRepair", resolveRepairAttempts),
        maxRetries: 1,
        mode: "wait",
        configDir: input.configDir,
        templateVars: buildRepairTemplateVars(previousFailure, resolveDiagnosis),
        executionEnv: input.executionEnv,
        artifactContext: input.artifactContext,
        onWorkerOutput: emitWorkerOutput,
        trace: input.trace,
        cliBlockExecutor: input.cliBlockExecutor,
        cliExecutionOptions: input.cliExecutionOptions,
        cliExpansionEnabled: input.cliExpansionEnabled,
      });

      const resolveRepairUsageLimitResult = detectUsageLimitInOutputs(
        "repair",
        [
          { stdout: resolveRepairResult.repairStdout, matchedPhase: "repair" },
          { stdout: resolveRepairResult.verificationStdout, matchedPhase: "verify" },
        ],
        "Possible API usage limit detected: identical or near-identical responses across execution and resolve-informed repair phases; aborting verify/repair to avoid wasting quota. Please check your API quota and rate-limit status.",
        "Possible API usage limit detected: resolve-informed repair output matches a known usage-limit or quota error pattern; aborting verify/repair to avoid wasting quota. Please check your API quota and rate-limit status.",
      );
      if (resolveRepairUsageLimitResult) {
        return resolveRepairUsageLimitResult;
      }

      verifyAttempts += 1;
      const resolveRepairFailureReason = resolveRepairResult.valid
        ? null
        : dependencies.verificationStore.read(input.task) ?? "Verification failed (no details).";
      if (resolveRepairFailureReason) {
        cumulativeFailureReasons.push(resolveRepairFailureReason);
      }
      emitVerificationResult(resolveRepairResult.valid, attempts + resolveRepairAttempts + 1);

      if (resolveRepairResult.valid) {
        emitRepairOutcome(true, attempts + resolveRepairAttempts);
        dependencies.verificationStore.remove(input.task);
        emitVerificationEfficiency();
        emit({
          kind: "success",
          message: indentRepairMessage("Resolve-informed repair succeeded after "
            + resolveRepairAttempts
            + " attempt(s)."),
        });
        return { valid: true, failureReason: null };
      }

      emit({
        kind: "warn",
        message: indentRepairMessage(formatResolveRepairAttempt(resolveRepairAttempts)
          + ": failed verification: "
          + (resolveRepairFailureReason ?? "Verification failed (no details).")),
      });
      previousFailure = resolveRepairFailureReason ?? "Verification failed (no details).";
    }

    emit({
      kind: "error",
      message: "Resolve-informed repair attempts exhausted after "
        + maxResolveRepairAttempts
        + " attempt(s).",
    });
  }

  // All repair attempts failed; report the most recent failure reason.
  emitRepairOutcome(false, totalRepairAttempts);
  emitVerificationEfficiency();
  emit({ kind: "warn", message: "Repair phase complete: all repair attempts exhausted." });
  const failureReason = cumulativeFailureReasons.at(-1) ?? initialFailureReason;
  emit({
    kind: "error",
    message: msg("verify.last-error", {
      reason: failureReason ?? "Verification failed (no details).",
    }, localeMessages),
  });
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

function classifyRepairValidationErrors(
  failureReason: string | null | undefined,
): RepairValidationErrorClassification {
  if (typeof failureReason !== "string") {
    return {
      contentShapeValidationError: "",
      taskStateValidationError: "",
    };
  }

  const normalized = failureReason.trim();
  if (normalized.length === 0) {
    return {
      contentShapeValidationError: "",
      taskStateValidationError: "",
    };
  }

  const taskStatePattern = /\b(unchecked|checkbox|checkmark|task\s+not\s+checked|mark(?:ed|ing)?\s+.*\[x\]|\[x\])\b/i;
  const contentShapePattern = /\b(worker\s+chatter|artifact|markdown|document|content|body|transcript|format|shape|enriched)\b/i;
  const hasTaskStateSignal = taskStatePattern.test(normalized);
  const hasContentShapeSignal = contentShapePattern.test(normalized);

  if (hasTaskStateSignal) {
    return {
      contentShapeValidationError: hasContentShapeSignal ? normalized : "",
      taskStateValidationError: normalized,
    };
  }

  return {
    contentShapeValidationError: normalized,
    taskStateValidationError: "",
  };
}
