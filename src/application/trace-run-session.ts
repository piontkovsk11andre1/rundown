import type { Task } from "../domain/parser.js";
import type { TraceStatisticsSnapshot } from "../domain/trace-statistics.js";
import {
  createForceRetryEvent,
  createAnalysisSummaryEvent,
  createAgentSignalsEvent,
  createAgentThinkingEvent,
  createAgentToolUsageEvent,
  createOutputVolumeEvent,
  createPhaseCompletedEvent,
  createPhaseStartedEvent,
  createPromptMetricsEvent,
  createRoundCompletedEvent,
  createRoundStartedEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  createTaskCompletedEvent,
  createTaskContextEvent,
  createTaskFailedEvent,
  createTimingWaterfallEvent,
  type AnalysisSummaryPayload,
  type TracePhase,
  type TraceRunStatus,
} from "../domain/trace.js";
import type {
  ArtifactRunContext,
  ArtifactStoreStatus,
  ProcessRunMode,
  TraceWriterPort,
} from "../domain/ports/index.js";
import type { TaskContextMetrics } from "./task-context-resolution.js";
import { countTraceLines } from "./run-task-utils.js";
import { parseTraceWorkerOutputForEvents } from "./trace-artifacts.js";

/**
 * Mutable snapshot that tracks lifecycle data for a single traced run.
 */
interface ActiveTraceRun {
  runId: string;
  task: Task;
  startedAtMs: number;
  totalPhases: number;
  totalCharCount: number;
  totalEstimatedTokens: number;
  totalStdoutBytes: number;
  totalStderrBytes: number;
  verifyAttempts: number;
  repairAttempts: number;
  phaseTimings: Array<{
    phase: TracePhase;
    sequence: number;
    startedAtMs: number;
    startedAtIso: string;
    completedAtMs: number;
    completedAtIso: string;
    durationMs: number;
  }>;
  taskOutcomeEmitted: boolean;
  timingWaterfallEmitted: boolean;
  pendingAnalysisSummary: AnalysisSummaryPayload | null;
  completed: boolean;
}

/**
 * Captured timing information for one completed execution phase.
 */
interface PhaseTiming {
  phase: TracePhase;
  sequence: number;
  startedAtMs: number;
  startedAtIso: string;
  completedAtMs: number;
  completedAtIso: string;
  durationMs: number;
}

/**
 * Handle returned when a phase starts and used to complete that phase later.
 */
export interface PhaseTraceHandle {
  phase: TracePhase;
  sequence: number;
  startedAtMs: number;
  startedAtIso: string;
}

/**
 * In-memory state container for emitting run and phase trace events safely.
 */
class TraceRunSessionState {
  private activeTraceRun: ActiveTraceRun | null = null;

  /**
   * Initializes state for a newly selected run.
   */
  start(runId: string, task: Task, startedAtMs: number): void {
    this.activeTraceRun = {
      runId,
      task,
      startedAtMs,
      totalPhases: 0,
      totalCharCount: 0,
      totalEstimatedTokens: 0,
      totalStdoutBytes: 0,
      totalStderrBytes: 0,
      verifyAttempts: 0,
      repairAttempts: 0,
      phaseTimings: [],
      taskOutcomeEmitted: false,
      timingWaterfallEmitted: false,
      pendingAnalysisSummary: null,
      completed: false,
    };
  }

  /**
   * Records a phase start and returns the generated sequencing metadata.
   */
  beginPhase(phase: TracePhase, startedAtMs: number, startedAtIso: string): { runId: string; handle: PhaseTraceHandle } | null {
    if (!this.activeTraceRun) {
      return null;
    }

    const sequence = this.activeTraceRun.totalPhases + 1;
    this.activeTraceRun.totalPhases = sequence;
    return {
      runId: this.activeTraceRun.runId,
      handle: {
        phase,
        sequence,
        startedAtMs,
        startedAtIso,
      },
    };
  }

  /**
   * Finalizes a phase timing record and stores it in run state.
   */
  completePhase(
    phaseTrace: PhaseTraceHandle,
    completedAtMs: number,
    completedAtIso: string,
    stdoutBytes: number,
    stderrBytes: number,
  ): { runId: string; durationMs: number } | null {
    if (!this.activeTraceRun) {
      return null;
    }

    const durationMs = Math.max(0, completedAtMs - phaseTrace.startedAtMs);
    const phaseTiming: PhaseTiming = {
      phase: phaseTrace.phase,
      sequence: phaseTrace.sequence,
      startedAtMs: phaseTrace.startedAtMs,
      startedAtIso: phaseTrace.startedAtIso,
      completedAtMs,
      completedAtIso,
      durationMs,
    };

    this.activeTraceRun.phaseTimings.push(phaseTiming);
    this.activeTraceRun.totalStdoutBytes += stdoutBytes;
    this.activeTraceRun.totalStderrBytes += stderrBytes;
    return {
      runId: this.activeTraceRun.runId,
      durationMs,
    };
  }

  /**
   * Adds prompt-size metrics into the active run totals.
   */
  accumulatePromptMetrics(charCount: number, estimatedTokens: number): void {
    if (!this.activeTraceRun) {
      return;
    }

    this.activeTraceRun.totalCharCount += charCount;
    this.activeTraceRun.totalEstimatedTokens += estimatedTokens;
  }

  /**
   * Captures aggregate verification and repair attempt counters.
   */
  setVerificationEfficiency(verifyAttempts: number, repairAttempts: number): void {
    if (!this.activeTraceRun) {
      return;
    }

    this.activeTraceRun.verifyAttempts = Math.max(0, verifyAttempts);
    this.activeTraceRun.repairAttempts = Math.max(0, repairAttempts);
  }

  /**
   * Builds a trace-statistics snapshot from active run state.
   */
  collectStatistics(nowMs: number): TraceStatisticsSnapshot | null {
    if (!this.activeTraceRun) {
      return null;
    }

    const orderedPhaseTimings = [...this.activeTraceRun.phaseTimings]
      .sort((a, b) => a.sequence - b.sequence);

    const phaseDurationsMs = orderedPhaseTimings.reduce((totals, phaseTiming) => {
      if (phaseTiming.phase === "execute" || phaseTiming.phase === "verify" || phaseTiming.phase === "repair") {
        totals[phaseTiming.phase] += phaseTiming.durationMs;
      }
      return totals;
    }, {
      execute: 0,
      verify: 0,
      repair: 0,
    });

    let idleTimeMs = 0;
    for (let index = 1; index < orderedPhaseTimings.length; index++) {
      const previous = orderedPhaseTimings[index - 1];
      const current = orderedPhaseTimings[index];
      if (!previous || !current) {
        continue;
      }

      idleTimeMs += Math.max(0, current.startedAtMs - previous.completedAtMs);
    }

    const totalDurationMs = Math.max(0, nowMs - this.activeTraceRun.startedAtMs);

    return {
      fields: {
        total_time: totalDurationMs,
        execution_time: phaseDurationsMs.execute,
        verify_time: phaseDurationsMs.verify,
        repair_time: phaseDurationsMs.repair,
        idle_time: idleTimeMs,
        tokens_estimated: this.activeTraceRun.totalEstimatedTokens,
        phases_count: this.activeTraceRun.totalPhases,
        verify_attempts: this.activeTraceRun.verifyAttempts,
        repair_attempts: this.activeTraceRun.repairAttempts,
      },
    };
  }

  /**
   * Returns the active run identifier when tracing is active.
   */
  getRunId(): string | null {
    return this.activeTraceRun?.runId ?? null;
  }

  /**
   * Returns the epoch start time for the active run.
   */
  getStartedAtMs(): number | null {
    return this.activeTraceRun?.startedAtMs ?? null;
  }

  /**
   * Indicates whether run state is currently initialized.
   */
  hasActiveRun(): boolean {
    return this.activeTraceRun !== null;
  }

  /**
   * Returns data needed to emit a terminal task outcome event once.
   */
  getTaskOutcomeContext(): {
    runId: string;
    task: Task;
    startedAtMs: number;
    totalPhases: number;
  } | null {
    if (!this.activeTraceRun || this.activeTraceRun.taskOutcomeEmitted) {
      return null;
    }

    return {
      runId: this.activeTraceRun.runId,
      task: this.activeTraceRun.task,
      startedAtMs: this.activeTraceRun.startedAtMs,
      totalPhases: this.activeTraceRun.totalPhases,
    };
  }

  /**
   * Marks the task outcome event as already emitted for the active run.
   */
  markTaskOutcomeEmitted(): void {
    if (!this.activeTraceRun) {
      return;
    }

    this.activeTraceRun.taskOutcomeEmitted = true;
  }

  /**
   * Returns phase timing data needed to emit the timing waterfall once.
   */
  getTimingWaterfallContext(): {
    runId: string;
    startedAtMs: number;
    phaseTimings: PhaseTiming[];
  } | null {
    if (!this.activeTraceRun || this.activeTraceRun.timingWaterfallEmitted) {
      return null;
    }

    return {
      runId: this.activeTraceRun.runId,
      startedAtMs: this.activeTraceRun.startedAtMs,
      phaseTimings: [...this.activeTraceRun.phaseTimings],
    };
  }

  /**
   * Marks the timing waterfall event as already emitted.
   */
  markTimingWaterfallEmitted(): void {
    if (!this.activeTraceRun) {
      return;
    }

    this.activeTraceRun.timingWaterfallEmitted = true;
  }

  /**
   * Returns run-level completion data when completion has not been emitted.
   */
  getRunCompletedContext(): {
    runId: string;
    startedAtMs: number;
    totalPhases: number;
  } | null {
    if (!this.activeTraceRun || this.activeTraceRun.completed) {
      return null;
    }

    return {
      runId: this.activeTraceRun.runId,
      startedAtMs: this.activeTraceRun.startedAtMs,
      totalPhases: this.activeTraceRun.totalPhases,
    };
  }

  /**
   * Marks the run-completed event as emitted.
   */
  markRunCompleted(): void {
    if (!this.activeTraceRun) {
      return;
    }

    this.activeTraceRun.completed = true;
  }

  /**
   * Queues an analysis summary so it can be written after phase output events.
   */
  queueAnalysisSummary(payload: AnalysisSummaryPayload): void {
    if (!this.activeTraceRun) {
      return;
    }

    this.activeTraceRun.pendingAnalysisSummary = payload;
  }

  /**
   * Returns and clears the queued analysis summary payload.
   */
  takePendingAnalysisSummary(): { runId: string; payload: AnalysisSummaryPayload } | null {
    if (!this.activeTraceRun || !this.activeTraceRun.pendingAnalysisSummary) {
      return null;
    }

    const summary = {
      runId: this.activeTraceRun.runId,
      payload: this.activeTraceRun.pendingAnalysisSummary,
    };
    this.activeTraceRun.pendingAnalysisSummary = null;
    return summary;
  }

  /**
   * Clears all active run state.
   */
  reset(): void {
    this.activeTraceRun = null;
  }
}

/**
 * Creates a trace session controller that emits structured run telemetry.
 */
export function createTraceRunSession(config: {
  getTraceWriter: () => TraceWriterPort;
  source: string;
  mode: ProcessRunMode;
  transport: string;
  traceEnabled: boolean;
}) {
  const sessionState = new TraceRunSessionState();

  const nowIso = (): string => new Date().toISOString();
  const toTraceStatus = (status: ArtifactStoreStatus): TraceRunStatus => status;

  /**
   * Starts a new traced phase and emits the corresponding phase-start event.
   */
  const beginPhase = (phase: TracePhase, command: string[]): PhaseTraceHandle | null => {
    const phaseStart = sessionState.beginPhase(phase, Date.now(), nowIso());
    if (!phaseStart) {
      return null;
    }

    config.getTraceWriter().write(createPhaseStartedEvent({
      timestamp: phaseStart.handle.startedAtIso,
      run_id: phaseStart.runId,
      payload: {
        phase,
        sequence: phaseStart.handle.sequence,
        command,
      },
    }));

    return phaseStart.handle;
  };

  return {
    /**
     * Initializes a run trace and records run metadata and task context.
     */
    startRun(params: {
      artifactContext: ArtifactRunContext | null;
      task: Task;
      worker: string[];
      metrics: TaskContextMetrics;
      isVerifyOnly: boolean;
      contextBefore: string;
    }): void {
      if (!params.artifactContext) {
        return;
      }

      sessionState.start(params.artifactContext.runId, params.task, Date.now());

      config.getTraceWriter().write(createRunStartedEvent({
        timestamp: nowIso(),
        run_id: params.artifactContext.runId,
        payload: {
          command: "run",
          source: config.source,
          worker: params.worker,
          mode: config.mode,
          transport: config.transport,
          task_text: params.task.text,
          task_file: params.task.file,
          task_line: params.task.line,
        },
      }));

      config.getTraceWriter().write(createTaskContextEvent({
        timestamp: nowIso(),
        run_id: params.artifactContext.runId,
        payload: {
          source_files_scanned: params.metrics.sourceFilesScanned,
          total_unchecked_tasks: params.metrics.totalUncheckedTasks,
          task_position_in_file: params.metrics.taskPositionInFile,
          document_context_lines: countTraceLines(params.contextBefore),
          has_subtasks: params.metrics.hasSubtasks,
          is_inline_cli: params.task.isInlineCli,
          is_verify_only: params.isVerifyOnly,
        },
      }));
    },

    beginPhase,

    /**
     * Emits a force-retry boundary event that links retry attempts by run id.
     */
    emitForceRetry(params: {
      attemptNumber: number;
      maxAttempts: number;
      previousRunId: string;
      previousExitCode: number;
    }): void {
      const runId = sessionState.getRunId();
      if (!runId) {
        return;
      }

      config.getTraceWriter().write(createForceRetryEvent({
        timestamp: nowIso(),
        run_id: runId,
        payload: {
          attempt_number: params.attemptNumber,
          max_attempts: params.maxAttempts,
          previous_run_id: params.previousRunId,
          previous_exit_code: params.previousExitCode,
        },
      }));
    },

    /**
     * Emits a round-started boundary event for multi-round clean execution.
     */
    emitRoundStarted(currentRound: number, totalRounds: number): void {
      const runId = sessionState.getRunId();
      if (!runId) {
        return;
      }

      config.getTraceWriter().write(createRoundStartedEvent({
        timestamp: nowIso(),
        run_id: runId,
        payload: {
          current_round: currentRound,
          total_rounds: totalRounds,
        },
      }));
    },

    /**
     * Emits a round-completed boundary event for multi-round clean execution.
     */
    emitRoundCompleted(currentRound: number, totalRounds: number): void {
      const runId = sessionState.getRunId();
      if (!runId) {
        return;
      }

      config.getTraceWriter().write(createRoundCompletedEvent({
        timestamp: nowIso(),
        run_id: runId,
        payload: {
          current_round: currentRound,
          total_rounds: totalRounds,
        },
      }));
    },

    /**
     * Emits prompt size and context-ratio metrics for the active run.
     */
    emitPromptMetrics(promptText: string, contextText: string, templateName: string): void {
      const runId = sessionState.getRunId();
      if (!runId) {
        return;
      }

      const charCount = promptText.length;
      const estimatedTokens = charCount / 4;
      const contextRatio = charCount === 0 ? 0 : contextText.length / charCount;

      sessionState.accumulatePromptMetrics(charCount, estimatedTokens);

      config.getTraceWriter().write(createPromptMetricsEvent({
        timestamp: nowIso(),
        run_id: runId,
        payload: {
          char_count: charCount,
          estimated_tokens: estimatedTokens,
          context_ratio: contextRatio,
          template_name: templateName,
        },
      }));
    },

    /**
     * Stores aggregate verification-loop attempt counters.
     */
    setVerificationEfficiency(verifyAttempts: number, repairAttempts: number): void {
      sessionState.setVerificationEfficiency(verifyAttempts, repairAttempts);
    },

    /**
     * Returns a structured snapshot for inline trace statistics rendering.
     */
    collectStatistics(): TraceStatisticsSnapshot | null {
      return sessionState.collectStatistics(Date.now());
    },

    /**
     * Completes a traced phase, records output metrics, and parses worker signals.
     */
    completePhase(
      phaseTrace: PhaseTraceHandle | null,
      exitCode: number | null,
      stdout: string,
      stderr: string,
      outputCaptured: boolean,
    ): void {
      if (!phaseTrace) {
        return;
      }

      const completedAtMs = Date.now();
      const completedAtIso = nowIso();
      const stdoutBytes = Buffer.byteLength(stdout, "utf8");
      const stderrBytes = Buffer.byteLength(stderr, "utf8");
      const completedPhase = sessionState.completePhase(
        phaseTrace,
        completedAtMs,
        completedAtIso,
        stdoutBytes,
        stderrBytes,
      );
      if (!completedPhase) {
        return;
      }

      config.getTraceWriter().write(createPhaseCompletedEvent({
        timestamp: completedAtIso,
        run_id: completedPhase.runId,
        payload: {
          phase: phaseTrace.phase,
          sequence: phaseTrace.sequence,
          exit_code: exitCode,
          duration_ms: completedPhase.durationMs,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          output_captured: outputCaptured,
        },
      }));

      config.getTraceWriter().write(createOutputVolumeEvent({
        timestamp: completedAtIso,
        run_id: completedPhase.runId,
        payload: {
          phase: phaseTrace.phase,
          sequence: phaseTrace.sequence,
          stdout_bytes: stdoutBytes,
          stderr_bytes: stderrBytes,
          stdout_lines: countTraceLines(stdout),
          stderr_lines: countTraceLines(stderr),
        },
      }));

      if (!config.traceEnabled || stdout.length === 0) {
        return;
      }

      // Parse structured worker annotations from stdout for richer trace telemetry.
      const analysis = parseTraceWorkerOutputForEvents(stdout);

      if (analysis.agentSignals) {
        const runId = sessionState.getRunId();
        if (!runId) {
          return;
        }

        config.getTraceWriter().write(createAgentSignalsEvent({
          timestamp: nowIso(),
          run_id: runId,
          payload: {
            confidence: analysis.agentSignals.confidence,
            files_read: analysis.agentSignals.filesRead,
            files_written: analysis.agentSignals.filesWritten,
            tools_used: analysis.agentSignals.toolsUsed,
            approach: analysis.agentSignals.approach,
            blockers: analysis.agentSignals.blockers,
          },
        }));

        if (analysis.agentSignals.includesToolsUsedField) {
          config.getTraceWriter().write(createAgentToolUsageEvent({
            timestamp: nowIso(),
            run_id: runId,
            payload: {
              tools: analysis.toolCalls,
            },
          }));
        }
      }

      if (analysis.thinking) {
        const runId = sessionState.getRunId();
        if (!runId) {
          return;
        }

        config.getTraceWriter().write(createAgentThinkingEvent({
          timestamp: nowIso(),
          run_id: runId,
          payload: {
            thinking_blocks_count: analysis.thinking.thinkingBlocksCount,
            total_thinking_chars: analysis.thinking.totalThinkingChars,
          },
        }));
      }
    },

    /**
     * Emits a synthetic reset phase used for pre/post run checkbox cleanup traces.
     */
    emitResetPhase(phase: "pre-run-reset" | "post-run-reset", file: string, resetCount: number, isDryRun: boolean): void {
      const phaseTrace = beginPhase(phase, ["rundown", phase, file]);
      if (!phaseTrace) {
        return;
      }

      const pluralSuffix = resetCount === 1 ? "" : "es";
      const stdout = isDryRun
        ? `Dry run — would reset ${resetCount} checkbox${pluralSuffix} in ${file}.`
        : `Reset ${resetCount} checkbox${pluralSuffix} in ${file}.`;
      this.completePhase(phaseTrace, 0, stdout, "", true);
    },

    /**
     * Emits task-level terminal status (completed or failed) exactly once.
     */
    emitTaskOutcome(status: ArtifactStoreStatus, failure?: { reason: string; exitCode: number | null }): void {
      const context = sessionState.getTaskOutcomeContext();
      if (!context) {
        return;
      }

      const traceStatus = toTraceStatus(status);
      const totalDurationMs = Math.max(0, Date.now() - context.startedAtMs);

      if (status === "completed") {
        config.getTraceWriter().write(createTaskCompletedEvent({
          timestamp: nowIso(),
          run_id: context.runId,
          payload: {
            task_text: context.task.text,
            task_file: context.task.file,
            task_line: context.task.line,
            total_duration_ms: totalDurationMs,
            phases_count: context.totalPhases,
          },
        }));
      } else {
        config.getTraceWriter().write(createTaskFailedEvent({
          timestamp: nowIso(),
          run_id: context.runId,
          payload: {
            task_text: context.task.text,
            reason: failure?.reason ?? "Task did not complete successfully.",
            exit_code: failure?.exitCode ?? null,
            final_status: traceStatus,
          },
        }));
      }

      sessionState.markTaskOutcomeEmitted();
    },

    /**
     * Emits a consolidated phase timing waterfall for the active run.
     */
    emitTimingWaterfall(): void {
      const context = sessionState.getTimingWaterfallContext();
      if (!context) {
        return;
      }

      const waterfallAtIso = nowIso();
      const totalDurationMs = Math.max(0, Date.now() - context.startedAtMs);
      const orderedPhaseTimings = context.phaseTimings
        .sort((a, b) => a.sequence - b.sequence);
      const totalWorkerTimeMs = orderedPhaseTimings.reduce((sum, phase) => sum + phase.durationMs, 0);
      let idleTimeMs = 0;
      for (let index = 1; index < orderedPhaseTimings.length; index++) {
        const previous = orderedPhaseTimings[index - 1];
        const current = orderedPhaseTimings[index];
        if (!previous || !current) {
          continue;
        }

        // Idle time captures scheduling or orchestration gaps between phases.
        idleTimeMs += Math.max(0, current.startedAtMs - previous.completedAtMs);
      }

      config.getTraceWriter().write(createTimingWaterfallEvent({
        timestamp: waterfallAtIso,
        run_id: context.runId,
        payload: {
          phases: orderedPhaseTimings.map((phase) => ({
            phase: phase.phase,
            sequence: phase.sequence,
            started_at: phase.startedAtIso,
            completed_at: phase.completedAtIso,
            duration_ms: phase.durationMs,
          })),
          idle_time_ms: idleTimeMs,
          total_wall_time_ms: totalDurationMs,
          total_worker_time_ms: totalWorkerTimeMs,
        },
      }));

      sessionState.markTimingWaterfallEmitted();
    },

    /**
     * Emits final run status and aggregate run timing once execution ends.
     */
    emitRunCompleted(status: ArtifactStoreStatus): void {
      const context = sessionState.getRunCompletedContext();
      if (!context) {
        return;
      }

      const runCompletedAtMs = Date.now();
      const runCompletedAtIso = nowIso();
      const traceStatus = toTraceStatus(status);
      const totalDurationMs = Math.max(0, runCompletedAtMs - context.startedAtMs);

      config.getTraceWriter().write(createRunCompletedEvent({
        timestamp: runCompletedAtIso,
        run_id: context.runId,
        payload: {
          status: traceStatus,
          total_duration_ms: totalDurationMs,
          total_phases: context.totalPhases,
        },
      }));

      sessionState.markRunCompleted();
    },

    /**
     * Queues analysis summary data for deferred emission.
     */
    queueAnalysisSummary(payload: AnalysisSummaryPayload): void {
      sessionState.queueAnalysisSummary(payload);
    },

    /**
     * Emits deferred events that should occur after phase processing completes.
     */
    emitDeferredEvents(): void {
      if (!sessionState.hasActiveRun()) {
        return;
      }

      this.emitTimingWaterfall();

      const pendingSummary = sessionState.takePendingAnalysisSummary();
      if (pendingSummary) {
        config.getTraceWriter().write(createAnalysisSummaryEvent({
          timestamp: nowIso(),
          run_id: pendingSummary.runId,
          payload: pendingSummary.payload,
        }));
      }
    },

    /**
     * Returns the active run id when available.
     */
    getRunId(): string | null {
      return sessionState.getRunId();
    },

    /**
     * Returns the active run start timestamp in epoch milliseconds.
     */
    getStartedAtMs(): number | null {
      return sessionState.getStartedAtMs();
    },

    /**
     * Indicates whether a run is currently active.
     */
    hasActiveRun(): boolean {
      return sessionState.hasActiveRun();
    },

    /**
     * Resets all trace-session state.
     */
    reset(): void {
      sessionState.reset();
    },
  };
}
