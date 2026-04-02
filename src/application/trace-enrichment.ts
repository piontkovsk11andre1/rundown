import { renderTemplate } from "../domain/template.js";
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
import { createTraceRunSession } from "./trace-run-session.js";
import type { Task } from "../domain/parser.js";
import type {
  ArtifactRunContext,
  ArtifactStoreStatus,
  PromptTransport,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ProjectTemplates } from "./project-templates.js";
import type { RunTaskDependencies } from "./run-task-execution.js";

type EmitFn = (event: Parameters<ApplicationOutputPort["emit"]>[0]) => void;
type ArtifactContext = ArtifactRunContext;

/**
 * Carries source task details and template inputs used to build the trace-enrichment prompt.
 */
export interface TraceEnrichmentContext {
  task: Task;
  source: string;
  contextBefore: string;
  worker: string[];
  templates: ProjectTemplates;
}

/**
 * Executes the optional trace-enrichment pass after the main task run and queues
 * an `analysis.summary` payload when the enrichment worker returns valid output.
 */
export async function runTraceEnrichment(params: {
  trace: boolean;
  status: ArtifactStoreStatus;
  artifactContext: ArtifactContext | null;
  traceRunSession: ReturnType<typeof createTraceRunSession>;
  traceEnrichmentContext: TraceEnrichmentContext | null;
  dependencies: Pick<
    RunTaskDependencies,
    "fileSystem" | "pathOperations" | "workerExecutor" | "workingDirectory" | "configDir"
  >;
  transport: PromptTransport;
  emit: EmitFn;
}): Promise<void> {
  const {
    trace,
    status,
    artifactContext,
    traceRunSession,
    traceEnrichmentContext,
    dependencies,
    transport,
    emit,
  } = params;

  // Skip enrichment when tracing is disabled or artifact storage is detached.
  if (!trace || status === "detached") {
    return;
  }

  // Enrichment requires an active run, artifact context, and enrichment inputs.
  if (!artifactContext || !traceRunSession.hasActiveRun() || !traceEnrichmentContext) {
    return;
  }

  // Guard against partially initialized run metadata.
  const runId = traceRunSession.getRunId();
  const startedAtMs = traceRunSession.getStartedAtMs();
  if (!runId || startedAtMs === null) {
    return;
  }

  // Build a compact snapshot of earlier phase artifacts to seed enrichment analysis.
  const phaseArtifacts = collectTracePhaseArtifacts(
    artifactContext,
    dependencies.fileSystem,
    dependencies.pathOperations,
  );
  const analysis = summarizePhaseAnalyses(phaseArtifacts);
  const completedAtIso = new Date().toISOString();
  const totalDurationMs = Math.max(0, Date.now() - startedAtMs);

  // Render the enrichment prompt with timing, outputs, and normalized analysis blocks.
  const tracePrompt = renderTemplate(traceEnrichmentContext.templates.trace, {
    task: traceEnrichmentContext.task.text,
    file: traceEnrichmentContext.task.file,
    context: traceEnrichmentContext.contextBefore,
    taskIndex: traceEnrichmentContext.task.index,
    taskLine: traceEnrichmentContext.task.line,
    source: traceEnrichmentContext.source,
    runId,
    command: "run",
    status,
    worker: traceEnrichmentContext.worker.join(" "),
    startedAt: new Date(startedAtMs).toISOString(),
    completedAt: completedAtIso,
    totalDurationMs,
    phaseTimings: formatPhaseTimingsForTrace(phaseArtifacts),
    phaseOutputs: formatPhaseOutputsForTrace(phaseArtifacts),
    agentSignals: formatAgentSignalsForTrace(analysis.signals),
    thinkingBlocks: formatThinkingBlocksForTrace(analysis.thinkingBlocks),
    toolUsage: formatToolUsageForTrace(analysis.tools),
  });
  traceRunSession.emitPromptMetrics(tracePrompt, traceEnrichmentContext.contextBefore, "trace.md");

  // Record enrichment as a dedicated trace phase for observability.
  const enrichmentPhase = traceRunSession.beginPhase("plan", traceEnrichmentContext.worker);

  try {
    // Run the enrichment worker without recursive tracing to avoid nested trace noise.
    const enrichmentResult = await dependencies.workerExecutor.runWorker({
      command: traceEnrichmentContext.worker,
      prompt: tracePrompt,
      mode: "wait",
      transport,
      trace: false,
      cwd: dependencies.workingDirectory.cwd(),
      configDir: dependencies.configDir?.configDir,
      artifactContext,
      artifactPhase: "worker",
      artifactExtra: {
        taskType: "trace-enrichment",
      },
    });

    // Persist stdout/stderr and completion state for the enrichment phase.
    traceRunSession.completePhase(
      enrichmentPhase,
      enrichmentResult.exitCode,
      enrichmentResult.stdout,
      enrichmentResult.stderr,
      true,
    );

    // Skip summary queuing when the worker did not finish successfully.
    if (enrichmentResult.exitCode !== 0 || enrichmentResult.exitCode === null) {
      emit({ kind: "warn", message: "Trace enrichment worker did not complete successfully; skipping analysis.summary event." });
      return;
    }

    // Extract the structured analysis payload expected by downstream trace consumers.
    const analysisSummaryPayload = parseAnalysisSummaryFromWorkerOutput(enrichmentResult.stdout);
    if (!analysisSummaryPayload) {
      emit({ kind: "warn", message: "Trace enrichment output did not contain a valid analysis.summary block." });
      return;
    }

    // Queue the parsed summary for emission after run finalization.
    traceRunSession.queueAnalysisSummary(analysisSummaryPayload);
  } catch (error) {
    // Capture failures in phase artifacts and surface a warning for operator visibility.
    traceRunSession.completePhase(enrichmentPhase, null, "", error instanceof Error ? error.message : String(error), true);
    emit({ kind: "warn", message: "Trace enrichment failed: " + String(error) });
  }
}
