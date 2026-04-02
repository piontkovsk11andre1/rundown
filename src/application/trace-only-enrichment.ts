import { renderTemplate } from "../domain/template.js";
import {
  createAnalysisSummaryEvent,
  createOutputVolumeEvent,
  createPhaseCompletedEvent,
  createPhaseStartedEvent,
} from "../domain/trace.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  ConfigDirResult,
  FileSystem,
  PathOperationsPort,
  PromptTransport,
  TemplateLoader,
  TraceWriterPort,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { loadProjectTemplatesFromPorts } from "./project-templates.js";
import {
  resolveLatestCompletedRun,
  resolveTaskContextFromRuntimeMetadata,
  validateRuntimeTaskMetadata,
} from "./task-context-resolution.js";
import {
  collectTracePhaseArtifacts,
  formatAgentSignalsForTrace,
  formatPhaseOutputsForTrace,
  formatPhaseTimingsForTrace,
  formatThinkingBlocksForTrace,
  formatToolUsageForTrace,
  parseAnalysisSummaryFromWorkerOutput,
  summarizePhaseAnalyses,
} from "./trace-artifacts.js";
import { computeDurationMs, countTraceLines } from "./run-task-utils.js";

export interface TraceOnlyEnrichmentDependencies {
  workingDirectory: WorkingDirectoryPort;
  configDir: ConfigDirResult | undefined;
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  templateLoader: TemplateLoader;
  workerExecutor: WorkerExecutorPort;
  createTraceWriter: (trace: boolean, artifactContext: ArtifactRunContext) => TraceWriterPort;
  emit: ApplicationOutputPort["emit"];
}

/**
 * Captures runtime options used when replaying trace enrichment for a
 * previously completed run.
 */
export interface RunTraceOnlyEnrichmentOptions {
  transport: PromptTransport;
  workerCommand: string[];
}

/**
 * Replays the trace-enrichment phase against the latest completed runtime
 * artifact run and appends a validated `analysis.summary` event to that run's
 * trace stream.
 */
export async function runTraceOnlyEnrichment(
  dependencies: TraceOnlyEnrichmentDependencies,
  options: RunTraceOnlyEnrichmentOptions,
): Promise<number> {
  // Resolve the active workspace and artifact base needed to locate saved runs.
  const cwd = dependencies.workingDirectory.cwd();
  const artifactBaseDir = dependencies.configDir?.configDir;
  const selectedRun = resolveLatestCompletedRun(dependencies.artifactStore, artifactBaseDir);
  if (!selectedRun) {
    dependencies.emit({ kind: "error", message: "No saved runtime artifact run found for: latest completed" });
    return 3;
  }

  if (!selectedRun.task) {
    dependencies.emit({
      kind: "error",
      message: "Selected run has no task metadata to run trace-only enrichment.",
    });
    return 3;
  }

  // Validate that persisted task metadata is present and structurally usable.
  const metadataError = validateRuntimeTaskMetadata(selectedRun.task);
  if (metadataError) {
    dependencies.emit({ kind: "error", message: "Selected run has invalid task metadata: " + metadataError });
    return 3;
  }

  // Re-resolve the task in source files so the enrichment prompt references current context.
  const taskContext = resolveTaskContextFromRuntimeMetadata(
    selectedRun.task,
    cwd,
    dependencies.fileSystem,
    dependencies.pathOperations,
  );
  if (!taskContext) {
    dependencies.emit({
      kind: "error",
      message: "Could not resolve task from saved metadata. The task may have moved or been edited.",
    });
    return 3;
  }

  // Load project templates once so we can render the dedicated trace prompt.
  const templates = loadProjectTemplatesFromPorts(
    dependencies.configDir,
    dependencies.templateLoader,
    dependencies.pathOperations,
  );

  // Prefer an explicit CLI worker command, then fall back to the command saved with the run.
  const effectiveWorkerCommand = options.workerCommand.length > 0
    ? options.workerCommand
    : selectedRun.workerCommand ?? [];
  if (effectiveWorkerCommand.length === 0) {
    dependencies.emit({
      kind: "error",
      message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <command...> or -- <command>.",
    });
    return 1;
  }

  // Reconstruct the artifact context expected by trace readers and writers.
  const artifactContextForRun: ArtifactRunContext = {
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

  // Gather prior phase artifacts to produce normalized enrichment inputs.
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

  // Render the enrichment prompt with run metadata, phase timings, and extracted analyses.
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

  // Emit enrichment events as a synthetic phase appended after existing phase artifacts.
  const traceWriter = dependencies.createTraceWriter(true, artifactContextForRun);
  const nowIso = (): string => new Date().toISOString();
  const sequence = phaseArtifacts.length + 1;
  const phaseStartedAtMs = Date.now();

  dependencies.emit({ kind: "info", message: "Trace-only enrichment for run: " + selectedRun.runId });

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
    // Run the enrichment worker without recursive tracing to avoid nested trace output.
    const enrichmentResult = await dependencies.workerExecutor.runWorker({
      command: effectiveWorkerCommand,
      prompt: tracePrompt,
      mode: "wait",
      transport: options.transport,
      trace: false,
      cwd,
      configDir: dependencies.configDir?.configDir,
    });

    // Persist completion and output-volume metrics for the synthetic phase.
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

    // Treat non-zero or missing exit codes as enrichment failures.
    if (enrichmentResult.exitCode !== 0 || enrichmentResult.exitCode === null) {
      dependencies.emit({ kind: "error", message: "Trace enrichment worker did not complete successfully." });
      return 1;
    }

    // Parse and persist the structured analysis payload expected by trace consumers.
    const analysisSummaryPayload = parseAnalysisSummaryFromWorkerOutput(enrichmentResult.stdout);
    if (!analysisSummaryPayload) {
      dependencies.emit({ kind: "error", message: "Trace enrichment output did not contain a valid analysis.summary block." });
      return 2;
    }

    traceWriter.write(createAnalysisSummaryEvent({
      timestamp: nowIso(),
      run_id: selectedRun.runId,
      payload: analysisSummaryPayload,
    }));
    traceWriter.flush();
    dependencies.emit({ kind: "success", message: "Trace enrichment completed for run: " + selectedRun.runId });
    return 0;
  } catch (error) {
    // On unexpected failures, still close the phase with synthetic stderr details.
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
