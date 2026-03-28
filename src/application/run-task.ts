import {
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  getTraceInstructions,
  DEFAULT_VERIFY_TEMPLATE,
} from "../domain/defaults.js";
import { markChecked } from "../domain/checkbox.js";
import { parseTasks, type Task } from "../domain/parser.js";
import type { SortMode } from "../domain/sorting.js";
import { requiresWorkerCommand, resolveRunBehavior } from "../domain/run-options.js";
import { classifyTaskIntent } from "../domain/task-intent.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import {
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import {
  createAnalysisSummaryEvent,
  createAgentSignalsEvent,
  createAgentThinkingEvent,
  createAgentToolUsageEvent,
  createOutputVolumeEvent,
  createPhaseCompletedEvent,
  createPromptMetricsEvent,
  createPhaseStartedEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  createTaskContextEvent,
  createTimingWaterfallEvent,
  createTaskCompletedEvent,
  createTaskFailedEvent,
  type TracePhase,
  type TraceRunStatus,
  type AnalysisSummaryPayload,
} from "../domain/trace.js";
import { parseWorkerOutput } from "../domain/worker-output-parser.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import type {
  ArtifactRunContext,
  ArtifactRunMetadata,
  ArtifactStoreStatus,
  ArtifactStore,
  FileSystem,
  GitClient,
  PathOperationsPort,
  ProcessRunMode,
  ProcessRunner,
  PromptTransport as PortPromptTransport,
  SourceResolverPort,
  TaskRepairPort,
  TaskSelectionResult as PortTaskSelectionResult,
  TaskSelectorPort,
  TaskVerificationPort,
  TemplateLoader,
  TemplateVarsLoaderPort,
  TraceWriterPort,
  VerificationSidecar,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

export type RunnerMode = ProcessRunMode;
export type PromptTransport = PortPromptTransport;
type ArtifactContext = ArtifactRunContext;

interface ProjectTemplates {
  task: string;
  verify: string;
  repair: string;
  plan: string;
  trace: string;
}

interface TraceEnrichmentContext {
  task: Task;
  source: string;
  contextBefore: string;
  worker: string[];
  templates: ProjectTemplates;
}

interface TaskContextMetrics {
  sourceFilesScanned: number;
  totalUncheckedTasks: number;
  taskPositionInFile: number;
  hasSubtasks: boolean;
}

interface ResolvedTaskContext {
  task: Task;
  source: string;
  contextBefore: string;
}

export type TaskSelectionResult = PortTaskSelectionResult;

export interface RuntimeTaskMetadata {
  text: string;
  file: string;
  line: number;
  index: number;
  source: string;
}

export interface RunTaskDependencies {
  sourceResolver: SourceResolverPort;
  taskSelector: TaskSelectorPort;
  workerExecutor: WorkerExecutorPort;
  taskVerification: TaskVerificationPort;
  taskRepair: TaskRepairPort;
  workingDirectory: WorkingDirectoryPort;
  fileSystem: FileSystem;
  templateLoader: TemplateLoader;
  verificationSidecar: VerificationSidecar;
  artifactStore: ArtifactStore;
  gitClient: GitClient;
  processRunner: ProcessRunner;
  pathOperations: PathOperationsPort;
  templateVarsLoader: TemplateVarsLoaderPort;
  traceWriter: TraceWriterPort;
  createTraceWriter: (trace: boolean, artifactContext: ArtifactContext) => TraceWriterPort;
  output: ApplicationOutputPort;
}

export interface RunTaskOptions {
  source: string;
  mode: RunnerMode;
  transport: PromptTransport;
  sortMode: SortMode;
  verify: boolean;
  onlyVerify: boolean;
  forceExecute: boolean;
  noRepair: boolean;
  repairAttempts: number;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
  commitAfterComplete: boolean;
  commitMessageTemplate?: string;
  onCompleteCommand?: string;
  runAll: boolean;
  onFailCommand?: string;
  hideAgentOutput: boolean;
  trace: boolean;
  traceOnly: boolean;
}

export function createRunTask(
  dependencies: RunTaskDependencies,
): (options: RunTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function runTask(options: RunTaskOptions): Promise<number> {
      const {
      source,
      mode,
      transport,
      sortMode,
      verify,
      onlyVerify,
      forceExecute,
      noRepair,
      repairAttempts,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
      commitAfterComplete,
      commitMessageTemplate,
      onCompleteCommand,
      runAll,
      onFailCommand,
      hideAgentOutput,
      trace,
        traceOnly,
      } = options;

      // Suppress only worker-produced execution transcript in terminal output.
      // Artifact/trace capture still records stdout/stderr via phase completion events.
      const emitExecutionWorkerOutput = (stdout: string, stderr: string): void => {
        if (hideAgentOutput) {
          return;
        }

        if (stdout) {
          emit({ kind: "text", text: stdout });
        }

        if (stderr) {
          emit({ kind: "stderr", text: stderr });
        }
      };
      // Hook output is intentionally out of scope for --hide-agent-output.
      // Keep --on-complete/--on-fail stdout/stderr visible as explicit user hooks.
      const hideHookOutput = false;

    if (traceOnly) {
      return runTraceOnlyEnrichment({
        transport,
        workerCommand,
      });
    }

    const runBehavior = resolveRunBehavior({
      verify: verify,
      onlyVerify: onlyVerify,
      noRepair: noRepair,
      repairAttempts,
    });
    const configuredShouldVerify = runBehavior.shouldVerify;
    const configuredOnlyVerify = runBehavior.onlyVerify;
    const allowRepair = runBehavior.allowRepair;
    const maxRepairAttempts = runBehavior.maxRepairAttempts;

    const varsFilePath = resolveTemplateVarsFilePath(varsFileOption);
    const fileTemplateVars = varsFilePath
      ? dependencies.templateVarsLoader.load(varsFilePath, dependencies.workingDirectory.cwd())
      : {};
    const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs);
    const extraTemplateVars: ExtraTemplateVars = {
      ...fileTemplateVars,
      ...cliTemplateVars,
    };

    let artifactContext: ArtifactContext | null = null;
    let traceWriter: TraceWriterPort = dependencies.traceWriter;
    let artifactsFinalized = false;
    let traceEnrichmentContext: TraceEnrichmentContext | null = null;
    let activeTraceRun: {
      runId: string;
      task: Task;
      startedAtMs: number;
      totalPhases: number;
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
    } | null = null;

    const nowIso = (): string => new Date().toISOString();

    const toTraceStatus = (status: ArtifactStoreStatus): TraceRunStatus => status;

    const startTraceRun = (
      task: Task,
      worker: string[],
      metrics: TaskContextMetrics,
      isVerifyOnly: boolean,
      contextBefore: string,
    ): void => {
      if (!artifactContext) {
        return;
      }

      activeTraceRun = {
        runId: artifactContext.runId,
        task,
        startedAtMs: Date.now(),
        totalPhases: 0,
        phaseTimings: [],
        taskOutcomeEmitted: false,
        timingWaterfallEmitted: false,
        pendingAnalysisSummary: null,
        completed: false,
      };

      traceWriter.write(createRunStartedEvent({
        timestamp: nowIso(),
        run_id: artifactContext.runId,
        payload: {
          command: "run",
          source,
          worker,
          mode,
          transport,
          task_text: task.text,
          task_file: task.file,
          task_line: task.line,
        },
      }));

      traceWriter.write(createTaskContextEvent({
        timestamp: nowIso(),
        run_id: artifactContext.runId,
        payload: {
          source_files_scanned: metrics.sourceFilesScanned,
          total_unchecked_tasks: metrics.totalUncheckedTasks,
          task_position_in_file: metrics.taskPositionInFile,
          document_context_lines: countTraceLines(contextBefore),
          has_subtasks: metrics.hasSubtasks,
          is_inline_cli: task.isInlineCli,
          is_verify_only: isVerifyOnly,
        },
      }));
    };

    const beginPhaseTrace = (
      phase: TracePhase,
      command: string[],
    ): { phase: TracePhase; sequence: number; startedAtMs: number; startedAtIso: string } | null => {
      if (!activeTraceRun) {
        return null;
      }

      const sequence = activeTraceRun.totalPhases + 1;
      const startedAtMs = Date.now();
      const startedAtIso = nowIso();
      activeTraceRun.totalPhases = sequence;
      traceWriter.write(createPhaseStartedEvent({
        timestamp: startedAtIso,
        run_id: activeTraceRun.runId,
        payload: {
          phase,
          sequence,
          command,
        },
      }));

      return { phase, sequence, startedAtMs, startedAtIso };
    };

    const emitPromptMetrics = (
      promptText: string,
      contextText: string,
      templateName: string,
    ): void => {
      if (!activeTraceRun) {
        return;
      }

      const charCount = promptText.length;
      const contextRatio = charCount === 0 ? 0 : contextText.length / charCount;
      traceWriter.write(createPromptMetricsEvent({
        timestamp: nowIso(),
        run_id: activeTraceRun.runId,
        payload: {
          char_count: charCount,
          estimated_tokens: charCount / 4,
          context_ratio: contextRatio,
          template_name: templateName,
        },
      }));
    };

    const completePhaseTrace = (
      phaseTrace: { phase: TracePhase; sequence: number; startedAtMs: number; startedAtIso: string } | null,
      exitCode: number | null,
      stdout: string,
      stderr: string,
      outputCaptured: boolean,
    ): void => {
      if (!activeTraceRun || !phaseTrace) {
        return;
      }

      const completedAtMs = Date.now();
      const completedAtIso = nowIso();
      const durationMs = Math.max(0, completedAtMs - phaseTrace.startedAtMs);

      activeTraceRun.phaseTimings.push({
        phase: phaseTrace.phase,
        sequence: phaseTrace.sequence,
        startedAtMs: phaseTrace.startedAtMs,
        startedAtIso: phaseTrace.startedAtIso,
        completedAtMs,
        completedAtIso,
        durationMs,
      });

      traceWriter.write(createPhaseCompletedEvent({
        timestamp: completedAtIso,
        run_id: activeTraceRun.runId,
        payload: {
          phase: phaseTrace.phase,
          sequence: phaseTrace.sequence,
          exit_code: exitCode,
          duration_ms: durationMs,
          stdout_bytes: Buffer.byteLength(stdout, "utf8"),
          stderr_bytes: Buffer.byteLength(stderr, "utf8"),
          output_captured: outputCaptured,
        },
      }));

      traceWriter.write(createOutputVolumeEvent({
        timestamp: completedAtIso,
        run_id: activeTraceRun.runId,
        payload: {
          phase: phaseTrace.phase,
          sequence: phaseTrace.sequence,
          stdout_bytes: Buffer.byteLength(stdout, "utf8"),
          stderr_bytes: Buffer.byteLength(stderr, "utf8"),
          stdout_lines: countTraceLines(stdout),
          stderr_lines: countTraceLines(stderr),
        },
      }));

      if (!trace || stdout.length === 0) {
        return;
      }

      const analysis = parseWorkerOutput(stdout);

      if (analysis.agent_signals) {
        const confidenceRaw = analysis.agent_signals.confidence?.trim();
        const confidence = confidenceRaw && /^\d+$/.test(confidenceRaw)
          ? Number.parseInt(confidenceRaw, 10)
          : null;
        const splitCsv = (value: string | undefined): string[] => value
          ? value
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
          : [];
        const approachRaw = analysis.agent_signals.approach?.trim();
        const blockersRaw = analysis.agent_signals.blockers?.trim();

        traceWriter.write(createAgentSignalsEvent({
          timestamp: nowIso(),
          run_id: activeTraceRun.runId,
          payload: {
            confidence,
            files_read: splitCsv(analysis.agent_signals.files_read),
            files_written: splitCsv(analysis.agent_signals.files_written),
            tools_used: splitCsv(analysis.agent_signals.tools_used),
            approach: approachRaw && approachRaw.length > 0 ? approachRaw : null,
            blockers: blockersRaw && blockersRaw.length > 0 ? blockersRaw : null,
          },
        }));

        if (Object.prototype.hasOwnProperty.call(analysis.agent_signals, "tools_used")) {
          traceWriter.write(createAgentToolUsageEvent({
            timestamp: nowIso(),
            run_id: activeTraceRun.runId,
            payload: {
              tools: analysis.tool_calls,
            },
          }));
        }
      }

      if (analysis.thinking_blocks.length > 0) {
        const totalThinkingChars = analysis.thinking_blocks.reduce(
          (sum, block) => sum + block.content.length,
          0,
        );

        traceWriter.write(createAgentThinkingEvent({
          timestamp: nowIso(),
          run_id: activeTraceRun.runId,
          payload: {
            thinking_blocks_count: analysis.thinking_blocks.length,
            total_thinking_chars: totalThinkingChars,
          },
        }));
      }
    };

    const emitTraceTaskOutcome = (
      status: ArtifactStoreStatus,
      failure?: { reason: string; exitCode: number | null },
    ): void => {
      if (!activeTraceRun || activeTraceRun.taskOutcomeEmitted) {
        return;
      }

      const traceStatus = toTraceStatus(status);
      const totalDurationMs = Math.max(0, Date.now() - activeTraceRun.startedAtMs);

      if (status === "completed") {
        traceWriter.write(createTaskCompletedEvent({
          timestamp: nowIso(),
          run_id: activeTraceRun.runId,
          payload: {
            task_text: activeTraceRun.task.text,
            task_file: activeTraceRun.task.file,
            task_line: activeTraceRun.task.line,
            total_duration_ms: totalDurationMs,
            phases_count: activeTraceRun.totalPhases,
          },
        }));
      } else {
        traceWriter.write(createTaskFailedEvent({
          timestamp: nowIso(),
          run_id: activeTraceRun.runId,
          payload: {
            task_text: activeTraceRun.task.text,
            reason: failure?.reason ?? "Task did not complete successfully.",
            exit_code: failure?.exitCode ?? null,
            final_status: traceStatus,
          },
        }));
      }

      activeTraceRun.taskOutcomeEmitted = true;
    };

    const emitTraceTimingWaterfall = (): void => {
      if (!activeTraceRun || activeTraceRun.timingWaterfallEmitted) {
        return;
      }

      const waterfallAtIso = nowIso();
      const totalDurationMs = Math.max(0, Date.now() - activeTraceRun.startedAtMs);
      const orderedPhaseTimings = [...activeTraceRun.phaseTimings]
        .sort((a, b) => a.sequence - b.sequence);
      const totalWorkerTimeMs = orderedPhaseTimings.reduce((sum, phase) => sum + phase.durationMs, 0);
      let idleTimeMs = 0;
      for (let index = 1; index < orderedPhaseTimings.length; index++) {
        const previous = orderedPhaseTimings[index - 1];
        const current = orderedPhaseTimings[index];
        if (!previous || !current) {
          continue;
        }

        idleTimeMs += Math.max(0, current.startedAtMs - previous.completedAtMs);
      }

      traceWriter.write(createTimingWaterfallEvent({
        timestamp: waterfallAtIso,
        run_id: activeTraceRun.runId,
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

      activeTraceRun.timingWaterfallEmitted = true;
    };

    const emitTraceRunCompleted = (status: ArtifactStoreStatus): void => {
      if (!activeTraceRun || activeTraceRun.completed) {
        return;
      }

      const runCompletedAtMs = Date.now();
      const runCompletedAtIso = nowIso();
      const traceStatus = toTraceStatus(status);
      const totalDurationMs = Math.max(0, runCompletedAtMs - activeTraceRun.startedAtMs);

      traceWriter.write(createRunCompletedEvent({
        timestamp: runCompletedAtIso,
        run_id: activeTraceRun.runId,
        payload: {
          status: traceStatus,
          total_duration_ms: totalDurationMs,
          total_phases: activeTraceRun.totalPhases,
        },
      }));

      activeTraceRun.completed = true;
    };

    const runTraceEnrichment = async (status: ArtifactStoreStatus): Promise<void> => {
      if (!trace || status === "detached") {
        return;
      }

      if (!artifactContext || !activeTraceRun || !traceEnrichmentContext) {
        return;
      }

      const phaseArtifacts = collectTracePhaseArtifacts(
        artifactContext,
        dependencies.fileSystem,
        dependencies.pathOperations,
      );
      const analysis = summarizePhaseAnalyses(phaseArtifacts);
      const completedAtIso = new Date().toISOString();
      const totalDurationMs = Math.max(0, Date.now() - activeTraceRun.startedAtMs);
      const tracePrompt = renderTemplate(traceEnrichmentContext.templates.trace, {
        task: traceEnrichmentContext.task.text,
        file: traceEnrichmentContext.task.file,
        context: traceEnrichmentContext.contextBefore,
        taskIndex: traceEnrichmentContext.task.index,
        taskLine: traceEnrichmentContext.task.line,
        source: traceEnrichmentContext.source,
        runId: activeTraceRun.runId,
        command: "run",
        status,
        worker: traceEnrichmentContext.worker.join(" "),
        startedAt: new Date(activeTraceRun.startedAtMs).toISOString(),
        completedAt: completedAtIso,
        totalDurationMs,
        phaseTimings: formatPhaseTimingsForTrace(phaseArtifacts),
        phaseOutputs: formatPhaseOutputsForTrace(phaseArtifacts),
        agentSignals: formatAgentSignalsForTrace(analysis.signals),
        thinkingBlocks: formatThinkingBlocksForTrace(analysis.thinkingBlocks),
        toolUsage: formatToolUsageForTrace(analysis.tools),
      });
      emitPromptMetrics(tracePrompt, traceEnrichmentContext.contextBefore, "trace.md");

      const enrichmentPhase = beginPhaseTrace("plan", traceEnrichmentContext.worker);

      try {
        const enrichmentResult = await dependencies.workerExecutor.runWorker({
          command: traceEnrichmentContext.worker,
          prompt: tracePrompt,
          mode: "wait",
          transport,
          trace: false,
          cwd: dependencies.workingDirectory.cwd(),
          artifactContext,
          artifactPhase: "worker",
          artifactExtra: {
            taskType: "trace-enrichment",
          },
        });

        completePhaseTrace(
          enrichmentPhase,
          enrichmentResult.exitCode,
          enrichmentResult.stdout,
          enrichmentResult.stderr,
          true,
        );

        if (enrichmentResult.exitCode !== 0 || enrichmentResult.exitCode === null) {
          emit({ kind: "warn", message: "Trace enrichment worker did not complete successfully; skipping analysis.summary event." });
          return;
        }

        const analysisSummaryPayload = parseAnalysisSummaryFromWorkerOutput(enrichmentResult.stdout);
        if (!analysisSummaryPayload) {
          emit({ kind: "warn", message: "Trace enrichment output did not contain a valid analysis.summary block." });
          return;
        }

        activeTraceRun.pendingAnalysisSummary = analysisSummaryPayload;
      } catch (error) {
        completePhaseTrace(enrichmentPhase, null, "", error instanceof Error ? error.message : String(error), true);
        emit({ kind: "warn", message: "Trace enrichment failed: " + String(error) });
      }
    };

    const emitDeferredTraceEvents = (): void => {
      if (!activeTraceRun) {
        return;
      }

      emitTraceTimingWaterfall();

      if (activeTraceRun.pendingAnalysisSummary) {
        traceWriter.write(createAnalysisSummaryEvent({
          timestamp: nowIso(),
          run_id: activeTraceRun.runId,
          payload: activeTraceRun.pendingAnalysisSummary,
        }));
        activeTraceRun.pendingAnalysisSummary = null;
      }
    };

    const failRun = async (
      code: number,
      status: ArtifactStoreStatus,
      reason: string,
      exitCode: number | null,
      preserve: boolean = keepArtifacts,
    ): Promise<number> => finishRun(code, status, preserve, { reason, exitCode });

    const finalizeArtifacts = (
      status: ArtifactStoreStatus,
      preserve: boolean = keepArtifacts,
      extra?: Record<string, unknown>,
    ): void => {
      if (!artifactContext || artifactsFinalized) {
        return;
      }

      traceWriter.flush();
      finalizeRunArtifacts(dependencies.artifactStore, artifactContext, preserve, status, emit, extra);
      artifactsFinalized = true;
    };

    const finishRun = async (
      code: number,
      status: ArtifactStoreStatus,
      preserve: boolean = keepArtifacts,
      failure?: { reason: string; exitCode: number | null },
      extra?: Record<string, unknown>,
    ): Promise<number> => {
      emitTraceTaskOutcome(status, failure);
      await runTraceEnrichment(status);
      emitDeferredTraceEvents();
      emitTraceRunCompleted(status);
      finalizeArtifacts(status, preserve, extra);
      return code;
    };

    async function runTraceOnlyEnrichment(enrichmentOptions: {
      transport: PromptTransport;
      workerCommand: string[];
    }): Promise<number> {
      const cwd = dependencies.workingDirectory.cwd();
      const selectedRun = resolveLatestCompletedRun(dependencies.artifactStore, cwd);
      if (!selectedRun) {
        emit({ kind: "error", message: "No saved runtime artifact run found for: latest completed" });
        return 3;
      }

      if (!selectedRun.task) {
        emit({
          kind: "error",
          message: "Selected run has no task metadata to run trace-only enrichment.",
        });
        return 3;
      }

      const metadataError = validateRuntimeTaskMetadata(selectedRun.task);
      if (metadataError) {
        emit({ kind: "error", message: "Selected run has invalid task metadata: " + metadataError });
        return 3;
      }

      const taskContext = resolveTaskContextFromRuntimeMetadata(
        selectedRun.task,
        cwd,
        dependencies.fileSystem,
        dependencies.pathOperations,
      );
      if (!taskContext) {
        emit({
          kind: "error",
          message: "Could not resolve task from saved metadata. The task may have moved or been edited.",
        });
        return 3;
      }

      const templates = loadProjectTemplatesFromPorts(
        cwd,
        dependencies.templateLoader,
        dependencies.pathOperations,
      );

      const effectiveWorkerCommand = enrichmentOptions.workerCommand.length > 0
        ? enrichmentOptions.workerCommand
        : selectedRun.workerCommand ?? [];
      if (effectiveWorkerCommand.length === 0) {
        emit({ kind: "error", message: "No worker command specified. Use --worker <command...> or -- <command>." });
        return 1;
      }

      const artifactContextForRun: ArtifactContext = {
        runId: selectedRun.runId,
        rootDir: selectedRun.rootDir,
        cwd,
        keepArtifacts: selectedRun.keepArtifacts,
        commandName: selectedRun.commandName,
        workerCommand: selectedRun.workerCommand,
        mode: selectedRun.mode,
        transport: selectedRun.transport,
        task: selectedRun.task,
      };

      const phaseArtifacts = collectTracePhaseArtifacts(
        artifactContextForRun,
        dependencies.fileSystem,
        dependencies.pathOperations,
      );
      const phaseAnalysis = summarizePhaseAnalyses(phaseArtifacts);
      const runStartedAt = selectedRun.startedAt;
      const runCompletedAt = selectedRun.completedAt ?? new Date().toISOString();
      const totalDurationMs = computeDurationMs(runStartedAt, runCompletedAt);
      const runStatus = selectedRun.status ?? "completed";

      const tracePrompt = renderTemplate(templates.trace, {
        task: taskContext.task.text,
        file: taskContext.task.file,
        context: taskContext.contextBefore,
        taskIndex: taskContext.task.index,
        taskLine: taskContext.task.line,
        source: taskContext.source,
        runId: selectedRun.runId,
        command: selectedRun.commandName,
        status: runStatus,
        worker: effectiveWorkerCommand.join(" "),
        startedAt: runStartedAt,
        completedAt: runCompletedAt,
        totalDurationMs,
        phaseTimings: formatPhaseTimingsForTrace(phaseArtifacts),
        phaseOutputs: formatPhaseOutputsForTrace(phaseArtifacts),
        agentSignals: formatAgentSignalsForTrace(phaseAnalysis.signals),
        thinkingBlocks: formatThinkingBlocksForTrace(phaseAnalysis.thinkingBlocks),
        toolUsage: formatToolUsageForTrace(phaseAnalysis.tools),
      });

      const traceWriter = dependencies.createTraceWriter(true, artifactContextForRun);
      const nowIso = (): string => new Date().toISOString();
      const sequence = phaseArtifacts.length + 1;
      const phaseStartedAtMs = Date.now();

      emit({ kind: "info", message: "Trace-only enrichment for run: " + selectedRun.runId });

      traceWriter.write(createPhaseStartedEvent({
        timestamp: nowIso(),
        run_id: selectedRun.runId,
        payload: {
          phase: "plan",
          sequence,
          command: effectiveWorkerCommand,
        },
      }));

      try {
        const enrichmentResult = await dependencies.workerExecutor.runWorker({
          command: effectiveWorkerCommand,
          prompt: tracePrompt,
          mode: "wait",
          transport: enrichmentOptions.transport,
          trace: false,
          cwd,
        });

        traceWriter.write(createPhaseCompletedEvent({
          timestamp: nowIso(),
          run_id: selectedRun.runId,
          payload: {
            phase: "plan",
            sequence,
            exit_code: enrichmentResult.exitCode,
            duration_ms: Math.max(0, Date.now() - phaseStartedAtMs),
            stdout_bytes: Buffer.byteLength(enrichmentResult.stdout, "utf8"),
            stderr_bytes: Buffer.byteLength(enrichmentResult.stderr, "utf8"),
            output_captured: true,
          },
        }));
        traceWriter.write(createOutputVolumeEvent({
          timestamp: nowIso(),
          run_id: selectedRun.runId,
          payload: {
            phase: "plan",
            sequence,
            stdout_bytes: Buffer.byteLength(enrichmentResult.stdout, "utf8"),
            stderr_bytes: Buffer.byteLength(enrichmentResult.stderr, "utf8"),
            stdout_lines: countTraceLines(enrichmentResult.stdout),
            stderr_lines: countTraceLines(enrichmentResult.stderr),
          },
        }));

        if (enrichmentResult.exitCode !== 0 || enrichmentResult.exitCode === null) {
          emit({ kind: "error", message: "Trace enrichment worker did not complete successfully." });
          return 1;
        }

        const analysisSummaryPayload = parseAnalysisSummaryFromWorkerOutput(enrichmentResult.stdout);
        if (!analysisSummaryPayload) {
          emit({ kind: "error", message: "Trace enrichment output did not contain a valid analysis.summary block." });
          return 2;
        }

        traceWriter.write(createAnalysisSummaryEvent({
          timestamp: nowIso(),
          run_id: selectedRun.runId,
          payload: analysisSummaryPayload,
        }));
        traceWriter.flush();
        emit({ kind: "success", message: "Trace enrichment completed for run: " + selectedRun.runId });
        return 0;
      } catch (error) {
        traceWriter.write(createPhaseCompletedEvent({
          timestamp: nowIso(),
          run_id: selectedRun.runId,
          payload: {
            phase: "plan",
            sequence,
            exit_code: null,
            duration_ms: Math.max(0, Date.now() - phaseStartedAtMs),
            stdout_bytes: 0,
            stderr_bytes: Buffer.byteLength(error instanceof Error ? error.message : String(error), "utf8"),
            output_captured: true,
          },
        }));
        traceWriter.write(createOutputVolumeEvent({
          timestamp: nowIso(),
          run_id: selectedRun.runId,
          payload: {
            phase: "plan",
            sequence,
            stdout_bytes: 0,
            stderr_bytes: Buffer.byteLength(error instanceof Error ? error.message : String(error), "utf8"),
            stdout_lines: 0,
            stderr_lines: countTraceLines(error instanceof Error ? error.message : String(error)),
          },
        }));
        traceWriter.flush();
        throw error;
      }
    }

    const resetArtifacts = (): void => {
      artifactContext = null;
      traceWriter = dependencies.traceWriter;
      artifactsFinalized = false;
      traceEnrichmentContext = null;
      activeTraceRun = null;
    };

    let unexpectedError: unknown;
    try {
      const files = await dependencies.sourceResolver.resolveSources(source);
      if (files.length === 0) {
        emit({ kind: "warn", message: "No Markdown files found matching: " + source });
        return 3;
      }

      if (commitAfterComplete) {
        const cwd = dependencies.workingDirectory.cwd();
        const inGitRepo = await isGitRepoWithGitClient(dependencies.gitClient, cwd);
        if (!inGitRepo) {
          emit({ kind: "warn", message: "--commit: not inside a git repository, skipping." });
        } else {
          const isClean = await isWorkingDirectoryClean(dependencies.gitClient, cwd);
          if (!isClean) {
            emit({
              kind: "error",
              message: "--commit: working directory is not clean. Commit or stash changes before using --commit.",
            });
            return 1;
          }
        }
      }

      let tasksCompleted = 0;

      // eslint-disable-next-line no-constant-condition
      while (true) {
      const result = dependencies.taskSelector.selectNextTask(files, sortMode);
      if (!result) {
        if (tasksCompleted > 0) {
          emit({ kind: "success", message: "All tasks completed (" + tasksCompleted + " total)." });
          return 0;
        }
        emit({ kind: "info", message: "No unchecked tasks found." });
        return 3;
      }

      const { task, source: fileSource, contextBefore } = result;
      emit({ kind: "info", message: "Next task: " + formatTaskLabel(task) });
      const automationCommand = getAutomationWorkerCommand(workerCommand, mode);

      const taskIntent = classifyTaskIntent(task.text);
      const shouldUseVerifyOnly = configuredOnlyVerify
        || (taskIntent.intent === "verify-only" && !forceExecute);
      const shouldVerify = configuredShouldVerify || shouldUseVerifyOnly;
      const onlyVerify = shouldUseVerifyOnly;

      if (!configuredOnlyVerify && taskIntent.intent === "verify-only") {
        if (forceExecute) {
          emit({ kind: "info", message: "Task classified as verify-only (" + taskIntent.reason + "), but --force-execute is enabled; running execution." });
        } else {
          emit({ kind: "info", message: "Task classified as verify-only (" + taskIntent.reason + "); skipping execution." });
        }
      }

      const templates = loadProjectTemplatesFromPorts(
        dependencies.workingDirectory.cwd(),
        dependencies.templateLoader,
        dependencies.pathOperations,
      );
      const templateVarsWithTrace: ExtraTemplateVars = {
        ...extraTemplateVars,
        traceInstructions: getTraceInstructions(trace),
      };
      const vars: TemplateVars = {
        ...templateVarsWithTrace,
        task: task.text,
        file: task.file,
        context: contextBefore,
        taskIndex: task.index,
        taskLine: task.line,
        source: fileSource,
      };

      const prompt = renderTemplate(templates.task, vars);
      const verificationPrompt = shouldVerify
        ? renderTemplate(templates.verify, vars)
        : "";

      if (printPrompt && onlyVerify) {
        emit({ kind: "text", text: verificationPrompt });
        return 0;
      }

      if (dryRun && onlyVerify) {
        emit({ kind: "info", message: "Dry run — would run verification with: " + automationCommand.join(" ") });
        emit({ kind: "info", message: "Prompt length: " + verificationPrompt.length + " chars" });
        return 0;
      }

      if (requiresWorkerCommand({
        workerCommand,
        isInlineCli: task.isInlineCli,
        shouldVerify,
        onlyVerify,
      })) {
        emit({ kind: "error", message: "No worker command specified. Use --worker <command...> or -- <command>." });
        return 1;
      }

      if (!onlyVerify && !task.isInlineCli) {
        if (printPrompt) {
          emit({ kind: "text", text: prompt });
          return 0;
        }

        if (dryRun) {
          emit({ kind: "info", message: "Dry run — would run: " + workerCommand.join(" ") });
          emit({ kind: "info", message: "Prompt length: " + prompt.length + " chars" });
          return 0;
        }
      }

      if (!onlyVerify && task.isInlineCli && printPrompt) {
        emit({ kind: "info", message: "Selected task is inline CLI; no worker prompt is rendered." });
        emit({ kind: "text", text: "cli: " + task.cliCommand! });
        return 0;
      }

      if (!onlyVerify && task.isInlineCli && dryRun) {
        emit({ kind: "info", message: "Dry run — would execute inline CLI: " + task.cliCommand! });
        return 0;
      }

      artifactContext = dependencies.artifactStore.createContext({
          cwd: dependencies.workingDirectory.cwd(),
          commandName: "run",
          workerCommand: onlyVerify ? automationCommand : workerCommand,
        mode,
        transport,
        source,
        task: toRuntimeTaskMetadata(task, fileSource),
        keepArtifacts,
      });
      traceWriter = dependencies.createTraceWriter(trace, artifactContext);
      const selectedWorkerCommand = onlyVerify ? automationCommand : workerCommand;
      traceEnrichmentContext = {
        task,
        source: fileSource,
        contextBefore,
        worker: selectedWorkerCommand,
        templates,
      };
      const taskContextMetrics = trace
        ? computeTaskContextMetrics(files, task, dependencies.fileSystem)
        : {
          sourceFilesScanned: files.length,
          totalUncheckedTasks: 0,
          taskPositionInFile: task.index + 1,
          hasSubtasks: false,
        };
      startTraceRun(task, selectedWorkerCommand, taskContextMetrics, onlyVerify, contextBefore);

      if (onlyVerify) {
        emit({ kind: "info", message: configuredOnlyVerify
          ? "Only verify mode — skipping task execution."
          : "Verify-only task mode — skipping task execution."
        });

        const verifyPhaseTrace = beginPhaseTrace("verify", automationCommand);
        emitPromptMetrics(verificationPrompt, contextBefore, "verify.md");
        const valid = await runVerification(
          dependencies,
          traceWriter,
          task,
          fileSource,
          contextBefore,
          templates,
          automationCommand,
          transport,
          maxRepairAttempts,
          allowRepair,
          templateVarsWithTrace,
          artifactContext,
          trace,
        );
        completePhaseTrace(verifyPhaseTrace, valid ? 0 : 1, "", "", false);
        if (!valid) {
          emit({ kind: "error", message: "Verification failed after all repair attempts. Task not checked." });
          await afterTaskFailed(dependencies, task, source, onFailCommand, hideHookOutput);
          return await failRun(2, "verification-failed", "Verification failed after all repair attempts.", 2);
        }

        checkTaskUsingFileSystem(task, dependencies.fileSystem);
        emit({ kind: "success", message: "Task checked: " + task.text });
        const taskCompletionExtra = await afterTaskComplete(
          dependencies,
          task,
          source,
          commitAfterComplete,
          commitMessageTemplate,
          onCompleteCommand,
          hideHookOutput,
        );
        await finishRun(0, "completed", keepArtifacts, undefined, taskCompletionExtra);
        tasksCompleted++;
        if (!runAll) return 0;
        resetArtifacts();
        continue;
      }

      if (task.isInlineCli) {
        const inlineCliCwd = dependencies.pathOperations.dirname(
          dependencies.pathOperations.resolve(task.file),
        );
        emit({ kind: "info", message: "Executing inline CLI: " + task.cliCommand! + " [cwd=" + inlineCliCwd + "]" });
        const inlineCliPhaseTrace = beginPhaseTrace("execute", [task.cliCommand!]);
        const cliResult = await dependencies.workerExecutor.executeInlineCli(task.cliCommand!, inlineCliCwd, {
          artifactContext,
          keepArtifacts,
          artifactExtra: { taskType: "inline-cli" },
        });
        completePhaseTrace(
          inlineCliPhaseTrace,
          cliResult.exitCode,
          cliResult.stdout,
          cliResult.stderr,
          true,
        );

        emitExecutionWorkerOutput(cliResult.stdout, cliResult.stderr);

        if (cliResult.exitCode !== 0) {
          emit({ kind: "error", message: "Inline CLI exited with code " + cliResult.exitCode });
          await afterTaskFailed(dependencies, task, source, onFailCommand, hideHookOutput);
          return await failRun(
            1,
            "execution-failed",
            "Inline CLI exited with a non-zero code.",
            cliResult.exitCode,
          );
        }

        if (shouldVerify) {
          const verifyPhaseTrace = beginPhaseTrace("verify", automationCommand);
          emitPromptMetrics(verificationPrompt, contextBefore, "verify.md");
          const valid = await runVerification(
            dependencies,
            traceWriter,
            task,
            fileSource,
            contextBefore,
            templates,
            automationCommand,
            transport,
            maxRepairAttempts,
            allowRepair,
            templateVarsWithTrace,
            artifactContext,
            trace,
          );
          completePhaseTrace(verifyPhaseTrace, valid ? 0 : 1, "", "", false);
          if (!valid) {
            emit({ kind: "error", message: "Verification failed. Task not checked." });
            await afterTaskFailed(dependencies, task, source, onFailCommand, hideHookOutput);
            return await failRun(2, "verification-failed", "Verification failed after inline CLI execution.", 2);
          }
        }

        checkTaskUsingFileSystem(task, dependencies.fileSystem);
        emit({ kind: "success", message: "Task checked: " + task.text });
        const taskCompletionExtra = await afterTaskComplete(
          dependencies,
          task,
          source,
          commitAfterComplete,
          commitMessageTemplate,
          onCompleteCommand,
          hideHookOutput,
        );
        await finishRun(0, "completed", keepArtifacts, undefined, taskCompletionExtra);
        tasksCompleted++;
        if (!runAll) return 0;
        resetArtifacts();
        continue;
      }

      emit({ kind: "info", message: "Running: " + workerCommand.join(" ") + " [mode=" + mode + ", transport=" + transport + "]" });
      const executePhaseTrace = beginPhaseTrace("execute", workerCommand);
      emitPromptMetrics(prompt, contextBefore, "execute.md");
      const runResult = await dependencies.workerExecutor.runWorker({
        command: workerCommand,
        prompt,
        mode,
        transport,
        trace,
        cwd: dependencies.workingDirectory.cwd(),
        artifactContext,
        artifactPhase: "execute",
      });
      completePhaseTrace(
        executePhaseTrace,
        runResult.exitCode,
        runResult.stdout,
        runResult.stderr,
        mode === "wait",
      );

      if (mode === "wait") {
        emitExecutionWorkerOutput(runResult.stdout, runResult.stderr);
      }

      if (mode !== "detached" && runResult.exitCode !== 0 && runResult.exitCode !== null) {
        emit({ kind: "error", message: "Worker exited with code " + runResult.exitCode + "." });
        await afterTaskFailed(dependencies, task, source, onFailCommand, hideHookOutput);
        return await failRun(1, "execution-failed", "Worker exited with a non-zero code.", runResult.exitCode);
      }

      if (mode === "detached") {
        emit({ kind: "info", message: "Detached mode — skipping immediate verification and leaving the task unchecked." });
        return await finishRun(0, "detached", true);
      }

      if (shouldVerify) {
        const verifyPhaseTrace = beginPhaseTrace("verify", automationCommand);
        emitPromptMetrics(verificationPrompt, contextBefore, "verify.md");
        const valid = await runVerification(
          dependencies,
          traceWriter,
          task,
          fileSource,
          contextBefore,
          templates,
          automationCommand,
          transport,
          maxRepairAttempts,
          allowRepair,
          templateVarsWithTrace,
          artifactContext,
          trace,
        );
        completePhaseTrace(verifyPhaseTrace, valid ? 0 : 1, "", "", false);
        if (!valid) {
          emit({ kind: "error", message: "Verification failed after all repair attempts. Task not checked." });
          await afterTaskFailed(dependencies, task, source, onFailCommand, hideHookOutput);
          return await failRun(2, "verification-failed", "Verification failed after all repair attempts.", 2);
        }
      }

      checkTaskUsingFileSystem(task, dependencies.fileSystem);
      emit({ kind: "success", message: "Task checked: " + task.text });
      const taskCompletionExtra = await afterTaskComplete(
        dependencies,
        task,
        source,
        commitAfterComplete,
        commitMessageTemplate,
        onCompleteCommand,
        hideHookOutput,
      );
      await finishRun(0, "completed", keepArtifacts, undefined, taskCompletionExtra);
      tasksCompleted++;
      if (!runAll) return 0;
      resetArtifacts();
      } // end while
    } catch (error) {
      unexpectedError = error;
      throw error;
    } finally {
      if (unexpectedError) {
        emitTraceTaskOutcome("failed", {
          reason: unexpectedError instanceof Error ? unexpectedError.message : String(unexpectedError),
          exitCode: null,
        });
        await runTraceEnrichment("failed");
        emitDeferredTraceEvents();
        emitTraceRunCompleted("failed");
        finalizeArtifacts("failed", keepArtifacts || mode === "detached");
      }

      traceWriter.flush();
    }
  };
}

async function runVerification(
  dependencies: RunTaskDependencies,
  traceWriter: TraceWriterPort,
  task: Task,
  fileSource: string,
  contextBefore: string,
  templates: { verify: string; repair: string },
  workerCommand: string[],
  transport: PromptTransport,
  maxRepairAttempts: number,
  allowRepair: boolean,
  extraTemplateVars: ExtraTemplateVars,
  artifactContext: ArtifactContext,
  trace: boolean,
): Promise<boolean> {
  return runVerifyRepairLoop({
    taskVerification: dependencies.taskVerification,
    taskRepair: dependencies.taskRepair,
    verificationSidecar: dependencies.verificationSidecar,
    traceWriter,
    output: dependencies.output,
  }, {
    task,
    source: fileSource,
    contextBefore,
    verifyTemplate: templates.verify,
    repairTemplate: templates.repair,
    workerCommand,
    transport,
    maxRepairAttempts,
    allowRepair,
    templateVars: extraTemplateVars,
    artifactContext,
    trace,
  });
}

async function afterTaskFailed(
  dependencies: RunTaskDependencies,
  task: Task,
  source: string,
  onFailCommand: string | undefined,
  hideHookOutput: boolean,
): Promise<void> {
  if (!onFailCommand) return;
  const cwd = dependencies.workingDirectory.cwd();
  const emit = dependencies.output.emit.bind(dependencies.output);

  try {
    const result = await runOnCompleteHookWithProcessRunner(
      dependencies.processRunner,
      onFailCommand,
      task,
      source,
      cwd,
      dependencies.pathOperations,
    );

    if (!hideHookOutput && result.stdout) emit({ kind: "text", text: result.stdout });
    if (!hideHookOutput && result.stderr) emit({ kind: "stderr", text: result.stderr });

    if (!result.success) {
      emit({ kind: "warn", message: "--on-fail hook exited with code " + result.exitCode });
    }
  } catch (error) {
    emit({ kind: "warn", message: "--on-fail hook failed: " + String(error) });
  }
}

async function afterTaskComplete(
  dependencies: RunTaskDependencies,
  task: Task,
  source: string,
  commit: boolean,
  commitMessageTemplate: string | undefined,
  onCompleteCommand: string | undefined,
  hideHookOutput: boolean,
): Promise<Record<string, unknown> | undefined> {
  const cwd = dependencies.workingDirectory.cwd();
  const emit = dependencies.output.emit.bind(dependencies.output);
  let artifactExtra: Record<string, unknown> | undefined;

  if (commit) {
    try {
      const inGitRepo = await isGitRepoWithGitClient(dependencies.gitClient, cwd);
      if (!inGitRepo) {
        emit({ kind: "warn", message: "--commit: not inside a git repository, skipping." });
      } else {
        const message = buildCommitMessage(task, cwd, commitMessageTemplate, dependencies.pathOperations);
        await commitCheckedTaskWithGitClient(dependencies.gitClient, task, cwd, message);
        const commitSha = (await dependencies.gitClient.run(["rev-parse", "HEAD"], cwd)).trim();
        artifactExtra = {
          commitSha,
          commitMessage: message,
        };
        emit({ kind: "success", message: "Committed: " + message });
      }
    } catch (error) {
      emit({ kind: "warn", message: "--commit failed: " + String(error) });
    }
  }

  if (onCompleteCommand) {
    try {
      const result = await runOnCompleteHookWithProcessRunner(
        dependencies.processRunner,
        onCompleteCommand,
        task,
        source,
        cwd,
        dependencies.pathOperations,
      );

      if (!hideHookOutput && result.stdout) emit({ kind: "text", text: result.stdout });
      if (!hideHookOutput && result.stderr) emit({ kind: "stderr", text: result.stderr });

      if (!result.success) {
        emit({ kind: "warn", message: "--on-complete hook exited with code " + result.exitCode });
      }
    } catch (error) {
      emit({ kind: "warn", message: "--on-complete hook failed: " + String(error) });
    }
  }

  return artifactExtra;
}

export function getAutomationWorkerCommand(
  workerCommand: string[],
  mode: RunnerMode,
): string[] {
  if (mode !== "tui") {
    return workerCommand;
  }

  if (!isOpenCodeWorkerCommand(workerCommand)) {
    return workerCommand;
  }

  return workerCommand.length > 1
    ? workerCommand
    : [workerCommand[0], "run"];
}

export function finalizeRunArtifacts(
  artifactStore: ArtifactStore,
  artifactContext: ArtifactContext,
  preserve: boolean,
  status: ArtifactStoreStatus,
  emit: ApplicationOutputPort["emit"],
  extra?: Record<string, unknown>,
): void {
  artifactStore.finalize(artifactContext, {
    status,
    preserve,
    ...(extra ? { extra } : {}),
  });

  if (preserve) {
    emit({ kind: "info", message: "Runtime artifacts saved at " + artifactStore.displayPath(artifactContext) + "." });
  }
}

const DEFAULT_COMMIT_MESSAGE_TEMPLATE = "rundown: complete \"{{task}}\" in {{file}}";

function loadProjectTemplatesFromPorts(
  cwd: string,
  templateLoader: TemplateLoader,
  pathOperations: PathOperationsPort,
): ProjectTemplates {
  const dir = pathOperations.join(cwd, ".rundown");
  return {
    task: templateLoader.load(pathOperations.join(dir, "execute.md")) ?? DEFAULT_TASK_TEMPLATE,
    verify: templateLoader.load(pathOperations.join(dir, "verify.md")) ?? DEFAULT_VERIFY_TEMPLATE,
    repair: templateLoader.load(pathOperations.join(dir, "repair.md")) ?? DEFAULT_REPAIR_TEMPLATE,
    plan: templateLoader.load(pathOperations.join(dir, "plan.md")) ?? DEFAULT_PLAN_TEMPLATE,
    trace: templateLoader.load(pathOperations.join(dir, "trace.md")) ?? DEFAULT_TRACE_TEMPLATE,
  };
}

interface TracePhaseMetadata {
  sequence: number;
  phase: string;
  startedAt?: string;
  completedAt?: string;
  command?: string[];
  exitCode?: number | null;
  outputCaptured?: boolean;
  stdoutFile?: string | null;
  stderrFile?: string | null;
}

interface TracePhaseArtifact {
  sequence: number;
  phase: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number;
  command: string[];
  exitCode: number | null;
  outputCaptured: boolean;
  stdout: string;
  stderr: string;
}

function collectTracePhaseArtifacts(
  artifactContext: ArtifactContext,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): TracePhaseArtifact[] {
  const entries = fileSystem.readdir(artifactContext.rootDir);
  const phases: TracePhaseArtifact[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory) {
      continue;
    }

    const phaseDir = pathOperations.join(artifactContext.rootDir, entry.name);
    const metadataPath = pathOperations.join(phaseDir, "metadata.json");
    if (!fileSystem.exists(metadataPath)) {
      continue;
    }

    const metadata = parseJson<TracePhaseMetadata>(fileSystem.readText(metadataPath));
    if (!metadata || !Number.isInteger(metadata.sequence) || typeof metadata.phase !== "string") {
      continue;
    }

    const stdout = metadata.stdoutFile
      ? readTraceArtifactText(pathOperations.join(phaseDir, metadata.stdoutFile), fileSystem)
      : "";
    const stderr = metadata.stderrFile
      ? readTraceArtifactText(pathOperations.join(phaseDir, metadata.stderrFile), fileSystem)
      : "";

    phases.push({
      sequence: metadata.sequence,
      phase: metadata.phase,
      startedAt: typeof metadata.startedAt === "string" ? metadata.startedAt : null,
      completedAt: typeof metadata.completedAt === "string" ? metadata.completedAt : null,
      durationMs: computeDurationMs(metadata.startedAt, metadata.completedAt),
      command: Array.isArray(metadata.command) ? metadata.command.filter((value): value is string => typeof value === "string") : [],
      exitCode: typeof metadata.exitCode === "number" || metadata.exitCode === null ? metadata.exitCode : null,
      outputCaptured: Boolean(metadata.outputCaptured),
      stdout,
      stderr,
    });
  }

  phases.sort((a, b) => a.sequence - b.sequence);
  return phases;
}

function readTraceArtifactText(filePath: string, fileSystem: FileSystem): string {
  if (!fileSystem.exists(filePath)) {
    return "";
  }

  try {
    return fileSystem.readText(filePath);
  } catch {
    return "";
  }
}

function computeDurationMs(startedAt: string | undefined, completedAt: string | undefined): number {
  if (!startedAt || !completedAt) {
    return 0;
  }

  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  if (!Number.isFinite(started) || !Number.isFinite(completed)) {
    return 0;
  }

  return Math.max(0, completed - started);
}

function formatPhaseTimingsForTrace(phases: TracePhaseArtifact[]): string {
  if (phases.length === 0) {
    return "(no phase metadata available)";
  }

  return phases
    .map((phase) => {
      const startedAt = phase.startedAt ?? "unknown";
      const completedAt = phase.completedAt ?? "unknown";
      return `- #${phase.sequence} ${phase.phase}: ${phase.durationMs}ms (started: ${startedAt}, completed: ${completedAt})`;
    })
    .join("\n");
}

function formatPhaseOutputsForTrace(phases: TracePhaseArtifact[]): string {
  if (phases.length === 0) {
    return "(no phase output artifacts available)";
  }

  return phases
    .map((phase) => {
      const command = phase.command.length > 0 ? phase.command.join(" ") : "(unknown)";
      const stdout = phase.stdout.trim().length > 0 ? phase.stdout : "(empty)";
      const stderr = phase.stderr.trim().length > 0 ? phase.stderr : "(empty)";
      return [
        `### Phase ${phase.sequence}: ${phase.phase}`,
        `- Command: ${command}`,
        `- Exit code: ${String(phase.exitCode)}`,
        `- Output captured: ${String(phase.outputCaptured)}`,
        "- Stdout:",
        "```text",
        stdout,
        "```",
        "- Stderr:",
        "```text",
        stderr,
        "```",
      ].join("\n");
    })
    .join("\n\n");
}

interface PhaseAnalysisSummary {
  signals: Array<{ phase: string; sequence: number; values: Record<string, string> }>;
  thinkingBlocks: Array<{ phase: string; sequence: number; content: string }>;
  tools: string[];
}

function summarizePhaseAnalyses(phases: TracePhaseArtifact[]): PhaseAnalysisSummary {
  const signals: Array<{ phase: string; sequence: number; values: Record<string, string> }> = [];
  const thinkingBlocks: Array<{ phase: string; sequence: number; content: string }> = [];
  const toolSet = new Set<string>();

  for (const phase of phases) {
    if (phase.stdout.length === 0) {
      continue;
    }

    const analysis = parseWorkerOutput(phase.stdout);
    if (analysis.agent_signals) {
      signals.push({
        phase: phase.phase,
        sequence: phase.sequence,
        values: analysis.agent_signals,
      });
    }

    for (const block of analysis.thinking_blocks) {
      thinkingBlocks.push({
        phase: phase.phase,
        sequence: phase.sequence,
        content: block.content,
      });
    }

    for (const tool of analysis.tool_calls) {
      toolSet.add(tool);
    }
  }

  return {
    signals,
    thinkingBlocks,
    tools: [...toolSet],
  };
}

function formatAgentSignalsForTrace(
  signals: Array<{ phase: string; sequence: number; values: Record<string, string> }>,
): string {
  if (signals.length === 0) {
    return "(no agent signals captured)";
  }

  return signals
    .map((signal) => {
      const lines = Object.entries(signal.values)
        .map(([key, value]) => `  - ${key}: ${value}`)
        .join("\n");
      return `- Phase #${signal.sequence} (${signal.phase}):\n${lines}`;
    })
    .join("\n");
}

function formatThinkingBlocksForTrace(
  blocks: Array<{ phase: string; sequence: number; content: string }>,
): string {
  if (blocks.length === 0) {
    return "(no thinking blocks captured)";
  }

  return blocks
    .map((block, index) => [
      `### Thinking ${index + 1} (phase #${block.sequence}, ${block.phase})`,
      "```text",
      block.content,
      "```",
    ].join("\n"))
    .join("\n\n");
}

function formatToolUsageForTrace(tools: string[]): string {
  if (tools.length === 0) {
    return "(no tools reported by worker output parser)";
  }

  return tools.map((tool) => `- ${tool}`).join("\n");
}

function parseAnalysisSummaryFromWorkerOutput(
  stdout: string,
): {
  task_complexity: "low" | "medium" | "high" | "critical";
  execution_quality: "clean" | "minor_issues" | "significant_issues" | "failed";
  direction_changes: number;
  modules_touched: string[];
  wasted_effort_pct: number;
  key_decisions: string[];
  risk_flags: string[];
  improvement_suggestions: string[];
  skill_gaps: string[];
  thinking_quality: "clear" | "scattered" | "circular";
  uncertainty_moments: number;
} | null {
  const match = stdout.match(/```analysis\.summary\s*([\s\S]*?)```/);
  if (!match) {
    return null;
  }

  const parsed = parseJson<Record<string, unknown>>(match[1] ?? "");
  if (!parsed) {
    return null;
  }

  return {
    task_complexity: asEnum(parsed.task_complexity, ["low", "medium", "high", "critical"], "medium"),
    execution_quality: asEnum(parsed.execution_quality, ["clean", "minor_issues", "significant_issues", "failed"], "minor_issues"),
    direction_changes: asNonNegativeInt(parsed.direction_changes),
    modules_touched: asStringArray(parsed.modules_touched),
    wasted_effort_pct: asNonNegativeInt(parsed.wasted_effort_pct),
    key_decisions: asStringArray(parsed.key_decisions),
    risk_flags: asStringArray(parsed.risk_flags),
    improvement_suggestions: asStringArray(parsed.improvement_suggestions),
    skill_gaps: asStringArray(parsed.skill_gaps),
    thinking_quality: asEnum(parsed.thinking_quality, ["clear", "scattered", "circular"], "scattered"),
    uncertainty_moments: asNonNegativeInt(parsed.uncertainty_moments),
  };
}

function countTraceLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return text.split(/\r?\n/).length;
}

function computeTaskContextMetrics(
  files: string[],
  selectedTask: Task,
  fileSystem: FileSystem,
): TaskContextMetrics {
  let totalUncheckedTasks = 0;

  for (const file of files) {
    if (!fileSystem.exists(file)) {
      continue;
    }

    const source = fileSystem.readText(file);
    const tasks = parseTasks(source, file);
    totalUncheckedTasks += tasks.filter((task) => !task.checked).length;
  }

  return {
    sourceFilesScanned: files.length,
    totalUncheckedTasks,
    taskPositionInFile: selectedTask.index + 1,
    hasSubtasks: hasDescendantTasks(selectedTask, fileSystem),
  };
}

function hasDescendantTasks(task: Task, fileSystem: FileSystem): boolean {
  if (!task.file || !fileSystem.exists(task.file)) {
    return false;
  }

  const source = fileSystem.readText(task.file);
  const tasks = parseTasks(source, task.file);
  const index = tasks.findIndex((candidate) => candidate.line === task.line && candidate.text === task.text);
  if (index === -1) {
    return false;
  }

  for (let i = index + 1; i < tasks.length; i++) {
    const candidate = tasks[i]!;
    if (candidate.depth <= task.depth) {
      break;
    }

    return true;
  }

  return false;
}

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function asNonNegativeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }

  return 0;
}

function asEnum<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim() as T;
  return options.includes(normalized) ? normalized : fallback;
}

function checkTaskUsingFileSystem(task: Task, fileSystem: FileSystem): void {
  const source = fileSystem.readText(task.file);
  const updated = markChecked(source, task);
  fileSystem.writeText(task.file, updated);
}

async function isGitRepoWithGitClient(gitClient: GitClient, cwd: string): Promise<boolean> {
  try {
    await gitClient.run(["rev-parse", "--is-inside-work-tree"], cwd);
    return true;
  } catch {
    return false;
  }
}

async function isWorkingDirectoryClean(gitClient: GitClient, cwd: string): Promise<boolean> {
  const output = await gitClient.run(
    ["status", "--porcelain", "--", ".", ":(exclude).rundown/runs/**"],
    cwd,
  );
  return output.trim().length === 0;
}

async function commitCheckedTaskWithGitClient(
  gitClient: GitClient,
  task: Task,
  cwd: string,
  message: string,
): Promise<void> {
  // Stage full worktree output for the task, but skip transient runtime artifacts.
  await gitClient.run(["add", "-A", "--", ".", ":(exclude).rundown/runs/**"], cwd);
  await gitClient.run(["commit", "-m", message], cwd);
}

function buildCommitMessage(
  task: Task,
  cwd: string,
  messageTemplate: string | undefined,
  pathOperations: PathOperationsPort,
): string {
  const relativePath = pathOperations.relative(cwd, task.file).replace(/\\/g, "/");
  return renderTemplate(messageTemplate ?? DEFAULT_COMMIT_MESSAGE_TEMPLATE, {
    task: task.text,
    file: relativePath,
    context: "",
    taskIndex: task.index,
    taskLine: task.line,
    source: "",
  });
}

async function runOnCompleteHookWithProcessRunner(
  processRunner: ProcessRunner,
  command: string,
  task: Task,
  source: string,
  cwd: string,
  pathOperations: PathOperationsPort,
): Promise<{ success: boolean; exitCode: number | null; stdout: string; stderr: string }> {
  try {
    const result = await processRunner.run({
      command,
      args: [],
      cwd,
      mode: "wait",
      shell: true,
      timeoutMs: 60_000,
      env: {
        ...process.env,
        RUNDOWN_TASK: task.text,
        RUNDOWN_FILE: pathOperations.resolve(task.file),
        RUNDOWN_LINE: String(task.line),
        RUNDOWN_INDEX: String(task.index),
        RUNDOWN_SOURCE: source,
      },
    });

    return {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    return {
      success: false,
      exitCode: null,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatTaskLabel(task: Task): string {
  return `${task.file}:${task.line} [#${task.index}] ${task.text}`;
}

function resolveLatestCompletedRun(
  artifactStore: ArtifactStore,
  cwd: string,
): ArtifactRunMetadata | null {
  const runs = artifactStore.listSaved(cwd);
  return runs.find((run) => isCompletedArtifactRun(run) && hasReverifiableTask(run)) ?? null;
}

function hasReverifiableTask(run: ArtifactRunMetadata): boolean {
  return Boolean(run.task && run.task.text && run.task.file);
}

function isCompletedArtifactRun(run: ArtifactRunMetadata): boolean {
  return run.status === "completed" || run.status === "reverify-completed";
}

function validateRuntimeTaskMetadata(task: RuntimeTaskMetadata): string | null {
  if (!task.text || task.text.trim() === "") {
    return "task text is missing.";
  }
  if (!task.file || task.file.trim() === "") {
    return "task file path is missing.";
  }
  if (!Number.isInteger(task.line) || task.line < 1) {
    return "task line must be a positive integer.";
  }
  if (!Number.isInteger(task.index) || task.index < 0) {
    return "task index must be a non-negative integer.";
  }
  if (!task.source || task.source.trim() === "") {
    return "task source is missing.";
  }
  return null;
}

function resolveTaskContextFromRuntimeMetadata(
  metadata: RuntimeTaskMetadata,
  cwd: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): ResolvedTaskContext | null {
  const resolvedFilePath = pathOperations.isAbsolute(metadata.file)
    ? metadata.file
    : pathOperations.resolve(cwd, metadata.file);

  if (!fileSystem.exists(resolvedFilePath)) {
    return null;
  }

  const source = fileSystem.readText(resolvedFilePath);
  const tasks = parseTasks(source, resolvedFilePath);
  const resolvedTask = findTaskByFallback(tasks, metadata);
  if (!resolvedTask) {
    return null;
  }

  const lines = source.split("\n");
  return {
    task: resolvedTask,
    source,
    contextBefore: lines.slice(0, resolvedTask.line - 1).join("\n"),
  };
}

function findTaskByFallback(tasks: Task[], metadata: RuntimeTaskMetadata): Task | null {
  const byLineAndText = tasks.find((task) => task.line === metadata.line && task.text === metadata.text);
  if (byLineAndText) {
    return byLineAndText;
  }

  const byIndexAndText = tasks.find((task) => task.index === metadata.index && task.text === metadata.text);
  if (byIndexAndText) {
    return byIndexAndText;
  }

  const textMatches = tasks.filter((task) => task.text === metadata.text);
  if (textMatches.length === 1) {
    return textMatches[0] ?? null;
  }

  return null;
}

export function toRuntimeTaskMetadata(
  task: Task,
  source: string,
): RuntimeTaskMetadata {
  return {
    text: task.text,
    file: task.file,
    line: task.line,
    index: task.index,
    source,
  };
}

export function isOpenCodeWorkerCommand(workerCommand: string[]): boolean {
  if (workerCommand.length === 0) {
    return false;
  }

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

export const runTask = createRunTask;
