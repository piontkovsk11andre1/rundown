import {
  DEFAULT_REPAIR_TEMPLATE,
  getTraceInstructions,
  DEFAULT_VERIFY_TEMPLATE,
} from "../domain/defaults.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import { type Task, parseTasks } from "../domain/parser.js";
import { resolveRunBehavior } from "../domain/run-options.js";
import {
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import {
  createRunCompletedEvent,
  createRunStartedEvent,
} from "../domain/trace.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import { resolveWorkerForInvocation } from "./resolve-worker.js";
import type {
  ArtifactStoreStatus,
  ArtifactRunMetadata,
  ArtifactStore,
  CommandExecutionOptions,
  CommandExecutor,
  ConfigDirResult,
  FileSystem,
  PathOperationsPort,
  PromptTransport,
  TaskRepairPort,
  TaskVerificationPort,
  TemplateLoader,
  TraceWriterPort,
  VerificationStore,
  WorkerConfigPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

interface ReverifyTemplates {
  verify: string;
  repair: string;
}

interface RuntimeTaskMetadata {
  text: string;
  file: string;
  line: number;
  index: number;
  source: string;
}

interface ResolvedTaskContext {
  task: Task;
  source: string;
  contextBefore: string;
}

interface ReverifyPromptContext {
  verificationPrompt: string;
  repairPrompt: string;
}

class TemplateCliBlockExecutionError extends Error {
  readonly templateLabel: string;
  readonly command: string;
  readonly exitCode: number | null;

  constructor(templateLabel: string, command: string, exitCode: number | null) {
    super("Template cli block execution failed");
    this.templateLabel = templateLabel;
    this.command = command;
    this.exitCode = exitCode;
  }
}

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
  templateLoader: TemplateLoader;
  workerConfigPort: WorkerConfigPort;
  output: ApplicationOutputPort;
  cliBlockExecutor: CommandExecutor;
}

export interface ReverifyTaskOptions {
  runId: string;
  last?: number;
  all?: boolean;
  oldestFirst?: boolean;
  transport: PromptTransport;
  repairAttempts: number;
  noRepair: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  workerCommand: string[];
  trace: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
}

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
      transport,
      repairAttempts,
      noRepair,
      dryRun,
      printPrompt,
      keepArtifacts,
      workerCommand,
      trace,
      ignoreCliBlock,
      cliBlockTimeoutMs,
    } = options;
    const cliExecutionOptions = cliBlockTimeoutMs === undefined
      ? undefined
      : { timeoutMs: cliBlockTimeoutMs };
    const withCommandExecutionHandler = (
      executionOptions: CommandExecutionOptions | undefined,
      handler: ((execution: {
        command: string;
        exitCode: number | null;
        stdoutLength: number;
        stderrLength: number;
        durationMs: number;
      }) => void | Promise<void>) | undefined,
    ): CommandExecutionOptions | undefined => {
      if (!handler) {
        return executionOptions;
      }

      const existingHandler = executionOptions?.onCommandExecuted;

      return {
        ...(executionOptions ?? {}),
        onCommandExecuted: async (execution): Promise<void> => {
          await existingHandler?.(execution);
          await handler(execution);
        },
      };
    };
    const templateCliFailureHandler = (templateLabel: string) => (execution: {
      command: string;
      exitCode: number | null;
      stdoutLength: number;
      stderrLength: number;
      durationMs: number;
    }): void => {
      if (typeof execution.exitCode === "number" && execution.exitCode === 0) {
        return;
      }

      throw new TemplateCliBlockExecutionError(templateLabel, execution.command, execution.exitCode);
    };
    const cliExecutionOptionsWithTemplateFailureAbort = withCommandExecutionHandler(
      cliExecutionOptions,
      templateCliFailureHandler("verification/repair template"),
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
    const reverifyOneRun = async (
      selectedRun: ArtifactRunMetadata,
    ): Promise<{ exitCode: number; status: ArtifactStoreStatus | null }> => {
      if (selectedRun.status === "metadata-missing") {
        emit({
          kind: "error",
          message: "Selected run is missing run metadata (run.json). Re-run the original task with --keep-artifacts, then retry reverify.",
        });
        return { exitCode: 3, status: null };
      }

      if (!isCompletedRun(selectedRun)) {
        emit({
          kind: "error",
          message: "Selected run is not completed (status=" + (selectedRun.status ?? "unknown") + "). Use `rundown artifacts` to choose a completed run.",
        });
        return { exitCode: 3, status: null };
      }

      if (!selectedRun.task) {
        emit({
          kind: "error",
          message: "Selected run has no task metadata to re-verify. Choose a different run or execute tasks again to refresh artifacts.",
        });
        return { exitCode: 3, status: null };
      }

      const metadataError = validateTaskMetadata(selectedRun.task);
      if (metadataError) {
        emit({
          kind: "error",
          message: "Selected run has invalid task metadata: " + metadataError
            + " Re-run the task to regenerate runtime artifacts.",
        });
        return { exitCode: 3, status: null };
      }

      const taskContext = resolveTaskContextFromMetadata(
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

      const templates = loadProjectTemplates(
        dependencies.configDir,
        dependencies.templateLoader,
        dependencies.pathOperations,
      );
      const cliBlockExecutor = dependencies.cliBlockExecutor;
      const promptContext = buildReverifyPromptContext(taskContext, templates, trace);
      const verificationPromptCliBlockCount = extractCliBlocks(promptContext.verificationPrompt).length;
      const repairPromptCliBlockCount = extractCliBlocks(promptContext.repairPrompt).length;
      const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
      let expandedVerificationPrompt = promptContext.verificationPrompt;
      let expandedRepairPrompt = promptContext.repairPrompt;
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
      const effectiveWorkerCommand = resolveWorkerForInvocation({
        commandName: "reverify",
        workerConfig: loadedWorkerConfig,
        source: taskContext.source,
        task: taskContext.task,
        cliWorkerCommand: workerCommand,
        fallbackWorkerCommand: selectedRun.workerCommand,
        emit,
      });

      if (printPrompt) {
        emit({ kind: "text", text: expandedVerificationPrompt });
        return { exitCode: 0, status: null };
      }

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

      if (effectiveWorkerCommand.length === 0) {
        emit({
          kind: "error",
          message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <command...> or -- <command>.",
        });
        return { exitCode: 1, status: null };
      }

      const runBehavior = resolveRunBehavior({
        verify: true,
        onlyVerify: true,
        noRepair: noRepair,
        repairAttempts,
      });

      const artifactContext = dependencies.artifactStore.createContext({
        cwd,
        configDir: dependencies.configDir?.configDir,
        commandName: "reverify",
        workerCommand: effectiveWorkerCommand,
        mode: "wait",
        transport,
        source: selectedRun.source,
        task: toRuntimeTaskMetadata(taskContext.task, taskContext.source),
        keepArtifacts,
      });
      const traceWriter = dependencies.createTraceWriter(trace, artifactContext);
      const traceStartedAtMs = Date.now();
      let traceCompleted = false;
      let artifactsFinalized = false;

      const nowIso = (): string => new Date().toISOString();

      traceWriter.write(createRunStartedEvent({
        timestamp: nowIso(),
        run_id: artifactContext.runId,
        payload: {
          command: "reverify",
          source: selectedRun.source ?? taskContext.task.file,
          worker: effectiveWorkerCommand,
          mode: "wait",
          transport,
          task_text: taskContext.task.text,
          task_file: taskContext.task.file,
          task_line: taskContext.task.line,
        },
      }));

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
          workerCommand: effectiveWorkerCommand,
          transport,
          configDir: dependencies.configDir?.configDir,
          maxRepairAttempts: runBehavior.maxRepairAttempts,
          allowRepair: runBehavior.allowRepair,
          templateVars: {},
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

function loadProjectTemplates(
  configDir: ConfigDirResult | undefined,
  templateLoader: TemplateLoader,
  pathOperations: PathOperationsPort,
): ReverifyTemplates {
  if (!configDir) {
    return {
      verify: DEFAULT_VERIFY_TEMPLATE,
      repair: DEFAULT_REPAIR_TEMPLATE,
    };
  }

  const configRoot = configDir.configDir;
  return {
    verify: templateLoader.load(pathOperations.join(configRoot, "verify.md")) ?? DEFAULT_VERIFY_TEMPLATE,
    repair: templateLoader.load(pathOperations.join(configRoot, "repair.md")) ?? DEFAULT_REPAIR_TEMPLATE,
  };
}

function resolveTargetRunMetadata(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
  runId: string,
): ArtifactRunMetadata | null {
  if (runId === "latest") {
    const runs = artifactStore.listSaved(artifactBaseDir);
    return runs.find((run) => isCompletedRun(run) && hasReverifiableTask(run)) ?? null;
  }

  return artifactStore.find(runId, artifactBaseDir);
}

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

function hasReverifiableTask(run: ArtifactRunMetadata): boolean {
  return Boolean(run.task && run.task.text && run.task.file);
}

function isCompletedRun(run: ArtifactRunMetadata): boolean {
  const status = run.status;
  return status === "completed" || status === "reverify-completed";
}

function validateTaskMetadata(task: {
  text: string;
  file: string;
  line: number;
  index: number;
  source: string;
}): string | null {
  if (!task.text || task.text.trim() === "") {
    return "Selected run task metadata is missing task text.";
  }
  if (!task.file || task.file.trim() === "") {
    return "Selected run task metadata is missing task file path.";
  }
  if (!Number.isInteger(task.line) || task.line < 1) {
    return "Selected run task metadata has invalid task line.";
  }
  if (!Number.isInteger(task.index) || task.index < 0) {
    return "task index must be a non-negative integer.";
  }
  if (!task.source || task.source.trim() === "") {
    return "task source is missing.";
  }

  return null;
}

function resolveTaskContextFromMetadata(
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

function toRuntimeTaskMetadata(task: Task, source: string): RuntimeTaskMetadata {
  return {
    text: task.text,
    file: task.file,
    line: task.line,
    index: task.index,
    source,
  };
}

function buildReverifyPromptContext(
  taskContext: ResolvedTaskContext,
  templates: ReverifyTemplates,
  trace: boolean,
): ReverifyPromptContext {
  const vars: TemplateVars = {
    task: taskContext.task.text,
    file: taskContext.task.file,
    context: taskContext.contextBefore,
    taskIndex: taskContext.task.index,
    taskLine: taskContext.task.line,
    source: taskContext.source,
    traceInstructions: getTraceInstructions(trace),
    ...buildTaskHierarchyTemplateVars(taskContext.task),
  };

  return {
    verificationPrompt: renderTemplate(templates.verify, vars),
    repairPrompt: renderTemplate(templates.repair, vars),
  };
}

function formatTaskLabel(task: Task): string {
  return `${task.file}:${task.line} [#${task.index}] ${task.text}`;
}

function formatTaskMetadataLabel(task: RuntimeTaskMetadata): string {
  return `${task.file}:${task.line} [#${task.index}] ${task.text}`;
}

