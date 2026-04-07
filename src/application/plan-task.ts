import {
  DEFAULT_DEEP_PLAN_TEMPLATE,
  getTraceInstructions,
} from "../domain/defaults.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { parseTasks } from "../domain/parser.js";
import {
  validatePlanEdit,
} from "../domain/planner.js";
import {
  buildMemoryTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";
import { isOpenCodeWorkerCommand } from "./run-task.js";
import {
  buildRundownVarEnv,
  formatTemplateVarsForPrompt,
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
import {
  countTraceLines,
  formatNoItemsFoundIn,
  formatSuccessFailureSummary,
  pluralize,
} from "./run-task-utils.js";
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
  MemoryResolverPort,
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
 * Artifact context alias used for plan command runs.
 */
type ArtifactContext = ArtifactRunContext;

/**
 * Convergence states tracked across multi-scan planning runs.
 */
export type PlanConvergenceOutcome =
  | "converged-no-change"
  | "converged-no-additions"
  | "scan-cap-reached"
  | "emergency-cap-reached";

/**
 * Structured convergence metadata persisted with plan artifacts.
 */
interface PlanConvergenceMetadata extends Record<string, unknown> {
  planScanMode: PlanScanMode;
  planScanCount: number | null;
  planScansExecuted: number;
  planConvergenceReason: PlanConvergenceOutcome;
  planConvergenceOutcome: PlanConvergenceOutcome;
  planConverged: boolean;
  planScanCapReached: boolean;
  planEmergencyCapReached: boolean;
}

/**
 * Top-level scan strategy for plan execution.
 */
type PlanScanMode = "bounded" | "unlimited";

/**
 * Concrete scan strategy used to drive loop behavior.
 */
type PlanScanStrategy =
  | { mode: Extract<PlanScanMode, "bounded">; scanCount: number }
  | { mode: Extract<PlanScanMode, "unlimited"> };

type PlanScanCountTemplateValue = number | string;

/**
 * Internal safety ceiling for unlimited top-level plan scans.
 */
const EMERGENCY_MAX_UNLIMITED_PLAN_SCANS = 30;

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
  memoryResolver?: MemoryResolverPort;
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
  deep?: number;
  mode: RunnerMode;
  workerPattern: ParsedWorkerPattern;
  showAgentOutput: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
  verbose?: boolean;
}

const OPENCODE_CONTINUATION_ARG_PATTERN = /^--(?:continue|resume|session|thread|conversation)(?:=|$)/i;

/**
 * Creates the plan task runner that expands templates, invokes the worker, and
 * validates worker-authored TODO edits in the source Markdown document.
 */
export function createPlanTask(
  dependencies: PlanTaskDependencies,
): (options: PlanTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);
  const cliBlockExecutor = dependencies.cliBlockExecutor;

  return async function planTask(options: PlanTaskOptions): Promise<number> {
    const {
      source,
      scanCount,
      deep = 0,
      mode,
      workerPattern,
      showAgentOutput,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      trace,
      forceUnlock,
      ignoreCliBlock,
      cliBlockTimeoutMs,
      verbose = false,
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
        return EXIT_CODE_FAILURE;
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
      const rundownVarEnv = buildRundownVarEnv(extraTemplateVars);
      const templateVarsWithUserVariables: ExtraTemplateVars = {
        ...extraTemplateVars,
        userVariables: formatTemplateVarsForPrompt(extraTemplateVars),
      };

      // Read the Markdown source that will receive planner edits.
      let documentSource: string;
      try {
        documentSource = dependencies.fileSystem.readText(source);
      } catch {
        emit({
          kind: "error",
          message: "Unable to read Markdown document: " + source,
        });
        return EXIT_CODE_NO_WORK;
      }

      // Infer user intent and current TODO density to guide prompt rendering.
      const documentIntent = deriveDocumentIntent(documentSource, source);
      const existingTodoCount = parseTasks(documentSource, source).length;
      const hasExistingTodos = existingTodoCount > 0;
      const loadedWorkerConfig = dependencies.configDir?.configDir
        ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
        : undefined;
      const resolvedWorker = resolveWorkerPatternForInvocation({
        commandName: "plan",
        workerConfig: loadedWorkerConfig,
        source: documentSource,
        cliWorkerPattern: workerPattern,
        emit,
        mode,
      });
      const resolvedWorkerCommand = resolvedWorker.workerCommand;
      const resolvedWorkerPattern = resolvedWorker.workerPattern;
      emit({
        kind: "info",
        message: "Planning document: " + source,
      });
      emit({
        kind: "info",
        message: hasExistingTodos
          ? "Detected " + existingTodoCount + " "
            + pluralize(existingTodoCount, "existing TODO item", "existing TODO items")
            + " in document."
          : formatNoItemsFoundIn("existing TODO items", "document"),
      });

      // Planner execution requires a resolved worker command.
      if (resolvedWorkerCommand.length === 0) {
        emit({
          kind: "error",
          message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.",
        });
        return EXIT_CODE_FAILURE;
      }

      // Multi-scan planning must always run in clean worker sessions.
      const cleanSessionCommandError = validatePlanCleanSessionWorkerCommand(resolvedWorkerCommand);
      if (cleanSessionCommandError) {
        emit({ kind: "error", message: cleanSessionCommandError });
        return EXIT_CODE_FAILURE;
      }

      // Render the plan prompt template with the current document context.
      const planTemplate = loadProjectTemplatesFromPorts(
        dependencies.configDir,
        dependencies.templateLoader,
        dependencies.pathOperations,
      ).plan;
      const deepPlanTemplate = DEFAULT_DEEP_PLAN_TEMPLATE;

      const planPromptDocumentContext = buildPlanPromptDocumentContext(source);
      const scanStrategy = resolvePlanScanStrategy(scanCount);
      const vars: TemplateVars = {
        ...templateVarsWithUserVariables,
        ...buildMemoryTemplateVars({
          memoryMetadata: dependencies.memoryResolver?.resolve(source) ?? null,
        }),
        traceInstructions: getTraceInstructions(trace),
        task: documentIntent,
        file: source,
        context: planPromptDocumentContext,
        taskIndex: 0,
        taskLine: 1,
        source: planPromptDocumentContext,
        scanCount: resolvePlanScanCountTemplateValue(scanStrategy),
        scanMode: scanStrategy.mode,
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
            {
              ...cliExecutionOptionsWithTemplateFailureAbort,
              env: {
                ...(cliExecutionOptionsWithTemplateFailureAbort?.env ?? {}),
                ...rundownVarEnv,
              },
            },
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
            return EXIT_CODE_FAILURE;
          }
          throw error;
        }
      }

      // Print mode returns rendered scan/deep prompts without invoking workers.
      if (printPrompt) {
        emit({
          kind: "text",
          text: buildPlanScanPrompt(
            prompt,
            source,
            1,
            scanStrategy.mode === "bounded" ? scanStrategy.scanCount : undefined,
          ),
        });
        if (deep > 0) {
          const deepCandidates = collectDeepLeafCandidates(documentSource, source);
          if (deepCandidates.length === 0) {
            emit({
              kind: "info",
              message: "Deep prompt preview skipped: no leaf TODO items without children.",
            });
          } else {
            emit({
              kind: "info",
              message: "Deep prompt preview (pass 1 of " + deep + ") for " + deepCandidates.length + " "
                + pluralize(deepCandidates.length, "parent task", "parent tasks") + ".",
            });
            for (const parentTask of deepCandidates) {
              const deepPrompt = buildPlanDeepPrompt({
                deepPlanTemplate,
                parentTask,
                deepPass: 1,
                deep,
              });
              emit({ kind: "text", text: deepPrompt });
            }
            if (deep > 1) {
              emit({
                kind: "info",
                message: "Deep prompt preview includes pass 1 only. Later passes depend on worker output from earlier passes.",
              });
            }
          }
        }
        return EXIT_CODE_SUCCESS;
      }

      // Dry run reports planned execution details and exits successfully.
      if (dryRun) {
        if (dryRunSuppressesCliExpansion && !ignoreCliBlock) {
          emit({
            kind: "info",
            message: "Dry run — skipped `cli` fenced block execution; would execute "
              + promptCliBlockCount
              + " "
              + pluralize(promptCliBlockCount, "block", "blocks")
              + ".",
          });
        }
        emit({ kind: "info", message: "Dry run — would plan: " + resolvedWorkerCommand.join(" ") });
        emit({
          kind: "info",
          message: scanStrategy.mode === "bounded"
            ? "Scan count: " + scanStrategy.scanCount
            : "Scan count: unlimited",
        });
        emit({
          kind: "info",
          message: "Prompt length: " + buildPlanScanPrompt(
            prompt,
            source,
            1,
            scanStrategy.mode === "bounded" ? scanStrategy.scanCount : undefined,
          ).length + " chars",
        });
        if (deep > 0) {
          const deepCandidates = collectDeepLeafCandidates(documentSource, source);
          emit({ kind: "info", message: "Deep count: " + deep });
          if (deepCandidates.length === 0) {
            emit({
              kind: "info",
              message: "Dry run — deep passes would converge immediately: no leaf TODO items without children.",
            });
          } else {
            emit({
              kind: "info",
              message: "Dry run — would run deep pass 1 of " + deep + " for " + deepCandidates.length + " "
                + pluralize(deepCandidates.length, "parent task", "parent tasks") + ".",
            });
            const firstDeepPrompt = buildPlanDeepPrompt({
              deepPlanTemplate,
              parentTask: deepCandidates[0]!,
              deepPass: 1,
              deep,
            });
            emit({ kind: "info", message: "Deep prompt length (first parent task): " + firstDeepPrompt.length + " chars" });
            if (deep > 1) {
              emit({
                kind: "info",
                message: "Dry run — passes 2.." + deep + " depend on child TODO additions from earlier deep passes.",
              });
            }
          }
        }
        return EXIT_CODE_SUCCESS;
      }

      // Create artifact and trace context for a real planning execution.
      const artifactContext = dependencies.artifactStore.createContext({
        cwd,
        configDir: dependencies.configDir?.configDir,
        commandName: "plan",
        workerCommand: resolvedWorkerCommand,
        mode,
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
          transport: "pattern",
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
        if (verbose) {
          emit({
            kind: "info",
            message: "Running planner: " + resolvedWorkerCommand.join(" ") + " [mode=" + mode + "]",
          });
        }

        // Track mutable scan-loop state for convergence reporting and totals.
        let latestDocumentSource = documentSource;
        let insertedTotal = 0;
        let scansExecuted = 0;
        let convergenceOutcome: PlanConvergenceOutcome | null = null;
        let planSuccessCount = 0;
        let planFailureCount = 0;

        const emitPlanSummary = (): void => {
          emit({
            kind: "info",
            message: formatSuccessFailureSummary("Plan operation", planSuccessCount, planFailureCount),
          });
        };

        // Execute scans until convergence, while honoring bounded scan caps when configured.
        let scanIndex = 1;
        while (shouldContinuePlanScans(scanIndex, scanStrategy, convergenceOutcome)) {
          if (scanStrategy.mode === "unlimited" && scanIndex > EMERGENCY_MAX_UNLIMITED_PLAN_SCANS) {
            convergenceOutcome = "emergency-cap-reached";
            emit({
              kind: "warn",
              message: "Emergency scan ceiling reached: planner stopped after "
                + EMERGENCY_MAX_UNLIMITED_PLAN_SCANS
                + " unlimited scans to prevent a runaway loop. This is a non-fatal safety stop; using current plan output.",
            });
            break;
          }

          const scanLabel = buildPlanScanLabel(scanIndex, scanStrategy);
          const scanBaseline = latestDocumentSource;
          const scanCounter = buildPlanScanCounter(scanIndex, scanStrategy);

          emit({
            kind: "group-start",
            label: "Plan scan " + scanLabel,
            counter: scanCounter,
          });

          const emitScanFailure = (message: string): void => {
            planFailureCount += 1;
            emit({ kind: "group-end", status: "failure", message });
          };

          try {
            if (verbose) {
              emit({
                kind: "info",
                message: "Planning " + scanLabel + ".",
              });
            }
            scansExecuted += 1;

            // Build per-scan prompt context and execute the planner worker.
            const scanPrompt = buildPlanScanPrompt(
              prompt,
              source,
              scanIndex,
              scanStrategy.mode === "bounded" ? scanStrategy.scanCount : undefined,
            );
            if (verbose) {
              emit({
                kind: "info",
                message: "Executing planner " + scanLabel + "...",
              });
            }
            const planPhaseTrace = beginPlanPhaseTrace(resolvedWorkerCommand);
            const runResult = await dependencies.workerExecutor.runWorker({
              workerPattern: resolvedWorkerPattern,
              prompt: scanPrompt,
              mode,
              trace,
              cwd,
              env: rundownVarEnv,
              configDir: dependencies.configDir?.configDir,
              artifactContext,
              artifactPhase: "plan",
              artifactPhaseLabel: buildPlanScanPhaseLabel(scanIndex, scanStrategy),
              artifactExtra: {
                scanIndex,
                scanCount: scanStrategy.mode === "bounded" ? scanStrategy.scanCount : null,
                scanMode: scanStrategy.mode,
                scanLabel,
              },
            });
            if (verbose) {
              emit({
                kind: "info",
                message: "Planner " + scanLabel + " completed (exit "
                  + (runResult.exitCode === null ? "null" : String(runResult.exitCode))
                  + ").",
              });
            }
            completePlanPhaseTrace(
              planPhaseTrace,
              runResult.exitCode,
              runResult.stdout,
              runResult.stderr,
              mode === "wait",
            );

            // Forward worker stderr in wait mode only when explicitly enabled.
            if (mode === "wait" && showAgentOutput && runResult.stderr) {
              emit({ kind: "stderr", text: runResult.stderr });
            }

            // Non-zero exits fail the planning run for this task.
            if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
              const message = "Planner worker exited with code " + runResult.exitCode + " during scan " + scanIndex + ".";
              emit({ kind: "error", message });
              emitScanFailure(message);
              emitPlanSummary();
              return finishPlan(EXIT_CODE_FAILURE, "execution-failed");
            }

            let editedDocumentSource: string;
            try {
              editedDocumentSource = dependencies.fileSystem.readText(source);
            } catch {
              const message = "Unable to read Markdown document after scan " + scanIndex + ": " + source;
              emit({
                kind: "error",
                message,
              });
              emitScanFailure(message);
              emitPlanSummary();
              return finishPlan(EXIT_CODE_FAILURE, "failed");
            }

            const validationResult = validatePlanEdit(scanBaseline, editedDocumentSource);
            if (!validationResult.valid) {
              dependencies.fileSystem.writeText(source, scanBaseline);
              const message = validationResult.rejectionReason
                ?? "Planner edit was rejected because checked TODO items were modified.";
              emit({
                kind: "error",
                message,
              });
              emitScanFailure(message);
              emitPlanSummary();
              return finishPlan(EXIT_CODE_FAILURE, "failed");
            }

            if (editedDocumentSource === scanBaseline) {
              convergenceOutcome = "converged-no-change";
              if (scanIndex === 1) {
                emit({ kind: "warn", message: "Planner made no file edits. No TODO items added." });
              } else {
                emit({ kind: "info", message: "Planner converged at scan " + scanIndex + ": file unchanged after worker edit." });
              }
              planSuccessCount += 1;
              emit({ kind: "group-end", status: "success" });
              continue;
            }

            if (validationResult.stats.added === 0) {
              convergenceOutcome = "converged-no-additions";
              latestDocumentSource = editedDocumentSource;
              emit({ kind: "info", message: "Planner converged at scan " + scanIndex + ": edit added no new TODO items." });
              planSuccessCount += 1;
              emit({ kind: "group-end", status: "success" });
              continue;
            }

            latestDocumentSource = editedDocumentSource;
            insertedTotal += validationResult.stats.added;
            planSuccessCount += 1;
            emit({ kind: "group-end", status: "success" });
            scanIndex += 1;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            emit({ kind: "error", message });
            emitScanFailure(message);
            emitPlanSummary();
            throw error;
          }
        }

        // Execute additional deep passes to generate nested child TODO items.
        if (deep > 0) {
          for (let deepPass = 1; deepPass <= deep; deepPass += 1) {
            try {
              latestDocumentSource = dependencies.fileSystem.readText(source);
            } catch {
              emit({
                kind: "error",
                message: "Unable to reload Markdown document before deep pass " + deepPass + ": " + source,
              });
              emitPlanSummary();
              return finishPlan(EXIT_CODE_FAILURE, "failed");
            }

            const deepCandidates = collectDeepLeafCandidates(latestDocumentSource, source);

            if (deepCandidates.length === 0) {
              emit({
                kind: "info",
                message: "Deep planning converged at pass " + deepPass + ": no leaf TODO items without children.",
              });
              break;
            }

            if (verbose) {
              emit({
                kind: "info",
                message: "Running deep pass " + deepPass + " of " + deep + " for " + deepCandidates.length + " "
                  + pluralize(deepCandidates.length, "parent task", "parent tasks") + ".",
              });
            }

            let deepPassInsertedCount = 0;

            for (let deepTaskIndex = 0; deepTaskIndex < deepCandidates.length; deepTaskIndex += 1) {
              const parentTask = deepCandidates[deepTaskIndex]!;
              const deepTaskLabel = buildPlanDeepTaskLabel(deepPass, deep, deepTaskIndex + 1, deepCandidates.length);
              const deepPrompt = buildPlanDeepPrompt({
                deepPlanTemplate,
                parentTask,
                deepPass,
                deep,
              });

              if (verbose) {
                emit({
                  kind: "info",
                  message: "Executing planner " + deepTaskLabel + " for parent line " + parentTask.line + "...",
                });
              }

              const planPhaseTrace = beginPlanPhaseTrace(resolvedWorkerCommand);
              const runResult = await dependencies.workerExecutor.runWorker({
                workerPattern: resolvedWorkerPattern,
                prompt: deepPrompt,
                mode,
                trace,
                cwd,
                env: rundownVarEnv,
                configDir: dependencies.configDir?.configDir,
                artifactContext,
                artifactPhase: "plan",
                artifactPhaseLabel: buildPlanDeepPhaseLabel(deepPass, deepTaskIndex + 1),
                artifactExtra: {
                  deepPass,
                  deepCount: deep,
                  deep,
                  deepTaskIndex: deepTaskIndex + 1,
                  deepTaskCount: deepCandidates.length,
                  parentTaskLine: parentTask.line,
                  parentTaskDepth: parentTask.depth,
                  deepTaskLabel,
                },
              });
              completePlanPhaseTrace(
                planPhaseTrace,
                runResult.exitCode,
                runResult.stdout,
                runResult.stderr,
                mode === "wait",
              );

              if (mode === "wait" && showAgentOutput && runResult.stderr) {
                emit({ kind: "stderr", text: runResult.stderr });
              }

              if (runResult.exitCode !== 0 && runResult.exitCode !== null) {
                emit({
                  kind: "error",
                  message: "Planner worker exited with code " + runResult.exitCode + " during deep pass " + deepPass + ", task " + (deepTaskIndex + 1) + ".",
                });
                planFailureCount += 1;
                emitPlanSummary();
                return finishPlan(EXIT_CODE_FAILURE, "execution-failed");
              }

              let deepEditedDocumentSource: string;
              try {
                deepEditedDocumentSource = dependencies.fileSystem.readText(source);
              } catch {
                emit({
                  kind: "error",
                  message: "Unable to read Markdown document after deep pass " + deepPass + ", task " + (deepTaskIndex + 1) + ": " + source,
                });
                planFailureCount += 1;
                emitPlanSummary();
                return finishPlan(EXIT_CODE_FAILURE, "failed");
              }

              const validationResult = validatePlanEdit(latestDocumentSource, deepEditedDocumentSource);
              if (!validationResult.valid) {
                dependencies.fileSystem.writeText(source, latestDocumentSource);
                emit({
                  kind: "error",
                  message: validationResult.rejectionReason
                    ?? "Planner edit was rejected because checked TODO items were modified.",
                });
                planFailureCount += 1;
                emitPlanSummary();
                return finishPlan(EXIT_CODE_FAILURE, "failed");
              }

              planSuccessCount += 1;

              if (deepEditedDocumentSource === latestDocumentSource) {
                continue;
              }

              latestDocumentSource = deepEditedDocumentSource;
              insertedTotal += validationResult.stats.added;
              deepPassInsertedCount += validationResult.stats.added;
            }

            if (deepPassInsertedCount === 0) {
              emit({
                kind: "info",
                message: "Deep planning converged at pass " + deepPass + ": no child TODO items were added.",
              });
              break;
            }
          }
        }

        // Hitting the scan cap without convergence is tracked explicitly.
        if (scansExecuted > 0 && convergenceOutcome === null && scanStrategy.mode === "bounded") {
          convergenceOutcome = "scan-cap-reached";
        }

        const convergenceMetadata = convergenceOutcome
          ? buildPlanConvergenceMetadata(scanStrategy, scansExecuted, convergenceOutcome)
          : undefined;

        if (convergenceOutcome) {
          emit({
            kind: "info",
            message: formatPlanStopReason(convergenceOutcome),
          });
        }

        emitPlanSummary();

        // Return success when no insertions are needed after all scans.
        if (insertedTotal === 0) {
          return finishPlan(EXIT_CODE_SUCCESS, "completed", convergenceMetadata);
        }

        emit({
          kind: "success",
          message: "Inserted " + insertedTotal + " "
            + pluralize(insertedTotal, "TODO item", "TODO items")
            + " into: " + source,
        });
        return finishPlan(EXIT_CODE_SUCCESS, "completed", convergenceMetadata);
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
 * Builds structured convergence metadata for artifact finalization.
 */
function buildPlanConvergenceMetadata(
  scanStrategy: PlanScanStrategy,
  scansExecuted: number,
  convergenceOutcome: PlanConvergenceOutcome,
): PlanConvergenceMetadata {
  return {
    planScanMode: scanStrategy.mode,
    planScanCount: scanStrategy.mode === "bounded" ? scanStrategy.scanCount : null,
    planScansExecuted: scansExecuted,
    planConvergenceReason: convergenceOutcome,
    planConvergenceOutcome: convergenceOutcome,
    planConverged: convergenceOutcome === "converged-no-change"
      || convergenceOutcome === "converged-no-additions",
    planScanCapReached: convergenceOutcome === "scan-cap-reached",
    planEmergencyCapReached: convergenceOutcome === "emergency-cap-reached",
  };
}

/**
 * Builds a user-facing summary line for top-level plan stop reason.
 */
function formatPlanStopReason(convergenceOutcome: PlanConvergenceOutcome): string {
  return "Plan stop reason: " + convergenceOutcome + ".";
}

/**
 * Resolves bounded vs unlimited scan behavior from the provided option.
 */
function resolvePlanScanStrategy(scanCount: number | undefined): PlanScanStrategy {
  if (scanCount === undefined) {
    return { mode: "unlimited" };
  }

  return { mode: "bounded", scanCount };
}

/**
 * Returns a stable `scanCount` template value for bounded and unlimited modes.
 */
function resolvePlanScanCountTemplateValue(scanStrategy: PlanScanStrategy): PlanScanCountTemplateValue {
  if (scanStrategy.mode === "bounded") {
    return scanStrategy.scanCount;
  }

  return `unlimited (emergency cap: ${EMERGENCY_MAX_UNLIMITED_PLAN_SCANS})`;
}

/**
 * Returns true while top-level planning scans should continue running.
 */
function shouldContinuePlanScans(
  scanIndex: number,
  scanStrategy: PlanScanStrategy,
  convergenceOutcome: PlanConvergenceOutcome | null,
): boolean {
  if (convergenceOutcome !== null) {
    return false;
  }

  if (scanStrategy.mode === "unlimited") {
    return true;
  }

  return scanIndex <= scanStrategy.scanCount;
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
 * Builds the per-scan worker prompt with clean-session guidance.
 */
function buildPlanScanPrompt(
  basePrompt: string,
  sourcePath: string,
  scanIndex: number,
  scanCount: number | undefined,
): string {
  const scanStrategy = resolvePlanScanStrategy(scanCount);
  const scanLabel = buildPlanScanLabel(scanIndex, scanStrategy);
  const scanContextLine = scanStrategy.mode === "bounded"
    ? `Scan pass ${scanIndex} of ${scanStrategy.scanCount}.`
    : `Scan pass ${scanIndex} (unlimited mode; total pass count is unknown).`;

  return `${basePrompt}\n\n## Scan Context\n\nScan label: ${scanLabel}\n${scanContextLine}\n\nTreat this scan as a clean standalone worker session. Do not rely on prior prompt history or prior scan outputs.\n\nEdit the source file directly at: ${sourcePath}\n\nAvoid cosmetic rewrites (including reordering, reformatting, or wording-only changes). Only edit when adding genuinely missing actionable TODO items.\n\nIf plan coverage is already sufficient, leave the file unchanged. If no useful TODO edits are needed, leave the file unchanged.`;
}

/**
 * Provides plan-template context without embedding full document content.
 */
function buildPlanPromptDocumentContext(sourcePath: string): string {
  return `Document source is intentionally omitted for plan scans. Read and edit the file directly at: ${sourcePath}`;
}

/**
 * Builds a stable scan label used in messages and trace metadata.
 */
function buildPlanScanLabel(scanIndex: number, scanStrategy: PlanScanStrategy): string {
  if (scanStrategy.mode === "unlimited") {
    const width = Math.max(2, String(scanIndex).length);
    const indexLabel = String(scanIndex).padStart(width, "0");
    return `plan-scan-${indexLabel}`;
  }

  const width = Math.max(2, String(scanStrategy.scanCount).length);
  const indexLabel = String(scanIndex).padStart(width, "0");
  const countLabel = String(scanStrategy.scanCount).padStart(width, "0");
  return `plan-scan-${indexLabel}-of-${countLabel}`;
}

/**
 * Builds the artifact phase label for a specific scan index.
 */
function buildPlanScanPhaseLabel(scanIndex: number, scanStrategy: PlanScanStrategy): string {
  const width = scanStrategy.mode === "bounded"
    ? Math.max(2, String(scanStrategy.scanCount).length)
    : Math.max(2, String(scanIndex).length);
  const indexLabel = String(scanIndex).padStart(width, "0");
  return `plan-scan-${indexLabel}`;
}

/**
 * Builds an optional progress counter for plan scan groups.
 */
function buildPlanScanCounter(
  scanIndex: number,
  scanStrategy: PlanScanStrategy,
): { current: number; total: number } | undefined {
  if (scanStrategy.mode === "unlimited") {
    return undefined;
  }

  return {
    current: scanIndex,
    total: scanStrategy.scanCount,
  };
}

/**
 * Builds a stable deep-task label for per-parent nested planning runs.
 */
function buildPlanDeepTaskLabel(
  deepPass: number,
  deepCount: number,
  taskIndex: number,
  taskCount: number,
): string {
  const passWidth = Math.max(2, String(deepCount).length);
  const taskWidth = Math.max(2, String(taskCount).length);
  const passLabel = String(deepPass).padStart(passWidth, "0");
  const countLabel = String(deepCount).padStart(passWidth, "0");
  const taskLabel = String(taskIndex).padStart(taskWidth, "0");
  const taskCountLabel = String(taskCount).padStart(taskWidth, "0");
  return `plan-deep-${passLabel}-of-${countLabel}-task-${taskLabel}-of-${taskCountLabel}`;
}

/**
 * Builds artifact phase labels for deep per-parent planning runs.
 */
function buildPlanDeepPhaseLabel(deepPass: number, taskIndex: number): string {
  const passLabel = String(deepPass).padStart(2, "0");
  const taskLabel = String(taskIndex).padStart(3, "0");
  return `plan-deep-${passLabel}-task-${taskLabel}`;
}

/**
 * Builds the per-parent deep planning prompt.
 */
function buildPlanDeepPrompt(options: {
  deepPlanTemplate: string;
  parentTask: ReturnType<typeof parseTasks>[number];
  deepPass: number;
  deep: number;
}): string {
  const deepVars: TemplateVars = {
    traceInstructions: "",
    task: options.parentTask.text,
    file: options.parentTask.file,
    context: buildPlanPromptDocumentContext(options.parentTask.file),
    taskIndex: options.parentTask.index,
    taskLine: options.parentTask.line,
    source: buildPlanPromptDocumentContext(options.parentTask.file),
    parentTask: options.parentTask.text,
    parentTaskLine: options.parentTask.line,
    parentTaskDepth: options.parentTask.depth,
  };

  const renderedTemplate = renderTemplate(options.deepPlanTemplate, deepVars);
  return `${renderedTemplate}\n\n## Deep Pass Context\n\nDeep pass ${options.deepPass} of ${options.deep}.\n\nTreat this deep pass as a clean standalone worker session. Do not rely on prior prompt history or prior deep-pass outputs.\n\nEdit the source file directly at: ${options.parentTask.file}\n\nIf no useful child TODO edits are needed for the selected parent task, leave the file unchanged.`;
}

/**
 * Collects unchecked leaf tasks that can receive deep child TODO insertions.
 */
function collectDeepLeafCandidates(markdownSource: string, sourcePath: string): ReturnType<typeof parseTasks> {
  return parseTasks(markdownSource, sourcePath)
    .filter((task) => !task.checked && task.children.length === 0)
    .sort((left, right) => right.line - left.line);
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
