import {
  getTraceInstructions,
} from "../domain/defaults.js";
import {
  buildRundownVarEnv,
  formatTemplateVarsForPrompt,
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import { resolveRunBehavior } from "../domain/run-options.js";
import {
  buildMemoryTemplateVars,
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import {
  createRunCompletedEvent,
  createRunStartedEvent,
} from "../domain/trace.js";
import {
  TemplateCliBlockExecutionError,
  withTemplateCliFailureAbort,
} from "./cli-block-handlers.js";
import {
  loadProjectTemplatesFromPorts,
  type ProjectTemplates,
} from "./project-templates.js";
import { formatTaskLabel } from "./run-task-utils.js";
import {
  resolveLatestCompletedRun,
  resolveTaskContextFromRuntimeMetadata,
  type ResolvedTaskContext,
  type RuntimeTaskMetadata,
  toRuntimeTaskMetadata,
  validateRuntimeTaskMetadata,
} from "./task-context-resolution.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";
import type {
  ArtifactStoreStatus,
  ArtifactRunMetadata,
  ArtifactStore,
  CommandExecutor,
  ConfigDirResult,
  FileSystem,
  MemoryMetadata,
  MemoryResolverPort,
  PathOperationsPort,
  TaskRepairPort,
  TaskVerificationPort,
  TemplateLoader,
  TemplateVarsLoaderPort,
  TraceWriterPort,
  VerificationStore,
  WorkerConfigPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

interface ReverifyPromptContext {
  // Fully rendered verification prompt for the selected task context.
  verificationPrompt: string;
  // Fully rendered repair prompt paired with the verification template.
  repairPrompt: string;
}

/**
 * Services required to resolve saved run metadata and execute re-verification.
 */
export interface ReverifyTaskDependencies {
  artifactStore: ArtifactStore;
  taskVerification: TaskVerificationPort;
  taskRepair: TaskRepairPort;
  verificationStore: VerificationStore;
  workingDirectory: WorkingDirectoryPort;
  fileSystem: FileSystem;
  // Intentionally no FileLock dependency: reverify reads markdown to resolve context,
  // but does not mutate source files.
  traceWriter: TraceWriterPort;
  configDir: ConfigDirResult | undefined;
  createTraceWriter: (trace: boolean, artifactContext: { rootDir: string }) => TraceWriterPort;
  pathOperations: PathOperationsPort;
  memoryResolver?: MemoryResolverPort;
  templateLoader: TemplateLoader;
  templateVarsLoader: TemplateVarsLoaderPort;
  workerConfigPort: WorkerConfigPort;
  output: ApplicationOutputPort;
  cliBlockExecutor: CommandExecutor;
}

/**
 * Runtime options that control which saved run(s) are re-verified and how.
 */
export interface ReverifyTaskOptions {
  runId: string;
  last?: number;
  all?: boolean;
  oldestFirst?: boolean;
  workerPattern: ParsedWorkerPattern;
  repairAttempts: number;
  noRepair: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption?: string | boolean | undefined;
  cliTemplateVarArgs?: string[];
  trace: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
}

/**
 * Creates the reverify application command that replays verification/repair
 * against one or more previously completed artifact runs.
 */
export function createReverifyTask(
  dependencies: ReverifyTaskDependencies,
): (options: ReverifyTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function reverifyTask(options: ReverifyTaskOptions): Promise<number> {
    const {
      runId,
      last,
      all,
      oldestFirst,
      workerPattern,
      repairAttempts,
      noRepair,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      trace,
      ignoreCliBlock,
      cliBlockTimeoutMs,
    } = options;
    const varsFilePath = resolveTemplateVarsFilePath(
      varsFileOption,
      dependencies.configDir?.configDir,
    );
    const fileTemplateVars = varsFilePath
      ? dependencies.templateVarsLoader.load(
        varsFilePath,
        dependencies.workingDirectory.cwd(),
        dependencies.configDir?.configDir,
      )
      : {};
    const cliTemplateVars = parseCliTemplateVars(cliTemplateVarArgs ?? []);
    const extraTemplateVars: ExtraTemplateVars = {
      ...fileTemplateVars,
      ...cliTemplateVars,
    };
    const rundownVarEnv = buildRundownVarEnv(extraTemplateVars);
    const templateVarsWithUserVariables: ExtraTemplateVars = {
      ...extraTemplateVars,
      userVariables: formatTemplateVarsForPrompt(extraTemplateVars),
    };
    // Pass timeout options only when the CLI block timeout flag is provided.
    const cliExecutionOptions = cliBlockTimeoutMs === undefined
      ? { env: rundownVarEnv }
      : { timeoutMs: cliBlockTimeoutMs, env: rundownVarEnv };
    // Abort prompt expansion immediately when template CLI commands fail.
    const cliExecutionOptionsWithTemplateFailureAbort = withTemplateCliFailureAbort(
      cliExecutionOptions,
      "verification/repair template",
    );

    const hasMultiRunSelection = all === true || last !== undefined;

    if (all && last !== undefined) {
      emit({ kind: "error", message: "Cannot combine --all with --last." });
      return 1;
    }

    if (hasMultiRunSelection && runId !== "latest") {
      emit({ kind: "error", message: "Cannot combine --run <id> with --all or --last." });
      return 1;
    }

    if (hasMultiRunSelection && printPrompt) {
      emit({ kind: "error", message: "--print-prompt is not supported with --all or --last." });
      return 1;
    }

    if (last !== undefined && (last < 1 || !Number.isInteger(last))) {
      emit({ kind: "error", message: "--last must be a positive integer." });
      return 1;
    }

    const cwd = dependencies.workingDirectory.cwd();
    const artifactBaseDir = dependencies.configDir?.configDir;
    const loadedWorkerConfig = dependencies.configDir?.configDir
      ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
      : undefined;
    /**
     * Re-verifies a single saved run and returns both process exit code and
     * artifact finalization status information.
     */
    const reverifyOneRun = async (
      selectedRun: ArtifactRunMetadata,
    ): Promise<{ exitCode: number; status: ArtifactStoreStatus | null }> => {
      // Saved run metadata is required to resolve source and task context.
      if (selectedRun.status === "metadata-missing") {
        emit({
          kind: "error",
          message: "Selected run is missing run metadata (run.json). Re-run the original task with --keep-artifacts, then retry reverify.",
        });
        return { exitCode: 3, status: null };
      }

      // Reverify only supports runs that reached a completed terminal state.
      if (!isCompletedRun(selectedRun)) {
        emit({
          kind: "error",
          message: "Selected run is not completed (status=" + (selectedRun.status ?? "unknown") + "). Use `rundown artifacts` to choose a completed run.",
        });
        return { exitCode: 3, status: null };
      }

      // Runtime task metadata is mandatory because reverify does not re-parse CLI input.
      if (!selectedRun.task) {
        emit({
          kind: "error",
          message: "Selected run has no task metadata to re-verify. Choose a different run or execute tasks again to refresh artifacts.",
        });
        return { exitCode: 3, status: null };
      }

      // Validate metadata shape before using it to resolve file/task references.
      const metadataError = validateRuntimeTaskMetadata(selectedRun.task);
      if (metadataError) {
        emit({
          kind: "error",
          message: "Selected run has invalid task metadata: " + metadataError
            + " Re-run the task to regenerate runtime artifacts.",
        });
        return { exitCode: 3, status: null };
      }

      // Resolve the current task view from persisted runtime metadata.
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
        return { exitCode: 3, status: null };
      }

      emit({ kind: "info", message: "Re-verify task: " + formatTaskLabel(taskContext.task) });

      // Load verify/repair templates from config or built-in defaults.
      const templates = loadProjectTemplatesFromPorts(
        dependencies.configDir,
        dependencies.templateLoader,
        dependencies.pathOperations,
      );
      const cliBlockExecutor = dependencies.cliBlockExecutor;
      const promptContext = buildReverifyPromptContext(
        taskContext,
        templates,
        trace,
        dependencies.memoryResolver?.resolve(taskContext.task.file) ?? null,
        templateVarsWithUserVariables,
      );
      // Count `cli` fenced blocks so dry-run output can report skipped work.
      const verificationPromptCliBlockCount = extractCliBlocks(promptContext.verificationPrompt).length;
      const repairPromptCliBlockCount = extractCliBlocks(promptContext.repairPrompt).length;
      const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
      let expandedVerificationPrompt = promptContext.verificationPrompt;
      let expandedRepairPrompt = promptContext.repairPrompt;
      // Expand template CLI blocks unless explicitly ignored or dry-run suppressed.
      if (!ignoreCliBlock && !dryRunSuppressesCliExpansion) {
        try {
          expandedVerificationPrompt = await expandCliBlocks(
            promptContext.verificationPrompt,
            cliBlockExecutor,
            cwd,
            cliExecutionOptionsWithTemplateFailureAbort,
          );
          expandedRepairPrompt = await expandCliBlocks(
            promptContext.repairPrompt,
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
            return { exitCode: 1, status: null };
          }
          throw error;
        }
      }
      // Reuse original worker command when no stronger override is provided.
      const resolvedWorker = resolveWorkerPatternForInvocation({
        commandName: "reverify",
        workerConfig: loadedWorkerConfig,
        source: taskContext.source,
        task: taskContext.task,
        cliWorkerPattern: workerPattern,
        fallbackWorkerCommand: selectedRun.workerCommand,
        emit,
      });
      const effectiveWorkerCommand = resolvedWorker.workerCommand;
      const effectiveWorkerPattern = resolvedWorker.workerPattern;

      // Print prompt mode stops before any worker invocation or artifact writes.
      if (printPrompt) {
        emit({ kind: "text", text: expandedVerificationPrompt });
        return { exitCode: 0, status: null };
      }

      // Dry-run reports what would execute without mutating artifacts or tasks.
      if (dryRun) {
        if (dryRunSuppressesCliExpansion && !ignoreCliBlock) {
          const totalCliBlockCount = verificationPromptCliBlockCount + repairPromptCliBlockCount;
          emit({
            kind: "info",
            message: "Dry run — skipped `cli` fenced block execution; would execute "
              + totalCliBlockCount
              + " block"
              + (totalCliBlockCount === 1 ? "" : "s")
              + ".",
          });
        }
        emit({ kind: "info", message: "Dry run - would run verification with: " + effectiveWorkerCommand.join(" ") });
        emit({ kind: "info", message: "Prompt length: " + expandedVerificationPrompt.length + " chars" });
        return { exitCode: 0, status: null };
      }

      // Verification always requires a concrete worker command at execution time.
      if (effectiveWorkerCommand.length === 0) {
        emit({
          kind: "error",
          message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.",
        });
        return { exitCode: 1, status: null };
      }

      // Reverify mode always performs verification and conditionally repairs.
      const runBehavior = resolveRunBehavior({
        verify: true,
        onlyVerify: true,
        noRepair: noRepair,
        repairAttempts,
      });

      // Create a fresh artifact context for this reverify invocation.
      const artifactContext = dependencies.artifactStore.createContext({
        cwd,
        configDir: dependencies.configDir?.configDir,
        commandName: "reverify",
        workerCommand: effectiveWorkerCommand,
        mode: "wait",
        source: selectedRun.source,
        task: toRuntimeTaskMetadata(taskContext.task, taskContext.source),
        keepArtifacts,
      });
      const traceWriter = dependencies.createTraceWriter(trace, artifactContext);
      const traceStartedAtMs = Date.now();
      let traceCompleted = false;
      let artifactsFinalized = false;

      const nowIso = (): string => new Date().toISOString();

      // Record run start trace metadata before entering verification loop.
      traceWriter.write(createRunStartedEvent({
        timestamp: nowIso(),
        run_id: artifactContext.runId,
        payload: {
          command: "reverify",
          source: selectedRun.source ?? taskContext.task.file,
          worker: effectiveWorkerCommand,
          mode: "wait",
          transport: "pattern",
          task_text: taskContext.task.text,
          task_file: taskContext.task.file,
          task_line: taskContext.task.line,
        },
      }));

      // Emits exactly one run-completed trace event per reverify invocation.
      const completeTraceRun = (status: ArtifactStoreStatus): void => {
        if (traceCompleted) {
          return;
        }

        traceWriter.write(createRunCompletedEvent({
          timestamp: nowIso(),
          run_id: artifactContext.runId,
          payload: {
            status,
            total_duration_ms: Math.max(0, Date.now() - traceStartedAtMs),
            total_phases: 0,
          },
        }));
        traceCompleted = true;
      };

      // Finalizes trace/artifacts once, then returns the intended process result.
      const finalizeAndReturn = (
        exitCode: number,
        status: ArtifactStoreStatus,
      ): { exitCode: number; status: ArtifactStoreStatus } => {
        if (!artifactsFinalized) {
          completeTraceRun(status);
          traceWriter.flush();
          dependencies.artifactStore.finalize(artifactContext, { status, preserve: keepArtifacts });
          artifactsFinalized = true;
          if (keepArtifacts) {
            emit({
              kind: "info",
              message: "Runtime artifacts saved at " + dependencies.artifactStore.displayPath(artifactContext) + ".",
            });
          }
        }
        return { exitCode, status };
      };

      try {
        // Drive verification and optional repair using the resolved prompts.
        const verificationResult = await runVerifyRepairLoop({
          taskVerification: dependencies.taskVerification,
          taskRepair: dependencies.taskRepair,
          verificationStore: dependencies.verificationStore,
          traceWriter,
          output: dependencies.output,
        }, {
          task: taskContext.task,
          source: taskContext.source,
          contextBefore: taskContext.contextBefore,
          verifyTemplate: expandedVerificationPrompt,
          repairTemplate: expandedRepairPrompt,
          workerPattern: effectiveWorkerPattern,
          configDir: dependencies.configDir?.configDir,
          maxRepairAttempts: runBehavior.maxRepairAttempts,
          allowRepair: runBehavior.allowRepair,
          templateVars: templateVarsWithUserVariables,
          executionEnv: rundownVarEnv,
          artifactContext,
          trace,
          cliBlockExecutor,
          cliExecutionOptions: cliExecutionOptionsWithTemplateFailureAbort,
        });

        if (!verificationResult.valid) {
          const message = verificationResult.failureReason
            ? "Verification failed after all repair attempts.\n" + verificationResult.failureReason
            : "Verification failed after all repair attempts.";
          emit({ kind: "error", message });
          return finalizeAndReturn(2, "reverify-failed");
        }

        emit({ kind: "success", message: "Re-verification passed." });
        return finalizeAndReturn(0, "reverify-completed");
      } catch (error) {
        // Ensure failure states still flush traces and artifact metadata.
        if (!artifactsFinalized) {
          completeTraceRun("reverify-failed");
          traceWriter.flush();
          dependencies.artifactStore.finalize(artifactContext, {
            status: "reverify-failed",
            preserve: keepArtifacts,
          });
          artifactsFinalized = true;
        }
        throw error;
      }
    };

    // Resolve the run set from selector flags before entering the loop.
    const targetRuns = resolveTargetRuns(dependencies.artifactStore, artifactBaseDir, {
      runId,
      last,
      all,
      oldestFirst,
    });
    if (targetRuns.length === 0) {
      if (hasMultiRunSelection) {
        emit({ kind: "error", message: "No completed runs found to re-verify." });
        return 3;
      }

      const target = runId === "latest"
        ? "latest completed"
        : runId;
      emit({ kind: "error", message: "No saved runtime artifact run found for: " + target });
      return 3;
    }

    if (hasMultiRunSelection && dryRun) {
      emit({
        kind: "info",
        message: "Dry run - would re-verify " + targetRuns.length + " completed runs:",
      });
      for (const run of targetRuns) {
        if (run.task) {
          emit({
            kind: "info",
            message: "- " + run.runId + " " + formatTaskMetadataLabel(run.task),
          });
        }
      }
      return 0;
    }

    // Process selected runs sequentially and stop at the first failure.
    let tasksReverified = 0;
    for (const run of targetRuns) {
      const result = await reverifyOneRun(run);
      if (result.exitCode !== 0) {
        if (hasMultiRunSelection) {
          emit({
            kind: "error",
            message: "Re-verify stopped on " + run.runId + " after " + tasksReverified
              + " successful task(s).",
          });
        }
        return result.exitCode;
      }

      tasksReverified += 1;
    }

    if (hasMultiRunSelection) {
      emit({
        kind: "success",
        message: "Re-verified " + tasksReverified + " tasks successfully.",
      });
    }

    return 0;
  };
}

/**
 * Resolves one run by id or the latest completed run alias.
 */
function resolveTargetRunMetadata(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
  runId: string,
): ArtifactRunMetadata | null {
  if (runId === "latest") {
    return resolveLatestCompletedRun(artifactStore, artifactBaseDir);
  }

  return artifactStore.find(runId, artifactBaseDir);
}

/**
 * Expands run selectors (`--all`, `--last`, explicit run id) into a concrete
 * ordered list of runs eligible for re-verification.
 */
function resolveTargetRuns(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
  options: Pick<ReverifyTaskOptions, "runId" | "last" | "all" | "oldestFirst">,
): ArtifactRunMetadata[] {
  const { runId, last, all, oldestFirst } = options;
  let selectedRuns: ArtifactRunMetadata[];

  if (all) {
    selectedRuns = artifactStore
      .listSaved(artifactBaseDir)
      .filter((run) => isCompletedRun(run) && hasReverifiableTask(run));
  } else if (last !== undefined) {
    selectedRuns = artifactStore
      .listSaved(artifactBaseDir)
      .filter((run) => isCompletedRun(run) && hasReverifiableTask(run))
      .slice(0, last);
  } else {
    const selectedRun = resolveTargetRunMetadata(artifactStore, artifactBaseDir, runId);
    selectedRuns = selectedRun ? [selectedRun] : [];
  }

  return oldestFirst ? [...selectedRuns].reverse() : selectedRuns;
}

/**
 * Guards multi-run selectors so only runs with usable task metadata are queued.
 */
function hasReverifiableTask(run: ArtifactRunMetadata): boolean {
  return Boolean(run.task && run.task.text && run.task.file);
}

/**
 * Determines whether run status represents a finished, re-verifiable run.
 */
function isCompletedRun(run: ArtifactRunMetadata): boolean {
  const status = run.status;
  return status === "completed"
    || status === "reverify-completed"
    || status === "discuss-finished-completed";
}

/**
 * Renders verification and repair prompts for a resolved runtime task context.
 */
function buildReverifyPromptContext(
  taskContext: ResolvedTaskContext,
  templates: Pick<ProjectTemplates, "verify" | "repair">,
  trace: boolean,
  memoryMetadata: MemoryMetadata | null,
  extraTemplateVars: ExtraTemplateVars,
): ReverifyPromptContext {
  const vars: TemplateVars = {
    ...extraTemplateVars,
    task: taskContext.task.text,
    file: taskContext.task.file,
    context: taskContext.contextBefore,
    taskIndex: taskContext.task.index,
    taskLine: taskContext.task.line,
    source: taskContext.source,
    traceInstructions: getTraceInstructions(trace),
    ...buildMemoryTemplateVars({ memoryMetadata }),
    ...buildTaskHierarchyTemplateVars(taskContext.task),
  };

  // Render both templates from the same variable set to keep context aligned.
  return {
    verificationPrompt: renderTemplate(templates.verify, vars),
    repairPrompt: renderTemplate(templates.repair, vars),
  };
}

/**
 * Formats runtime task metadata into the standard human-readable task label.
 */
function formatTaskMetadataLabel(task: RuntimeTaskMetadata): string {
  return formatTaskLabel({
    text: task.text,
    checked: false,
    index: task.index,
    line: task.line,
    column: 0,
    offsetStart: 0,
    offsetEnd: 0,
    file: task.file,
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  });
}

