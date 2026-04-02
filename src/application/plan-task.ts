import { getTraceInstructions } from "../domain/defaults.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import { parseTasks } from "../domain/parser.js";
import { insertPlannerTodos } from "../domain/planner.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import { resolveWorkerForInvocation } from "./resolve-worker.js";
import { isOpenCodeWorkerCommand } from "./run-task.js";
import {
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import {
  TemplateCliBlockExecutionError,
  withTemplateCliFailureAbort,
} from "./cli-block-handlers.js";
import { loadProjectTemplatesFromPorts } from "./project-templates.js";
import { countTraceLines } from "./run-task-utils.js";
import {
  createOutputVolumeEvent,
  createPhaseCompletedEvent,
  createPhaseStartedEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  type TraceRunStatus,
} from "../domain/trace.js";
import type {
  ArtifactStoreStatus,
  ArtifactRunContext,
  ArtifactStore,
  CommandExecutor,
  ConfigDirResult,
  FileLock,
  FileSystem,
  PathOperationsPort,
  ProcessRunMode,
   TemplateLoader,
   TemplateVarsLoaderPort,
   TraceWriterPort,
   WorkerConfigPort,
   WorkerExecutorPort,
   WorkingDirectoryPort,
 } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

/**
 * Execution mode used when invoking the planning worker.
 */
export type RunnerMode = ProcessRunMode;

/**
 * Transport strategy used to deliver prompts to the planning worker.
 */
export type PromptTransport = "file" | "arg";

/**
 * Artifact context alias used for plan command runs.
 */
type ArtifactContext = ArtifactRunContext;

/**
 * Convergence states tracked across multi-scan planning runs.
 */
type PlanConvergenceOutcome = "converged" | "scan-cap-reached";

/**
 * Ports and services required to execute the `plan` command.
 */
export interface PlanTaskDependencies {
  workerExecutor: WorkerExecutorPort;
  workingDirectory: WorkingDirectoryPort;
  cliBlockExecutor: CommandExecutor;
  fileSystem: FileSystem;
  fileLock: FileLock;
  pathOperations: PathOperationsPort;
  templateVarsLoader: TemplateVarsLoaderPort;
  workerConfigPort: WorkerConfigPort;
  templateLoader: TemplateLoader;
  artifactStore: ArtifactStore;
  traceWriter: TraceWriterPort;
  configDir: ConfigDirResult | undefined;
  createTraceWriter: (trace: boolean, artifactContext: ArtifactContext) => TraceWriterPort;
  output: ApplicationOutputPort;
}

/**
 * Runtime options accepted by a single `plan` command invocation.
 */
export interface PlanTaskOptions {
  source: string;
  scanCount?: number;
  mode: RunnerMode;
  transport: PromptTransport;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
}

const OPENCODE_CONTINUATION_ARG_PATTERN = /^--(?:continue|resume|session|thread|conversation)(?:=|$)/i;

/**
 * Creates the plan task runner that expands templates, invokes the worker, and
 * inserts additive TODO items into the source Markdown document.
 */
export function createPlanTask(
  dependencies: PlanTaskDependencies,
): (options: PlanTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);
  const cliBlockExecutor = dependencies.cliBlockExecutor;

  return async function planTask(options: PlanTaskOptions): Promise<number> {
    const {
      source,
      scanCount = 3,
      mode,
      transport,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
      trace,
      forceUnlock,
      ignoreCliBlock,
      cliBlockTimeoutMs,
    } = options;
    const cliExecutionOptions = cliBlockTimeoutMs === undefined
      ? undefined
      : { timeoutMs: cliBlockTimeoutMs };
    const cliExecutionOptionsWithTemplateFailureAbort = withTemplateCliFailureAbort(
      cliExecutionOptions,
      "plan template",
    );

    // Allow manual lock cleanup before acquiring a fresh lock for this run.
    if (forceUnlock) {
      if (!dependencies.fileLock.isLocked(source)) {
        dependencies.fileLock.forceRelease(source);
        emit({ kind: "info", message: "Force-unlocked stale source lock: " + source });
      }
    }

    // Acquire an exclusive lock so concurrent runs cannot modify the same source.
    try {
      dependencies.fileLock.acquire(source, { command: "plan" });
    } catch (error) {
      if (error instanceof FileLockError) {
        emit({
          kind: "error",
          message: "Source file is locked by another rundown process: "
            + error.filePath
            + " (pid=" + error.holder.pid
            + ", command=" + error.holder.command
            + ", startTime=" + error.holder.startTime
            + "). If this lock is stale, rerun with --force-unlock or run `rundown unlock "
            + error.filePath
            + "`.",
        });
        return 1;
      }
      throw error;
    }

    try {
      // Merge template variables loaded from file and CLI flags.
      const varsFilePath = resolveTemplateVarsFilePath(
        varsFileOption,
        dependencies.configDir?.configDir,
      );
      const cwd = dependencies.workingDirectory.cwd();
      const fileTemplateVars = varsFilePath
        ? dependencies.templateVarsLoader.load(
          varsFilePath,
          cwd,
          dependencies.configDir?.configDir,
        )
        : {};
      const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs);
      const extraTemplateVars: ExtraTemplateVars = {
        ...fileTemplateVars,
        ...cliTemplateVars,
      };

      // Read the Markdown source that will receive planner TODO insertions.
      let documentSource: string;
      try {
        documentSource = dependencies.fileSystem.readText(source);
      } catch {
        emit({
          kind: "error",
          message: "Unable to read Markdown document: " + source,
        });
        return 3;
      }

      // Infer user intent and current TODO density to guide prompt rendering.
      const documentIntent = deriveDocumentIntent(documentSource, source);
      const existingTodoCount = parseTasks(documentSource, source).length;
      const hasExistingTodos = existingTodoCount > 0;
      const loadedWorkerConfig = dependencies.configDir?.configDir
        ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
        : undefined;
      const resolvedWorkerCommand = resolveWorkerForInvocation({
        commandName: "plan",
        workerConfig: loadedWorkerConfig,
        source: documentSource,
        cliWorkerCommand: workerCommand,
        emit,
      });
      emit({
        kind: "info",
        message: "Planning document: " + source,
      });
      emit({
        kind: "info",
        message: hasExistingTodos
          ? "Detected " + existingTodoCount + " existing TODO item" + (existingTodoCount === 1 ? "" : "s") + " in document."
          : "No existing TODO items detected in document.",
      });

      // Planner execution requires a resolved worker command.
      if (resolvedWorkerCommand.length === 0) {
        emit({
          kind: "error",
          message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <command...> or -- <command>.",
        });
        return 1;
      }

      // Multi-scan planning must always run in clean worker sessions.
      const cleanSessionCommandError = validatePlanCleanSessionWorkerCommand(resolvedWorkerCommand);
      if (cleanSessionCommandError) {
        emit({ kind: "error", message: cleanSessionCommandError });
        return 1;
      }

      // Render the plan prompt template with the current document context.
      const planTemplate = loadProjectTemplatesFromPorts(
        dependencies.configDir,
        dependencies.templateLoader,
        dependencies.pathOperations,
      ).plan;

      const vars: TemplateVars = {
        ...extraTemplateVars,
        traceInstructions: getTraceInstructions(trace),
        task: documentIntent,
        file: source,
        context: documentSource,
        taskIndex: 0,
        taskLine: 1,
        source: documentSource,
        scanCount,
        existingTodoCount,
        hasExistingTodos: hasExistingTodos ? "true" : "false",
      };

      const renderedPrompt = renderTemplate(planTemplate, vars);
      const promptCliBlockCount = extractCliBlocks(renderedPrompt).length;
      const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
      let prompt = renderedPrompt;

      // Expand `cli` fenced blocks unless disabled for this invocation.
      if (!ignoreCliBlock && !dryRunSuppressesCliExpansion) {
        try {
          prompt = await expandCliBlocks(
            renderedPrompt,
            cliBlockExecutor,
            cwd,
            cliExecutionOptionsWithTemplateFailureAbort,
          );
        } catch (error) {
          if (error instanceof TemplateCliBlockExecutionError) {
            const exitCodeLabel = error.exitCode === null ? "unknown" : String(error.exitCode);
            emit({
              kind: "error",
              message: "`cli` fenced command failed in "
                + error.templateLabel
                + " (exit "
                + exitCodeLabel
                + "): "
                + error.command
                + ". Aborting run.",
            });
            return 1;
          }
          throw error;
        }
      }

      // Print mode returns the effective prompt without invoking the worker.
      if (printPrompt) {
        emit({ kind: "text", text: buildPlanScanPrompt(prompt, documentSource, 1, scanCount) });
        return 0;
      }

      // Dry run reports planned execution details and exits successfully.
      if (dryRun) {
        if (dryRunSuppressesCliExpansion && !ignoreCliBlock) {
          emit({
            kind: "info",
            message: "Dry run — skipped `cli` fenced block execution; would execute "
              + promptCliBlockCount
              + " block"
              + (promptCliBlockCount === 1 ? "" : "s")
              + ".",
          });
        }
        emit({ kind: "info", message: "Dry run — would plan: " + resolvedWorkerCommand.join(" ") });
        emit({ kind: "info", message: "Scan count: " + scanCount });
        emit({ kind: "info", message: "Prompt length: " + buildPlanScanPrompt(prompt, documentSource, 1, scanCount).length + " chars" });
        return 0;
      }

      // Create artifact and trace context for a real planning execution.
      const artifactContext = dependencies.artifactStore.createContext({
        cwd,
        configDir: dependencies.configDir?.configDir,
        commandName: "plan",
        workerCommand: resolvedWorkerCommand,
        mode,
        transport,
        source,
        task: {
          text: documentIntent,
          file: source,
          line: 1,
          index: 0,
          source: source,
        },
        keepArtifacts,
      });
      const traceWriter = dependencies.createTraceWriter(trace, artifactContext);
      let artifactsFinalized = false;
      let artifactStatus: ArtifactStoreStatus = "running";
      let tracePhaseCount = 0;
      let traceCompleted = false;
      const traceStartedAtMs = Date.now();

      const nowIso = (): string => new Date().toISOString();
      const toTraceStatus = (status: ArtifactStoreStatus): TraceRunStatus => status;

      // Emit run-start trace event before any scan executes.
      traceWriter.write(createRunStartedEvent({
        timestamp: nowIso(),
        run_id: artifactContext.runId,
        payload: {
          command: "plan",
          source,
          worker: resolvedWorkerCommand,
          mode,
          transport,
          task_text: documentIntent,
          task_file: source,
          task_line: 1,
        },
      }));

      // Record phase start timing and metadata for each scan execution.
      const beginPlanPhaseTrace = (command: string[]): { sequence: number; startedAtMs: number } => {
        const sequence = tracePhaseCount + 1;
        tracePhaseCount = sequence;
        traceWriter.write(createPhaseStartedEvent({
          timestamp: nowIso(),
          run_id: artifactContext.runId,
          payload: {
            phase: "plan",
            sequence,
            command,
          },
        }));

        return { sequence, startedAtMs: Date.now() };
      };

      // Emit phase completion and output volume metrics for each scan.
      const completePlanPhaseTrace = (
        phaseTrace: { sequence: number; startedAtMs: number },
        exitCode: number | null,
        stdout: string,
        stderr: string,
        outputCaptured: boolean,
      ): void => {
        const timestamp = nowIso();
        traceWriter.write(createPhaseCompletedEvent({
          timestamp,
          run_id: artifactContext.runId,
          payload: {
            phase: "plan",
            sequence: phaseTrace.sequence,
            exit_code: exitCode,
            duration_ms: Math.max(0, Date.now() - phaseTrace.startedAtMs),
            stdout_bytes: Buffer.byteLength(stdout, "utf8"),
            stderr_bytes: Buffer.byteLength(stderr, "utf8"),
            output_captured: outputCaptured,
          },
        }));
        traceWriter.write(createOutputVolumeEvent({
          timestamp,
          run_id: artifactContext.runId,
          payload: {
            phase: "plan",
            sequence: phaseTrace.sequence,
            stdout_bytes: Buffer.byteLength(stdout, "utf8"),
            stderr_bytes: Buffer.byteLength(stderr, "utf8"),
            stdout_lines: countTraceLines(stdout),
            stderr_lines: countTraceLines(stderr),
          },
        }));
      };

      // Finalize the trace run once, even if multiple exit paths are hit.
      const completeTraceRun = (status: ArtifactStoreStatus): void => {
        if (traceCompleted) {
          return;
        }

        traceWriter.write(createRunCompletedEvent({
          timestamp: nowIso(),
          run_id: artifactContext.runId,
          payload: {
            status: toTraceStatus(status),
            total_duration_ms: Math.max(0, Date.now() - traceStartedAtMs),
            total_phases: tracePhaseCount,
          },
        }));
        traceCompleted = true;
      };

      // Complete the run by flushing trace output and finalizing artifacts.
      const finishPlan = (
        code: number,
        status: ArtifactStoreStatus,
        extra?: Record<string, unknown>,
      ): number => {
        artifactStatus = status;
        completeTraceRun(status);
        traceWriter.flush();
        finalizePlanArtifacts(dependencies.artifactStore, artifactContext, keepArtifacts, artifactStatus, emit, extra);
        artifactsFinalized = true;
        return code;
      };

      try {
        emit({
          kind: "info",
          message: "Running planner: " + resolvedWorkerCommand.join(" ") + " [mode=" + mode + ", transport=" + transport + "]",
        });

        // Track mutable scan-loop state for convergence reporting and totals.
        let latestDocumentSource = documentSource;
        let insertedTotal = 0;
        let scansExecuted = 0;
        let convergenceOutcome: PlanConvergenceOutcome | null = null;

        // Execute up to `scanCount` independent scans, reloading source each time.
        for (let scanIndex = 1; scanIndex <= scanCount; scanIndex += 1) {
          const scanLabel = buildPlanScanLabel(scanIndex, scanCount);
          try {
            latestDocumentSource = dependencies.fileSystem.readText(source);
          } catch {
            emit({
              kind: "error",
              message: "Unable to reload Markdown document before scan " + scanIndex + ": " + source,
            });
            return finishPlan(3, "failed");
          }

          emit({
            kind: "info",
            message: "Planning " + scanLabel + ".",
          });
          scansExecuted += 1;

          // Build per-scan prompt context and execute the planner worker.
          const scanPrompt = buildPlanScanPrompt(prompt, latestDocumentSource, scanIndex, scanCount);
          const planPhaseTrace = beginPlanPhaseTrace(resolvedWorkerCommand);
          const runResult = await dependencies.workerExecutor.runWorker({
            command: [...resolvedWorkerCommand],
            prompt: scanPrompt,
            mode,
            transport,
            trace,
            cwd,
            configDir: dependencies.configDir?.configDir,
            artifactContext,
            artifactPhase: "plan",
            artifactPhaseLabel: buildPlanScanPhaseLabel(scanIndex, scanCount),
            artifactExtra: {
              scanIndex,
              scanCount,
              scanLabel,
            },
          });
          completePlanPhaseTrace(
            planPhaseTrace,
            runResult.exitCode,
            runResult.stdout,
            runResult.stderr,
            mode === "wait",
          );

          // Forward worker stderr in wait mode to preserve CLI diagnostics.
          if (mode === "wait" && runResult.stderr) {
            emit({ kind: "stderr", text: runResult.stderr });
          }

          // Non-zero exits fail the planning run for this task.
          if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
            emit({ kind: "error", message: "Planner worker exited with code " + runResult.exitCode + " during scan " + scanIndex + "." });
            return finishPlan(1, "execution-failed");
          }

          // Empty output indicates there are no additional TODOs to add.
          if (!runResult.stdout || runResult.stdout.trim().length === 0) {
            convergenceOutcome = "converged";
            if (scanIndex === 1) {
              emit({ kind: "warn", message: "Planner produced no output. No TODO items added." });
            } else {
              emit({ kind: "info", message: "Planner converged at scan " + scanIndex + ": no additional TODO items proposed." });
            }
            break;
          }

          // Accept only additive TODO changes and reject destructive output.
          const applyResult = applyPlannerOutput(latestDocumentSource, runResult.stdout);
          if (applyResult.rejected) {
            emit({
              kind: "error",
              message: applyResult.rejectionReason ?? "Planner output was rejected because only additive TODO operations are allowed.",
            });
            return finishPlan(1, "failed");
          }

          // Zero insertions from valid output also counts as convergence.
          if (applyResult.insertedCount === 0) {
            convergenceOutcome = "converged";
            if (scanIndex === 1) {
              emit({ kind: "warn", message: "Planner output contained no valid TODO items to add." });
            } else {
              emit({ kind: "info", message: "Planner converged at scan " + scanIndex + ": no new TODO additions required." });
            }
            break;
          }

          // Persist inserted TODO items before running the next scan.
          latestDocumentSource = applyResult.updatedSource;
          dependencies.fileSystem.writeText(source, latestDocumentSource);
          insertedTotal += applyResult.insertedCount;
        }

        // Hitting the scan cap without convergence is tracked explicitly.
        if (scansExecuted > 0 && convergenceOutcome === null) {
          convergenceOutcome = "scan-cap-reached";
        }

        const convergenceMetadata = convergenceOutcome
          ? buildPlanConvergenceMetadata(scanCount, scansExecuted, convergenceOutcome)
          : undefined;

        // Return success when no insertions are needed after all scans.
        if (insertedTotal === 0) {
          return finishPlan(0, "completed", convergenceMetadata);
        }

        emit({
          kind: "success",
          message: "Inserted " + insertedTotal + " TODO item" + (insertedTotal === 1 ? "" : "s") + " into: " + source,
        });
        return finishPlan(0, "completed", convergenceMetadata);
      } finally {
        // Ensure trace and artifacts are finalized on all exceptional exits.
        if (!artifactsFinalized) {
          const finalStatus = artifactStatus === "running" ? "failed" : artifactStatus;
          completeTraceRun(finalStatus);
          traceWriter.flush();
          finalizePlanArtifacts(dependencies.artifactStore, artifactContext, keepArtifacts, finalStatus, emit);
          artifactsFinalized = true;
        }
      }
    } finally {
      try {
        // Release all held source locks regardless of execution outcome.
        dependencies.fileLock.releaseAll();
      } catch (error) {
        emit({ kind: "warn", message: "Failed to release file locks: " + String(error) });
      }
    }
  };
}

/**
 * Finalizes artifact storage and emits the artifact location when preserved.
 */
function finalizePlanArtifacts(
  artifactStore: ArtifactStore,
  artifactContext: ArtifactContext,
  keepArtifacts: boolean,
  status: ArtifactStoreStatus,
  emit: ApplicationOutputPort["emit"],
  extra?: Record<string, unknown>,
): void {
  const preserve = keepArtifacts || artifactStore.isFailedStatus(status);
  artifactStore.finalize(artifactContext, {
    status,
    preserve,
    extra,
  });

  if (preserve) {
    emit({
      kind: "info",
      message: "Runtime artifacts saved at "
        + artifactStore.displayPath(artifactContext)
        + ".",
    });
  }
}

/**
 * Applies planner output with additive-only TODO insertion rules.
 */
function applyPlannerOutput(
  markdownSource: string,
  plannerOutput: string,
): { updatedSource: string; insertedCount: number; rejected: boolean; rejectionReason?: string } {
  const hasExistingTodos = parseTasks(markdownSource).length > 0;
  return insertPlannerTodos(markdownSource, plannerOutput, { hasExistingTodos });
}

/**
 * Builds structured convergence metadata for artifact finalization.
 */
function buildPlanConvergenceMetadata(
  scanCount: number,
  scansExecuted: number,
  convergenceOutcome: PlanConvergenceOutcome,
): Record<string, unknown> {
  return {
    planScanCount: scanCount,
    planScansExecuted: scansExecuted,
    planConvergenceOutcome: convergenceOutcome,
    planConverged: convergenceOutcome === "converged",
    planScanCapReached: convergenceOutcome === "scan-cap-reached",
  };
}

/**
 * Derives a user-facing planning intent from the first H1 heading when present.
 */
function deriveDocumentIntent(source: string, fallbackPath: string): string {
  const headingMatch = source.match(/^\s{0,3}#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  return "Plan TODO coverage for " + fallbackPath;
}

/**
 * Builds the per-scan worker prompt with clean-session guidance and current source.
 */
function buildPlanScanPrompt(
  basePrompt: string,
  latestDocumentSource: string,
  scanIndex: number,
  scanCount: number,
): string {
  const scanLabel = buildPlanScanLabel(scanIndex, scanCount);
  const stableDocumentSource = normalizeScanDocumentSource(latestDocumentSource);

  return `${basePrompt}\n\n## Scan Context\n\nScan label: ${scanLabel}\nScan pass ${scanIndex} of ${scanCount}.\n\nTreat this scan as a clean standalone worker session. Do not rely on prior prompt history or prior scan outputs beyond the current document state shown below.\n\nCurrent document state (normalized to LF newlines):\n\n\`\`\`markdown\n${stableDocumentSource}\n\`\`\`\n\nReturn ONLY missing TODO additions that are not already present in the current document.\nIf there are no missing TODO additions, return an empty response.`;
}

/**
 * Builds a stable scan label used in messages and trace metadata.
 */
function buildPlanScanLabel(scanIndex: number, scanCount: number): string {
  const width = Math.max(2, String(scanCount).length);
  const indexLabel = String(scanIndex).padStart(width, "0");
  const countLabel = String(scanCount).padStart(width, "0");
  return `plan-scan-${indexLabel}-of-${countLabel}`;
}

/**
 * Builds the artifact phase label for a specific scan index.
 */
function buildPlanScanPhaseLabel(scanIndex: number, scanCount: number): string {
  const width = Math.max(2, String(scanCount).length);
  const indexLabel = String(scanIndex).padStart(width, "0");
  return `plan-scan-${indexLabel}`;
}

/**
 * Normalizes source text to LF newlines and guarantees a trailing newline.
 */
function normalizeScanDocumentSource(source: string): string {
  const normalized = source.replace(/\r\n?/g, "\n");
  return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

/**
 * Validates worker command arguments that would violate clean per-scan sessions.
 */
function validatePlanCleanSessionWorkerCommand(workerCommand: string[]): string | null {
  if (!isOpenCodeCommand(workerCommand[0])) {
    return null;
  }

  const continuationArg = workerCommand.find((arg) => OPENCODE_CONTINUATION_ARG_PATTERN.test(arg));
  if (continuationArg) {
    return `The \`plan\` command requires clean per-scan worker sessions. Remove continuation argument \`${continuationArg}\` from --worker.`;
  }

  const hasResumeSubcommand = workerCommand.some((arg) => arg.toLowerCase() === "resume");
  if (hasResumeSubcommand) {
    return "The `plan` command does not allow `opencode resume` because scans must run in clean worker sessions.";
  }

  return null;
}

/**
 * Detects whether the worker command targets OpenCode execution.
 */
function isOpenCodeCommand(command: string | undefined): boolean {
  if (typeof command !== "string") {
    return false;
  }

  return isOpenCodeWorkerCommand([command]);
}
