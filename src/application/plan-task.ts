import {
  DEFAULT_DEEP_PLAN_TEMPLATE,
  getTraceInstructions,
} from "../domain/defaults.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { parseTasks } from "../domain/parser.js";
import {
  relocateInsertedTodosToEnd,
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
  resolvePredictionWorkspaceDirectories,
  resolvePredictionWorkspacePaths,
  resolvePredictionWorkspacePlacement,
} from "./prediction-workspace-paths.js";
import {
  buildWorkspaceContextTemplateVars,
  mergeTemplateVarsWithWorkspaceContext,
  resolveRuntimeWorkspaceContext,
} from "./runtime-workspace-context.js";
import {
  countTraceLines,
  formatSuccessFailureSummary,
  pluralize,
} from "./run-task-utils.js";
import { msg, type LocaleMessages } from "../domain/locale.js";
import {
  createOutputVolumeEvent,
  createPhaseCompletedEvent,
  createPhaseStartedEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  type RunCompletedPayload,
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
  | "converged-diminishing"
  | "converged-rewrite-only"
  | "max-items-reached"
  | "scan-cap-reached"
  | "emergency-cap-reached";

/**
 * Structured convergence metadata persisted with plan artifacts.
 */
interface PlanConvergenceMetadata extends Record<string, unknown> {
  planScanMode: PlanScanMode;
  planScanCount: number | null;
  planMaxItems: number | null;
  planScansExecuted: number;
  planConvergenceReason: PlanConvergenceOutcome;
  planConvergenceOutcome: PlanConvergenceOutcome;
  planConverged: boolean;
  planMaxItemsReached: boolean;
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
const EMERGENCY_MAX_UNLIMITED_PLAN_SCANS = 15;

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
  localeMessages?: LocaleMessages;
  output: ApplicationOutputPort;
}

/**
 * Runtime options accepted by a single `plan` command invocation.
 */
export interface PlanTaskOptions {
  source: string;
  cwd?: string;
  invocationDir?: string;
  workspaceDir?: string;
  workspaceLinkPath?: string;
  isLinkedWorkspace?: boolean;
  scanCount?: number;
  maxItems?: number;
  deep?: number;
  loop?: boolean;
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
  const localeMessages = dependencies.localeMessages ?? {};
  const cliBlockExecutor = dependencies.cliBlockExecutor;

  return async function planTask(options: PlanTaskOptions): Promise<number> {
    const {
      source,
      scanCount,
      maxItems,
      deep = 0,
      loop = false,
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
      invocationDir,
      workspaceDir,
      workspaceLinkPath,
      isLinkedWorkspace,
    } = options;
    const executionCwd = options.cwd ?? dependencies.workingDirectory.cwd();
    const runtimeWorkspaceContext = resolveRuntimeWorkspaceContext(
      {
        executionCwd,
        invocationDir,
        workspaceDir,
        workspaceLinkPath,
        isLinkedWorkspace,
      },
      dependencies.pathOperations,
    );
    const workspaceDirectories = resolvePredictionWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
    });
    const workspacePlacement = resolvePredictionWorkspacePlacement({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
    });
    const workspacePaths = resolvePredictionWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
      invocationRoot: runtimeWorkspaceContext.invocationDir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });
    const workspaceContextTemplateVars = buildWorkspaceContextTemplateVars(
      runtimeWorkspaceContext,
      {
        directories: workspaceDirectories,
        placement: workspacePlacement,
        paths: workspacePaths,
      },
    );
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
        emit({ kind: "info", message: msg("plan.force-unlocked", { source }, localeMessages) });
      }
    }

    // Acquire an exclusive lock so concurrent runs cannot modify the same source.
    try {
      dependencies.fileLock.acquire(source, { command: "plan" });
    } catch (error) {
      if (error instanceof FileLockError) {
        emit({
          kind: "error",
          message: msg("plan.lock-error", {
            source: error.filePath,
            pid: String(error.holder.pid),
            command: error.holder.command,
            startTime: error.holder.startTime,
          }, localeMessages),
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
      const cwd = executionCwd;
      const fileTemplateVars = varsFilePath
        ? dependencies.templateVarsLoader.load(
          varsFilePath,
          cwd,
          dependencies.configDir?.configDir,
        )
        : {};
      const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs);
      const extraTemplateVars: ExtraTemplateVars = mergeTemplateVarsWithWorkspaceContext(
        fileTemplateVars,
        cliTemplateVars,
        workspaceContextTemplateVars,
      );
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
          message: msg("plan.read-error", { source }, localeMessages),
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
      const workerTimeoutMs = loadedWorkerConfig?.workerTimeoutMs;
      emit({
        kind: "info",
        message: msg("plan.planning-document", { source }, localeMessages),
      });
      emit({
        kind: "info",
        message: hasExistingTodos
          ? msg("plan.detected-todos", { count: String(existingTodoCount) }, localeMessages)
          : msg("plan.no-todos", {}, localeMessages),
      });

      // Planner execution requires a resolved worker command.
      if (resolvedWorkerCommand.length === 0) {
        emit({
          kind: "error",
          message: msg("plan.no-worker", {}, localeMessages),
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
      const templates = loadProjectTemplatesFromPorts(
        dependencies.configDir,
        dependencies.templateLoader,
        dependencies.pathOperations,
      );
      const planTemplateFileName = loop ? "plan-loop.md" : "plan.md";
      const planTemplate = loop ? templates.planLoop : templates.plan;
      const selectedPlanTemplatePath = dependencies.configDir
        ? dependencies.pathOperations.join(dependencies.configDir.configDir, planTemplateFileName)
        : undefined;
      const deepPlanTemplate = templates.deepPlan ?? DEFAULT_DEEP_PLAN_TEMPLATE;
      const planPrependGuidance = loadOptionalPlannerGuidance({
        configDir: dependencies.configDir,
        fileSystem: dependencies.fileSystem,
        pathOperations: dependencies.pathOperations,
        templateLoader: dependencies.templateLoader,
        fileName: "plan-prepend.md",
      });
      const planAppendGuidance = loadOptionalPlannerGuidance({
        configDir: dependencies.configDir,
        fileSystem: dependencies.fileSystem,
        pathOperations: dependencies.pathOperations,
        templateLoader: dependencies.templateLoader,
        fileName: "plan-append.md",
      });

      const planPromptDocumentContext = buildPlanPromptDocumentContext(source);
      const scanStrategy = resolvePlanScanStrategy(scanCount);
      const initialInsertedTotal = 0;
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
        maxItems,
        insertedTotal: initialInsertedTotal,
        existingTodoCount,
        hasExistingTodos: hasExistingTodos ? "true" : "false",
        planPrependGuidance,
        planAppendGuidance,
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
        emitPlanPromptSelectionInfo({
          emit,
          loop,
          selectedTemplatePath: selectedPlanTemplatePath,
          dryRun: false,
          localeMessages,
        });
        emit({
          kind: "text",
          text: buildPlanScanPrompt(
            prompt,
            source,
            1,
            scanStrategy.mode === "bounded" ? scanStrategy.scanCount : undefined,
            maxItems,
            initialInsertedTotal,
          ),
        });
        if (deep > 0) {
          const deepCandidates = collectDeepLeafCandidates(documentSource, source);
          if (deepCandidates.length === 0) {
            emit({
              kind: "info",
              message: msg("plan.deep-no-leaves-preview", {}, localeMessages),
            });
          } else {
            emit({
              kind: "info",
              message: msg(
                "plan.deep-preview-pass",
                { total: String(deep), count: String(deepCandidates.length) },
                localeMessages,
              ),
            });
            for (const parentTask of deepCandidates) {
              const deepPrompt = buildPlanDeepPrompt({
                deepPlanTemplate,
                parentTask,
                deepPass: 1,
                deep,
                maxItems,
                insertedTotal: initialInsertedTotal,
                planPrependGuidance,
                planAppendGuidance,
              });
              emit({ kind: "text", text: deepPrompt });
            }
            if (deep > 1) {
              emit({
                kind: "info",
                message: msg("plan.deep-preview-pass-note", {}, localeMessages),
              });
            }
          }
        }
        return EXIT_CODE_SUCCESS;
      }

      // Dry run reports planned execution details and exits successfully.
      if (dryRun) {
        emitPlanPromptSelectionInfo({
          emit,
          loop,
          selectedTemplatePath: selectedPlanTemplatePath,
          dryRun: true,
          localeMessages,
        });
        if (dryRunSuppressesCliExpansion && !ignoreCliBlock) {
          emit({
            kind: "info",
            message: msg("plan.dry-run-cli-skipped", { count: String(promptCliBlockCount) }, localeMessages),
          });
        }
        emit({
          kind: "info",
          message: msg("plan.dry-run-would-plan", { command: resolvedWorkerCommand.join(" ") }, localeMessages),
        });
        emit({
          kind: "info",
          message: scanStrategy.mode === "bounded"
            ? msg("plan.scan-count", { count: String(scanStrategy.scanCount) }, localeMessages)
            : msg("plan.scan-count-unlimited", {}, localeMessages),
        });
        if (maxItems !== undefined) {
          emit({
            kind: "info",
            message: msg("plan.max-items", { maxItems: String(maxItems) }, localeMessages),
          });
        }
        emit({
          kind: "info",
          message: msg(
            "plan.prompt-length",
            {
              length: String(buildPlanScanPrompt(
                prompt,
                source,
                1,
                scanStrategy.mode === "bounded" ? scanStrategy.scanCount : undefined,
                maxItems,
                initialInsertedTotal,
              ).length),
            },
            localeMessages,
          ),
        });
        if (deep > 0) {
          const deepCandidates = collectDeepLeafCandidates(documentSource, source);
          emit({ kind: "info", message: msg("plan.deep-count", { count: String(deep) }, localeMessages) });
          if (deepCandidates.length === 0) {
            emit({
              kind: "info",
              message: msg("plan.dry-run-deep-no-leaves", {}, localeMessages),
            });
          } else {
            emit({
              kind: "info",
              message: msg(
                "plan.dry-run-deep-would-run",
                { total: String(deep), count: String(deepCandidates.length) },
                localeMessages,
              ),
            });
            const firstDeepPrompt = buildPlanDeepPrompt({
              deepPlanTemplate,
              parentTask: deepCandidates[0]!,
              deepPass: 1,
              deep,
              maxItems,
              insertedTotal: initialInsertedTotal,
              planPrependGuidance,
              planAppendGuidance,
            });
            emit({
              kind: "info",
              message: msg("plan.deep-prompt-length", { length: String(firstDeepPrompt.length) }, localeMessages),
            });
            if (deep > 1) {
              emit({
                kind: "info",
                message: msg("plan.dry-run-deep-passes-note", { total: String(deep) }, localeMessages),
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
      const completeTraceRun = (status: ArtifactStoreStatus, extra?: Record<string, unknown>): void => {
        if (traceCompleted) {
          return;
        }

        const payload: RunCompletedPayload = {
          status: toTraceStatus(status),
          total_duration_ms: Math.max(0, Date.now() - traceStartedAtMs),
          total_phases: tracePhaseCount,
        };

        const planConvergenceOutcome = extra?.planConvergenceOutcome;
        if (isPlanConvergenceOutcome(planConvergenceOutcome)
          && planConvergenceOutcome !== "converged-rewrite-only") {
          payload.plan_convergence_outcome = planConvergenceOutcome;
          payload.plan_converged = planConvergenceOutcome === "converged-no-change"
            || planConvergenceOutcome === "converged-no-additions"
            || planConvergenceOutcome === "converged-diminishing";
          payload.plan_max_items_reached = planConvergenceOutcome === "max-items-reached";
          payload.plan_scan_cap_reached = planConvergenceOutcome === "scan-cap-reached";
          payload.plan_emergency_cap_reached = planConvergenceOutcome === "emergency-cap-reached";
        }

        traceWriter.write(createRunCompletedEvent({
          timestamp: nowIso(),
          run_id: artifactContext.runId,
          payload,
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
        completeTraceRun(status, extra);
        traceWriter.flush();
        finalizePlanArtifacts(
          dependencies.artifactStore,
          artifactContext,
          keepArtifacts,
          artifactStatus,
          emit,
          localeMessages,
          extra,
        );
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
        let consecutiveLowAdditionScans = 0;
        let scansExecuted = 0;
        let convergenceOutcome: PlanConvergenceOutcome | null = null;
        let planSuccessCount = 0;
        let planFailureCount = 0;

        const recordInsertedTodoCount = (addedCount: number): void => {
          if (addedCount <= 0) {
            return;
          }

          insertedTotal += addedCount;
        };

        const emitPlanSummary = (summaryConvergenceOutcome?: PlanConvergenceOutcome | null): void => {
          const maxItemsSummarySuffix = summaryConvergenceOutcome === "max-items-reached"
            ? " Planning stopped because --max-items limit was reached."
            : "";
          emit({
            kind: "info",
            message: formatSuccessFailureSummary("Plan operation", planSuccessCount, planFailureCount)
              + maxItemsSummarySuffix,
          });
        };

        // Execute scans until convergence, while honoring bounded scan caps when configured.
        let scanIndex = 1;
        while (shouldContinuePlanScans(scanIndex, scanStrategy, convergenceOutcome)) {
          if (scanStrategy.mode === "unlimited" && scanIndex > EMERGENCY_MAX_UNLIMITED_PLAN_SCANS) {
            convergenceOutcome = "emergency-cap-reached";
            emit({
              kind: "warn",
              message: msg(
                "plan.emergency-ceiling",
                { count: String(EMERGENCY_MAX_UNLIMITED_PLAN_SCANS) },
                localeMessages,
              ),
            });
            break;
          }

          if (maxItems !== undefined && insertedTotal >= maxItems) {
            convergenceOutcome = "max-items-reached";
            emit({
              kind: "info",
              message: msg(
                "plan.scan-stop-max-items",
                {
                  scan: String(scanIndex),
                  added: String(insertedTotal),
                  max: String(maxItems),
                },
                localeMessages,
              ),
            });
            break;
          }

          const scanLabel = buildPlanScanLabel(scanIndex, scanStrategy);
          const scanBaseline = latestDocumentSource;
          const scanCounter = buildPlanScanCounter(scanIndex, scanStrategy);

          emit({
            kind: "group-start",
            label: msg("plan.scan-group-label", { label: scanLabel }, localeMessages),
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
                message: msg("plan.scan-started-verbose", { label: scanLabel }, localeMessages),
              });
            }
            scansExecuted += 1;

            // Build per-scan prompt context and execute the planner worker.
            const scanPrompt = buildPlanScanPrompt(
              prompt,
              source,
              scanIndex,
              scanStrategy.mode === "bounded" ? scanStrategy.scanCount : undefined,
              maxItems,
              insertedTotal,
            );
            if (verbose) {
              emit({
                kind: "info",
                message: msg("plan.scan-executing-verbose", { label: scanLabel }, localeMessages),
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
              timeoutMs: workerTimeoutMs,
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
                message: msg(
                  "plan.scan-completed-verbose",
                  { label: scanLabel, code: runResult.exitCode === null ? "null" : String(runResult.exitCode) },
                  localeMessages,
                ),
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
              const message = msg(
                "plan.scan-exit-error",
                { code: String(runResult.exitCode), scan: String(scanIndex) },
                localeMessages,
              );
              emit({ kind: "error", message });
              emitScanFailure(message);
              emitPlanSummary();
              return finishPlan(EXIT_CODE_FAILURE, "execution-failed");
            }

            let editedDocumentSource: string;
            try {
              editedDocumentSource = dependencies.fileSystem.readText(source);
            } catch {
              const message = msg(
                "plan.scan-read-error",
                { scan: String(scanIndex), source },
                localeMessages,
              );
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

            // Relocate newly inserted TODO items that the planner placed between
            // existing items to the end of the document. Each task only sees
            // content above it, so end-placement maximizes context visibility.
            const relocatedSource = relocateInsertedTodosToEnd(scanBaseline, editedDocumentSource);
            if (relocatedSource !== editedDocumentSource) {
              editedDocumentSource = relocatedSource;
              dependencies.fileSystem.writeText(source, editedDocumentSource);
            }

            if (editedDocumentSource === scanBaseline) {
              convergenceOutcome = "converged-no-change";
              if (scanIndex === 1) {
                emit({ kind: "warn", message: msg("plan.no-edits", {}, localeMessages) });
              } else {
                emit({
                  kind: "info",
                  message: msg("plan.scan-unchanged", { scan: String(scanIndex) }, localeMessages),
                });
              }
              planSuccessCount += 1;
              emit({ kind: "group-end", status: "success" });
              continue;
            }

            const netAdditions = validationResult.stats.added - validationResult.stats.removed;

            // Accept edits that only fix prefixes (symmetric add/remove with
            // no reordering, e.g. `check:` → `verify:`).  These show up as
            // equal adds and removes in the stats.
            const isPrefixFixOnly = validationResult.stats.added > 0
              && validationResult.stats.added === validationResult.stats.removed
              && validationResult.stats.reordered === 0
              && netAdditions === 0;

            if ((validationResult.stats.removed > 0 || validationResult.stats.reordered > 0) && netAdditions <= 0 && !isPrefixFixOnly) {
              dependencies.fileSystem.writeText(source, scanBaseline);
              latestDocumentSource = scanBaseline;
              convergenceOutcome = "converged-rewrite-only";
              emit({
                kind: "warn",
                message: msg("plan.scan-rewrite-reverted", { scan: String(scanIndex) }, localeMessages),
              });
              planSuccessCount += 1;
              emit({ kind: "group-end", status: "success" });
              continue;
            }

            if (netAdditions <= 0) {
              convergenceOutcome = "converged-no-additions";
              latestDocumentSource = editedDocumentSource;
              emit({
                kind: "info",
                message: msg("plan.scan-no-new-items", { scan: String(scanIndex) }, localeMessages),
              });
              planSuccessCount += 1;
              emit({ kind: "group-end", status: "success" });
              continue;
            }

            latestDocumentSource = editedDocumentSource;
            recordInsertedTodoCount(validationResult.stats.added);
            if (netAdditions <= 1) {
              consecutiveLowAdditionScans += 1;
            } else {
              consecutiveLowAdditionScans = 0;
            }
            planSuccessCount += 1;
            emit({ kind: "group-end", status: "success" });

            if (consecutiveLowAdditionScans >= 2) {
              convergenceOutcome = "converged-diminishing";
              emit({
                kind: "info",
                message: msg("plan.scan-diminishing-returns", { scan: String(scanIndex) }, localeMessages),
              });
              break;
            }

            if (maxItems !== undefined && insertedTotal >= maxItems) {
              convergenceOutcome = "max-items-reached";
              emit({
                kind: "info",
                message: msg(
                  "plan.scan-stopped-max-items",
                  {
                    scan: String(scanIndex),
                    added: String(insertedTotal),
                    max: String(maxItems),
                  },
                  localeMessages,
                ),
              });
              break;
            }

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
        if (deep > 0 && (maxItems === undefined || insertedTotal < maxItems)) {
          let maxItemsReachedDuringDeep = false;
          for (let deepPass = 1; deepPass <= deep; deepPass += 1) {
            try {
              latestDocumentSource = dependencies.fileSystem.readText(source);
            } catch {
              emit({
                kind: "error",
                message: msg(
                  "plan.deep-reload-error",
                  { pass: String(deepPass), source },
                  localeMessages,
                ),
              });
              emitPlanSummary();
              return finishPlan(EXIT_CODE_FAILURE, "failed");
            }

            const deepCandidates = collectDeepLeafCandidates(latestDocumentSource, source);

            if (deepCandidates.length === 0) {
              emit({
                kind: "info",
                message: msg("plan.deep-converged-no-leaves", { pass: String(deepPass) }, localeMessages),
              });
              break;
            }

            if (verbose) {
              emit({
                kind: "info",
                message: msg(
                  "plan.deep-running-verbose",
                  {
                    pass: String(deepPass),
                    total: String(deep),
                    count: String(deepCandidates.length),
                  },
                  localeMessages,
                ),
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
                maxItems,
                insertedTotal,
                planPrependGuidance,
                planAppendGuidance,
              });

              if (verbose) {
                emit({
                  kind: "info",
                  message: msg(
                    "plan.deep-task-executing",
                    { label: deepTaskLabel, line: String(parentTask.line) },
                    localeMessages,
                  ),
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
                timeoutMs: workerTimeoutMs,
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
                  message: msg(
                    "plan.deep-exit-error",
                    {
                      code: String(runResult.exitCode),
                      pass: String(deepPass),
                      task: String(deepTaskIndex + 1),
                    },
                    localeMessages,
                  ),
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
                  message: msg(
                    "plan.deep-read-error",
                    { pass: String(deepPass), task: String(deepTaskIndex + 1), source },
                    localeMessages,
                  ),
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

              if (deepEditedDocumentSource !== latestDocumentSource) {
                latestDocumentSource = deepEditedDocumentSource;
                recordInsertedTodoCount(validationResult.stats.added);
                deepPassInsertedCount += validationResult.stats.added;
              }

              if (maxItems !== undefined && insertedTotal >= maxItems) {
                convergenceOutcome = "max-items-reached";
                emit({
                  kind: "info",
                  message: msg(
                    "plan.deep-task-max-items",
                    {
                      pass: String(deepPass),
                      task: String(deepTaskIndex + 1),
                      added: String(insertedTotal),
                      max: String(maxItems),
                    },
                    localeMessages,
                  ),
                });
                maxItemsReachedDuringDeep = true;
                break;
              }

            }

            if (maxItemsReachedDuringDeep) {
              break;
            }

            if (maxItems !== undefined && insertedTotal >= maxItems) {
              convergenceOutcome = "max-items-reached";
              emit({
                kind: "info",
                message: msg(
                  "plan.deep-pass-max-items",
                  {
                    pass: String(deepPass),
                    added: String(insertedTotal),
                    max: String(maxItems),
                  },
                  localeMessages,
                ),
              });
              break;
            }

            if (deepPassInsertedCount === 0) {
              emit({
                kind: "info",
                message: msg("plan.deep-converged-no-items", { pass: String(deepPass) }, localeMessages),
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
          ? buildPlanConvergenceMetadata(scanStrategy, scansExecuted, convergenceOutcome, maxItems)
          : undefined;

        if (convergenceOutcome) {
          emit({
            kind: "info",
            message: formatPlanStopReason(convergenceOutcome),
          });
        }

        emitPlanSummary(convergenceOutcome);

        // Return success when no insertions are needed after all scans.
        if (insertedTotal === 0) {
          return finishPlan(EXIT_CODE_SUCCESS, "completed", convergenceMetadata);
        }

        emit({
          kind: "success",
          message: msg("plan.inserted", { count: String(insertedTotal), source }, localeMessages),
        });
        return finishPlan(EXIT_CODE_SUCCESS, "completed", convergenceMetadata);
      } finally {
        // Ensure trace and artifacts are finalized on all exceptional exits.
        if (!artifactsFinalized) {
          const finalStatus = artifactStatus === "running" ? "failed" : artifactStatus;
          completeTraceRun(finalStatus);
          traceWriter.flush();
          finalizePlanArtifacts(
            dependencies.artifactStore,
            artifactContext,
            keepArtifacts,
            finalStatus,
            emit,
            localeMessages,
          );
          artifactsFinalized = true;
        }
      }
    } finally {
      try {
        // Release all held source locks regardless of execution outcome.
        dependencies.fileLock.releaseAll();
      } catch (error) {
        emit({ kind: "warn", message: msg("plan.lock-release-failed", { error: String(error) }, localeMessages) });
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
  localeMessages: LocaleMessages,
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
      message: msg("plan.artifacts-saved", { path: artifactStore.displayPath(artifactContext) }, localeMessages),
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
  maxItems: number | undefined,
): PlanConvergenceMetadata {
  return {
    planScanMode: scanStrategy.mode,
    planScanCount: scanStrategy.mode === "bounded" ? scanStrategy.scanCount : null,
    planMaxItems: maxItems ?? null,
    planScansExecuted: scansExecuted,
    planConvergenceReason: convergenceOutcome,
    planConvergenceOutcome: convergenceOutcome,
    planConverged: convergenceOutcome === "converged-no-change"
      || convergenceOutcome === "converged-no-additions"
      || convergenceOutcome === "converged-diminishing"
      || convergenceOutcome === "converged-rewrite-only",
    planMaxItemsReached: convergenceOutcome === "max-items-reached",
    planScanCapReached: convergenceOutcome === "scan-cap-reached",
    planEmergencyCapReached: convergenceOutcome === "emergency-cap-reached",
  };
}

/**
 * Builds a user-facing summary line for top-level plan stop reason.
 */
function formatPlanStopReason(convergenceOutcome: PlanConvergenceOutcome): string {
  // TODO: Catalog per-outcome stop-reason strings in a follow-up migration.
  return "Plan stop reason: " + convergenceOutcome + ".";
}

/**
 * Type guard for convergence outcomes persisted in artifact metadata.
 */
function isPlanConvergenceOutcome(value: unknown): value is PlanConvergenceOutcome {
  return value === "converged-no-change"
    || value === "converged-no-additions"
    || value === "converged-diminishing"
    || value === "converged-rewrite-only"
    || value === "max-items-reached"
    || value === "scan-cap-reached"
    || value === "emergency-cap-reached";
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
  maxItems: number | undefined,
  insertedTotal: number,
): string {
  const scanStrategy = resolvePlanScanStrategy(scanCount);
  const scanLabel = buildPlanScanLabel(scanIndex, scanStrategy);
  const scanContextLine = scanStrategy.mode === "bounded"
    ? `Scan pass ${scanIndex} of ${scanStrategy.scanCount}.`
    : `Scan pass ${scanIndex} (unlimited mode; total pass count is unknown).`;
  const remainingItemBudget = maxItems === undefined
    ? undefined
    : Math.max(0, maxItems - insertedTotal);
  const scanContextParts = [
    `Scan label: ${scanLabel}`,
    scanContextLine,
  ];

  if (remainingItemBudget !== undefined) {
    scanContextParts.push(
      `Max-items cap: ${maxItems}. Already added: ${insertedTotal}. Remaining item budget: ${remainingItemBudget}.`,
      `Add at most ${remainingItemBudget} new TODO ${pluralize(remainingItemBudget, "item", "items")} in this scan; if no budget remains, leave the file unchanged.`,
    );
  }

  return `${basePrompt}\n\n## Scan Context\n\n${scanContextParts.join("\n")}\n\nTreat this scan as a clean standalone worker session. Do not rely on prior prompt history or prior scan outputs.\n\nEdit the source file directly at: ${sourcePath}\n\nAvoid cosmetic rewrites (including reordering, reformatting, or wording-only changes). Only edit when adding genuinely missing actionable TODO items.\n\nIf plan coverage is already sufficient, leave the file unchanged. If no useful TODO edits are needed, leave the file unchanged.`;
}

/**
 * Provides plan-template context without embedding full document content.
 */
function buildPlanPromptDocumentContext(sourcePath: string): string {
  return `Document source is intentionally omitted for plan scans. Read and edit the file directly at: ${sourcePath}`;
}

/**
 * Emits planner prompt mode and template-selection details for preview paths.
 */
function emitPlanPromptSelectionInfo(options: {
  emit: ApplicationOutputPort["emit"];
  loop: boolean;
  selectedTemplatePath: string | undefined;
  dryRun: boolean;
  localeMessages: LocaleMessages;
}): void {
  const modeLabel = options.loop ? "loop (--loop enabled)" : "standard (--loop disabled)";
  const modeMessage = options.dryRun
    ? msg("plan.dry-run-prompt-mode", { mode: modeLabel }, options.localeMessages)
    : msg(
      options.loop ? "plan.prompt-mode-loop" : "plan.prompt-mode-standard",
      {},
      options.localeMessages,
    );
  options.emit({ kind: "info", message: modeMessage });

  const templatePathMessage = options.selectedTemplatePath
    ? options.selectedTemplatePath
    : "built-in default template (no .rundown config directory resolved)";
  const templateBehaviorSuffix = options.loop
    ? "loop planner template with deterministic `get:` + `for:` + `end:` guidance"
    : "standard planner template";
  const templateMessage = msg(
    options.dryRun ? "plan.dry-run-template-info" : "plan.template-info",
    {
      path: templatePathMessage,
      behavior: templateBehaviorSuffix,
    },
    options.localeMessages,
  );
  options.emit({ kind: "info", message: templateMessage });
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
  maxItems: number | undefined;
  insertedTotal: number;
  planPrependGuidance: string;
  planAppendGuidance: string;
}): string {
  const remainingItemBudget = options.maxItems === undefined
    ? undefined
    : Math.max(0, options.maxItems - options.insertedTotal);
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
    maxItems: options.maxItems,
    insertedTotal: options.insertedTotal,
    remainingItemBudget,
    planPrependGuidance: options.planPrependGuidance,
    planAppendGuidance: options.planAppendGuidance,
  };

  const renderedTemplate = renderTemplate(options.deepPlanTemplate, deepVars);
  const deepContextParts = [`Deep pass ${options.deepPass} of ${options.deep}.`];

  if (remainingItemBudget !== undefined) {
    deepContextParts.push(
      `Max-items cap: ${options.maxItems}. Already added: ${options.insertedTotal}. Remaining item budget: ${remainingItemBudget}.`,
      `Add at most ${remainingItemBudget} new TODO ${pluralize(remainingItemBudget, "item", "items")} for this parent task; if no budget remains, leave the file unchanged.`,
    );
  }

  return `${renderedTemplate}\n\n## Deep Pass Context\n\n${deepContextParts.join("\n")}\n\nTreat this deep pass as a clean standalone worker session. Do not rely on prior prompt history or prior deep-pass outputs.\n\nEdit the source file directly at: ${options.parentTask.file}\n\nIf no useful child TODO edits are needed for the selected parent task, leave the file unchanged.`;
}

function loadOptionalPlannerGuidance(options: {
  configDir: ConfigDirResult | undefined;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  templateLoader: TemplateLoader;
  fileName: string;
}): string {
  if (!options.configDir) {
    return "";
  }

  const guidancePath = options.pathOperations.join(options.configDir.configDir, options.fileName);
  try {
    const content = options.fileSystem.readText(guidancePath);
    if (content.trim().length > 0) {
      return content.trim();
    }
  } catch {
    // Fall through to template-loader fallback for test doubles that provide
    // guidance via `templateLoader.load` instead of `fileSystem.readText`.
  }

  const fallbackContent = options.templateLoader.load(guidancePath);
  if (!fallbackContent || fallbackContent.trim().length === 0) {
    return "";
  }

  const normalized = fallbackContent.trim();
  if (normalized.includes("{{planPrependGuidance}}") || normalized.includes("{{planAppendGuidance}}")) {
    return "";
  }

  return normalized;
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
