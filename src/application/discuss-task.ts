import type { SortMode } from "../domain/sorting.js";
import type { Task } from "../domain/parser.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import {
  buildMemoryTemplateVars,
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import {
  createDiscussionCompletedEvent,
  createDiscussionFinishedCompletedEvent,
  createDiscussionFinishedStartedEvent,
  createDiscussionStartedEvent,
} from "../domain/trace.js";
import {
  buildRundownVarEnv,
  formatTemplateVarsForPrompt,
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
  type ExtraTemplateVars,
} from "../domain/template-vars.js";
import {
  TemplateCliBlockExecutionError,
  withTemplateCliFailureAbort,
} from "./cli-block-handlers.js";
import {
  captureCheckboxState,
  detectCheckboxMutations,
  type CheckboxStateSnapshot,
} from "./checkbox-operations.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { loadProjectTemplatesFromPorts } from "./project-templates.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";
import { formatTaskLabel, pluralize } from "./run-task-utils.js";
import {
  resolveTaskContextFromRuntimeMetadata,
  validateRuntimeTaskMetadata,
  type RuntimeTaskMetadata,
} from "./task-context-resolution.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import type { FileLock } from "../domain/ports/file-lock.js";
import type {
  ArtifactRunContext,
  ArtifactRunMetadata,
  ArtifactStore,
  CommandExecutor,
  ConfigDirResult,
  FileSystem,
  MemoryResolverPort,
  PathOperationsPort,
  ProcessRunMode,
  SourceResolverPort,
  TaskSelectionResult as PortTaskSelectionResult,
  TaskSelectorPort,
  TemplateLoader,
  TemplateVarsLoaderPort,
  TraceWriterPort,
  WorkerConfigPort,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

export type RunnerMode = ProcessRunMode;

/**
 * Artifact context alias used for discuss command runs.
 */
type ArtifactContext = ArtifactRunContext;

/**
 * Task payload and source metadata required to render a discuss prompt.
 */
interface ResolvedTaskContext {
  task: Task;
  source: string;
  contextBefore: string;
}

interface FinishedRunScannedPhase {
  sequence: number;
  name: string;
  phase: "execute" | "verify" | "repair";
  dir: string;
  metadataFile: string;
  promptFile: string | null;
  stdoutFile: string | null;
  stderrFile: string | null;
  exitCode: number | null;
  verificationResult: string;
}

interface FinishedRunPhaseScan {
  execute: FinishedRunScannedPhase[];
  verify: FinishedRunScannedPhase[];
  repair: FinishedRunScannedPhase[];
  all: FinishedRunScannedPhase[];
}

interface FinishedRunPromptContext {
  run: ArtifactRunMetadata;
  taskMetadata: RuntimeTaskMetadata;
  phases: FinishedRunPhaseScan;
}

/**
 * Task selection payload returned by the task selector port.
 */
type TaskSelectionResult = PortTaskSelectionResult;

/**
 * Ports and services required to execute the `discuss` command.
 */
export interface DiscussTaskDependencies {
  sourceResolver: SourceResolverPort;
  taskSelector: TaskSelectorPort;
  workerExecutor: WorkerExecutorPort;
  workingDirectory: WorkingDirectoryPort;
  fileSystem: FileSystem;
  fileLock: FileLock;
  templateLoader: TemplateLoader;
  artifactStore: ArtifactStore;
  pathOperations: PathOperationsPort;
  memoryResolver?: MemoryResolverPort;
  templateVarsLoader: TemplateVarsLoaderPort;
  workerConfigPort: WorkerConfigPort;
  traceWriter: TraceWriterPort;
  cliBlockExecutor: CommandExecutor;
  configDir: ConfigDirResult | undefined;
  createTraceWriter: (trace: boolean, artifactContext: ArtifactContext) => TraceWriterPort;
  output: ApplicationOutputPort;
}

/**
 * Runtime options accepted by a single `discuss` command invocation.
 */
export interface DiscussTaskOptions {
  source: string;
  runId?: string;
  mode: RunnerMode;
  workerPattern: ParsedWorkerPattern;
  sortMode: SortMode;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  showAgentOutput: boolean;
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
}

/**
 * Creates the discuss task runner that renders prompts, invokes the worker,
 * restores checkbox integrity, and records discussion trace events.
 */
export function createDiscussTask(
  dependencies: DiscussTaskDependencies,
): (options: DiscussTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);
  const cliBlockExecutor = dependencies.cliBlockExecutor;

  const emitDiscussionTurnStart = (label: string): void => {
    emit({
      kind: "group-start",
      label,
      counter: {
        current: 1,
        total: 1,
      },
    });
  };

  const emitDiscussionTurnSuccess = (): void => {
    emit({ kind: "group-end", status: "success" });
  };

  const emitDiscussionTurnFailure = (message: string): void => {
    emit({ kind: "group-end", status: "failure", message });
  };

  return async function discussTask(options: DiscussTaskOptions): Promise<number> {
    const {
      source,
      runId,
      sortMode,
      dryRun,
      printPrompt,
      varsFileOption,
      cliTemplateVarArgs,
      workerPattern,
      cliBlockTimeoutMs,
    } = options;
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
    const cliExecutionOptions = cliBlockTimeoutMs === undefined
      ? { env: rundownVarEnv }
      : { timeoutMs: cliBlockTimeoutMs, env: rundownVarEnv };

    const artifactBaseDir = dependencies.configDir?.configDir;
    let selectedRun: ArtifactRunMetadata | null = null;
    let selectedRuntimeTaskMetadata: RuntimeTaskMetadata | null = null;
    let files: string[] = [];
    let lockTargets: string[] = [];
    let discussionTurnStarted = false;
    let discussionTurnEnded = false;

    if (runId) {
      selectedRun = runId === "latest"
        ? dependencies.artifactStore.latest(artifactBaseDir)
        : dependencies.artifactStore.find(runId, artifactBaseDir);

      if (!selectedRun) {
        const target = runId === "latest" ? "latest" : runId;
        emit({ kind: "error", message: "No saved runtime artifact run found for: " + target });
        return 3;
      }

      if (selectedRun.status === "metadata-missing") {
        emit({
          kind: "error",
          message: "Selected run is missing run metadata (run.json). Re-run the original task with --keep-artifacts, then retry discuss --run.",
        });
        return 3;
      }

      if (!isTerminalRunStatus(selectedRun.status)) {
        emit({
          kind: "error",
          message: "Selected run is not in a terminal state (status="
            + (selectedRun.status ?? "unknown")
            + "). Use `rundown artifacts` to choose a completed run.",
        });
        return 3;
      }

      if (!selectedRun.task) {
        emit({
          kind: "error",
          message: "Selected run has no task metadata to discuss. Choose a different run or execute tasks again to refresh artifacts.",
        });
        return 3;
      }

      const metadataError = validateRuntimeTaskMetadata(selectedRun.task);
      if (metadataError) {
        emit({
          kind: "error",
          message: "Selected run has invalid task metadata: " + metadataError
            + " Re-run the task to regenerate runtime artifacts.",
        });
        return 3;
      }

      selectedRuntimeTaskMetadata = selectedRun.task;
      const resolvedTaskFilePath = dependencies.pathOperations.isAbsolute(selectedRun.task.file)
        ? selectedRun.task.file
        : dependencies.pathOperations.resolve(cwd, selectedRun.task.file);

      if (dependencies.fileSystem.exists(resolvedTaskFilePath)) {
        lockTargets = [resolvedTaskFilePath];
      }
    } else {
      // Resolve markdown sources up front so locking and selection operate on the same set.
      files = await dependencies.sourceResolver.resolveSources(source);
      if (files.length === 0) {
        emit({ kind: "warn", message: "No Markdown files found matching: " + source });
        return 3;
      }

      // Deduplicate lock targets in case globbing or resolver behavior returns repeated paths.
      lockTargets = Array.from(new Set(files));
    }
    // Optionally clear stale lock files before acquiring fresh locks for this run.
    if (options.forceUnlock) {
      for (const filePath of lockTargets) {
        if (dependencies.fileLock.isLocked(filePath)) {
          continue;
        }

        dependencies.fileLock.forceRelease(filePath);
        emit({ kind: "info", message: "Force-unlocked stale source lock: " + filePath });
      }
    }

    let traceWriter: TraceWriterPort = dependencies.traceWriter;

    // Acquire all locks before any task selection to prevent concurrent source mutation.
    try {
      for (const filePath of lockTargets) {
        dependencies.fileLock.acquire(filePath, { command: "discuss" });
      }
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

      let taskContext: ResolvedTaskContext;
      let finishedRunPromptContext: FinishedRunPromptContext | null = null;

      if (selectedRun && selectedRuntimeTaskMetadata) {
        const runRootExists = dependencies.fileSystem.exists(selectedRun.rootDir);
        const runRootStat = dependencies.fileSystem.stat(selectedRun.rootDir);
        if (!runRootExists || runRootStat?.isDirectory !== true) {
          emit({
            kind: "error",
            message: "Selected run has no saved artifact directory: " + selectedRun.rootDir
              + ". No saved artifacts are available on disk; they may have been purged (run without --keep-artifacts).",
          });
          return 3;
        }

        const runtimeTaskContext = resolveTaskContextFromRuntimeMetadata(
          selectedRuntimeTaskMetadata,
          cwd,
          dependencies.fileSystem,
          dependencies.pathOperations,
        );
        if (runtimeTaskContext) {
          taskContext = runtimeTaskContext;
        } else {
          emit({
            kind: "info",
            message: "Could not resolve task in the current source file state; using saved run metadata from run.json.",
          });
          taskContext = createFallbackTaskContext(selectedRuntimeTaskMetadata, cwd, dependencies.pathOperations);
        }

        const phases = scanRunPhases(selectedRun.rootDir, dependencies.fileSystem, dependencies.pathOperations);
        finishedRunPromptContext = {
          run: selectedRun,
          taskMetadata: selectedRuntimeTaskMetadata,
          phases,
        };
      } else {
        // Select a single unchecked task according to configured sort behavior.
        const selectedTask = dependencies.taskSelector.selectNextTask(files, sortMode);
        if (!selectedTask) {
          emit({ kind: "info", message: "No unchecked tasks found." });
          return 3;
        }

        taskContext = resolveTaskContext(selectedTask);
      }

      // Resolve worker command and prompt template for the selected task.
      const loadedWorkerConfig = dependencies.configDir?.configDir
        ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
        : undefined;
      const resolvedWorker = resolveWorkerPatternForInvocation({
        commandName: "discuss",
        workerConfig: loadedWorkerConfig,
        source: taskContext.source,
        task: taskContext.task,
        cliWorkerPattern: workerPattern,
        emit,
      });
      const resolvedWorkerCommand = resolvedWorker.workerCommand;
      const resolvedWorkerPattern = resolvedWorker.workerPattern;
      const templates = loadProjectTemplatesFromPorts(
        dependencies.configDir,
        dependencies.templateLoader,
        dependencies.pathOperations,
      );
      const templateVarsWithMemory: ExtraTemplateVars = {
        ...extraTemplateVars,
        ...buildMemoryTemplateVars({
          memoryMetadata: dependencies.memoryResolver?.resolve(taskContext.task.file) ?? null,
        }),
      };
      const renderedPrompt = finishedRunPromptContext
        ? renderDiscussFinishedPrompt(
          templates.discussFinished,
          taskContext,
          finishedRunPromptContext,
          {
            ...templateVarsWithUserVariables,
            ...templateVarsWithMemory,
          },
        )
        : renderDiscussPrompt(templates.discuss, taskContext, {
          ...templateVarsWithUserVariables,
          ...templateVarsWithMemory,
        });
      const promptCliBlockCount = extractCliBlocks(renderedPrompt).length;
      const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
      let prompt = renderedPrompt;

      // Expand `cli` fenced blocks unless expansion is suppressed for this run mode.
      if (!options.ignoreCliBlock && !dryRunSuppressesCliExpansion) {
        const templateLabel = finishedRunPromptContext
          ? "discuss-finished template"
          : "discuss template";
        try {
          prompt = await expandCliBlocks(
            renderedPrompt,
            cliBlockExecutor,
            cwd,
            withTemplateCliFailureAbort(cliExecutionOptions, templateLabel),
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

      if (finishedRunPromptContext) {
        emit({
          kind: "info",
          message: "Finished task: " + formatTaskLabel(taskContext.task)
            + " (run "
            + finishedRunPromptContext.run.runId
            + ")",
        });
      } else {
        emit({ kind: "info", message: "Next task: " + formatTaskLabel(taskContext.task) });
      }

      if (printPrompt) {
        emit({ kind: "text", text: prompt });
        return 0;
      }

      if (dryRun) {
        if (dryRunSuppressesCliExpansion && !options.ignoreCliBlock) {
          emit({
            kind: "info",
            message: "Dry run — skipped `cli` fenced block execution; would execute "
              + promptCliBlockCount
              + " "
              + pluralize(promptCliBlockCount, "block", "blocks")
              + ".",
          });
        }
        emit({ kind: "info", message: "Dry run — would discuss with: " + resolvedWorkerCommand.join(" ") });
        emit({ kind: "info", message: "Prompt length: " + prompt.length + " chars" });
        return 0;
      }

      // Discuss execution requires a worker command from config or CLI flags.
      if (resolvedWorkerCommand.length === 0) {
        emit({
          kind: "error",
          message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.",
        });
        return 1;
      }

      // Snapshot checkbox state so discuss mode can enforce non-mutating checkbox behavior.
      const beforeCheckboxStateByFile = new Map<string, CheckboxStateSnapshot>();
      const sourceBeforeDiscussionByFile = new Map<string, string>();
      for (const filePath of lockTargets) {
        const sourceBeforeDiscussion = dependencies.fileSystem.readText(filePath);
        sourceBeforeDiscussionByFile.set(filePath, sourceBeforeDiscussion);
        beforeCheckboxStateByFile.set(filePath, captureCheckboxState(sourceBeforeDiscussion));
      }

      // Create artifact context and emit a trace start event for this discussion run.
      const artifactContext = dependencies.artifactStore.createContext({
        cwd,
        configDir: dependencies.configDir?.configDir,
        commandName: finishedRunPromptContext ? "discuss-finished" : "discuss",
        workerCommand: resolvedWorkerCommand,
        mode: "tui",
        source,
        task: {
          text: taskContext.task.text,
          file: taskContext.task.file,
          line: taskContext.task.line,
          index: taskContext.task.index,
          source: taskContext.source,
        },
        keepArtifacts: options.keepArtifacts,
      });

      traceWriter = dependencies.createTraceWriter(options.trace, artifactContext);
      const discussionStartedAtMs = Date.now();
      const discussionStartedAt = new Date().toISOString();

      traceWriter.write(createDiscussionStartedEvent({
        timestamp: discussionStartedAt,
        run_id: artifactContext.runId,
        payload: {
          task_text: taskContext.task.text,
          task_file: taskContext.task.file,
          task_line: taskContext.task.line,
        },
      }));

      if (finishedRunPromptContext) {
        traceWriter.write(createDiscussionFinishedStartedEvent({
          timestamp: discussionStartedAt,
          run_id: artifactContext.runId,
          payload: {
            task_text: taskContext.task.text,
            task_file: taskContext.task.file,
            task_line: taskContext.task.line,
            target_run_id: finishedRunPromptContext.run.runId,
            target_run_status: finishedRunPromptContext.run.status ?? "metadata-missing",
          },
        }));
      }

      const discussionTurnLabel = "Discuss turn: " + formatTaskLabel(taskContext.task);
      emitDiscussionTurnStart(discussionTurnLabel);
      discussionTurnStarted = true;

      try {
        // Invoke worker in TUI mode to collect discussion output.
        emit({
          kind: "info",
          message: "Running discussion worker: " + resolvedWorkerCommand.join(" ") + " [mode=tui]",
        });
        const result = await dependencies.workerExecutor.runWorker({
          workerPattern: resolvedWorkerPattern,
          prompt,
          mode: "tui",
          trace: options.trace,
          captureOutput: options.keepArtifacts,
          cwd,
          env: rundownVarEnv,
          configDir: dependencies.configDir?.configDir,
          artifactContext,
          artifactPhase: "discuss",
        });
        emit({
          kind: "info",
          message: "Discussion worker completed (exit "
            + (result.exitCode === null ? "null" : String(result.exitCode))
            + ").",
        });

        // Detect and immediately revert checkbox edits introduced by the discussion step.
        const checkboxMutations = detectCheckboxMutations(lockTargets, beforeCheckboxStateByFile, dependencies.fileSystem);

        if (checkboxMutations.length > 0) {
          for (const filePath of checkboxMutations) {
            const sourceBeforeDiscussion = sourceBeforeDiscussionByFile.get(filePath);
            if (typeof sourceBeforeDiscussion !== "string") {
              continue;
            }

            dependencies.fileSystem.writeText(filePath, sourceBeforeDiscussion);
          }
        }

        // Emit completion trace event with duration and worker exit details.
        traceWriter.write(createDiscussionCompletedEvent({
          timestamp: new Date().toISOString(),
          run_id: artifactContext.runId,
          payload: {
            task_text: taskContext.task.text,
            task_file: taskContext.task.file,
            task_line: taskContext.task.line,
            duration_ms: Math.max(0, Date.now() - discussionStartedAtMs),
            exit_code: result.exitCode,
          },
        }));

        if (finishedRunPromptContext) {
          traceWriter.write(createDiscussionFinishedCompletedEvent({
            timestamp: new Date().toISOString(),
            run_id: artifactContext.runId,
            payload: {
              task_text: taskContext.task.text,
              task_file: taskContext.task.file,
              task_line: taskContext.task.line,
              target_run_id: finishedRunPromptContext.run.runId,
              target_run_status: finishedRunPromptContext.run.status ?? "metadata-missing",
              duration_ms: Math.max(0, Date.now() - discussionStartedAtMs),
              exit_code: result.exitCode,
            },
          }));
        }

        // Mark artifact status as cancelled when worker fails or checkbox state mutates.
        const status = result.exitCode === 0 && checkboxMutations.length === 0
          ? (finishedRunPromptContext ? "discuss-finished-completed" : "discuss-completed")
          : (finishedRunPromptContext ? "discuss-finished-cancelled" : "discuss-cancelled");
        dependencies.artifactStore.finalize(artifactContext, {
          status,
          preserve: options.keepArtifacts,
        });

        if (options.keepArtifacts) {
          emit({
            kind: "info",
            message: "Runtime artifacts saved at " + dependencies.artifactStore.displayPath(artifactContext) + ".",
          });
        }

        if (checkboxMutations.length > 0) {
          const message = "Discussion changed checkbox state in "
            + checkboxMutations[0]
            + ". Discuss mode may rewrite task text, but must not mark/unmark checkboxes.";
          emit({
            kind: "error",
            message,
          });
          emitDiscussionTurnFailure(message);
          discussionTurnEnded = true;
          return 1;
        }

        if (result.exitCode !== 0) {
          if (result.exitCode === null) {
            const message = "Discussion failed: worker exited without a code.";
            emit({ kind: "error", message });
            emitDiscussionTurnFailure(message);
            discussionTurnEnded = true;
            return 1;
          } else {
            const message = "Discussion exited with code " + result.exitCode + ".";
            emit({ kind: "error", message });
            emitDiscussionTurnFailure(message);
            discussionTurnEnded = true;
            return result.exitCode;
          }
        }

        emitDiscussionTurnSuccess();
        discussionTurnEnded = true;
        emit({ kind: "success", message: "Discussion completed." });
        return 0;
      } catch (error) {
        if (discussionTurnStarted && !discussionTurnEnded) {
          const message = error instanceof Error ? error.message : String(error);
          emitDiscussionTurnFailure(message);
          discussionTurnEnded = true;
        }
        throw error;
      }
    } finally {
      // Flush trace output and release all source locks on every exit path.
      traceWriter.flush();
      try {
        dependencies.fileLock.releaseAll();
      } catch (error) {
        emit({ kind: "warn", message: "Failed to release file locks: " + String(error) });
      }
    }
  };
}

/**
 * Renders the discuss template with task fields, source context, and extra vars.
 */
function renderDiscussPrompt(
  template: string,
  taskContext: ResolvedTaskContext,
  extraTemplateVars: ExtraTemplateVars,
): string {
  const vars: TemplateVars = {
    ...extraTemplateVars,
    task: taskContext.task.text,
    file: taskContext.task.file,
    context: taskContext.contextBefore,
    taskIndex: taskContext.task.index,
    taskLine: taskContext.task.line,
    source: taskContext.source,
    ...buildTaskHierarchyTemplateVars(taskContext.task),
  };

  return renderTemplate(template, vars);
}

/**
 * Normalizes task selection output into the context used by discuss rendering.
 */
function resolveTaskContext(selection: TaskSelectionResult): ResolvedTaskContext {
  return {
    task: selection.task,
    source: selection.source,
    contextBefore: selection.contextBefore,
  };
}

function renderDiscussFinishedPrompt(
  template: string,
  taskContext: ResolvedTaskContext,
  finishedRunContext: FinishedRunPromptContext,
  extraTemplateVars: ExtraTemplateVars,
): string {
  return renderTemplate(
    template,
    buildDiscussFinishedTemplateVars(taskContext, finishedRunContext, extraTemplateVars),
  );
}

function buildDiscussFinishedTemplateVars(
  taskContext: ResolvedTaskContext,
  finishedRunContext: FinishedRunPromptContext,
  extraTemplateVars: ExtraTemplateVars,
): TemplateVars {
  const executionPhaseDir = finishedRunContext.phases.execute[0]?.dir ?? "(missing)";
  const taskLineFromRun = finishedRunContext.taskMetadata.line;

  return {
    ...extraTemplateVars,
    task: taskContext.task.text,
    file: taskContext.task.file,
    context: taskContext.contextBefore,
    taskIndex: taskContext.task.index,
    taskLine: taskLineFromRun,
    source: taskContext.source,
    runId: finishedRunContext.run.runId,
    runStatus: finishedRunContext.run.status ?? "unknown",
    runDir: finishedRunContext.run.rootDir,
    taskText: finishedRunContext.taskMetadata.text,
    taskFile: finishedRunContext.taskMetadata.file,
    taskLineFromRun,
    selectedTaskLine: taskContext.task.line,
    commitSha: extractCommitSha(finishedRunContext.run.extra),
    phaseSummary: formatPhaseSummary(finishedRunContext.phases.all),
    missingLogsSummary: formatMissingLogsSummary(finishedRunContext.phases.all),
    executionPhaseDir,
    verifyPhaseDirs: formatPhaseDirList(finishedRunContext.phases.verify),
    repairPhaseDirs: formatPhaseDirList(finishedRunContext.phases.repair),
    ...buildTaskHierarchyTemplateVars(taskContext.task),
  };
}

function createFallbackTaskContext(
  metadata: RuntimeTaskMetadata,
  cwd: string,
  pathOperations: PathOperationsPort,
): ResolvedTaskContext {
  const taskFilePath = pathOperations.isAbsolute(metadata.file)
    ? metadata.file
    : pathOperations.resolve(cwd, metadata.file);
  const source = metadata.source;
  const lines = source.split("\n");
  const contextBefore = lines.slice(0, Math.max(0, metadata.line - 1)).join("\n");

  return {
    task: {
      text: metadata.text,
      checked: true,
      index: metadata.index,
      line: metadata.line,
      column: 1,
      offsetStart: 0,
      offsetEnd: metadata.text.length,
      file: taskFilePath,
      isInlineCli: false,
      depth: 0,
      children: [],
      subItems: [],
    },
    source,
    contextBefore,
  };
}

function isTerminalRunStatus(status: ArtifactRunMetadata["status"]): boolean {
  return status === "completed"
    || status === "failed"
    || status === "execution-failed"
    || status === "discuss-finished-completed"
    || status === "discuss-finished-cancelled";
}

function scanRunPhases(
  runDir: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): FinishedRunPhaseScan {
  const scanned: FinishedRunScannedPhase[] = [];
  const entries = fileSystem.readdir(runDir)
    .filter((entry) => entry.isDirectory && /^\d+-/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      sequence: Number.parseInt(entry.name.split("-", 1)[0] ?? "", 10),
    }))
    .filter((entry) => Number.isFinite(entry.sequence))
    .sort((left, right) => left.sequence - right.sequence);

  for (const entry of entries) {
    const phaseDir = pathOperations.join(runDir, entry.name);
    const metadataFile = pathOperations.join(phaseDir, "metadata.json");
    if (!fileSystem.exists(metadataFile)) {
      continue;
    }

    let metadata: {
      sequence?: number;
      phase?: unknown;
      promptFile?: unknown;
      stdoutFile?: unknown;
      stderrFile?: unknown;
      exitCode?: unknown;
      verificationResult?: unknown;
    };
    try {
      metadata = JSON.parse(fileSystem.readText(metadataFile)) as {
        sequence?: number;
        phase?: unknown;
        promptFile?: unknown;
        stdoutFile?: unknown;
        stderrFile?: unknown;
        exitCode?: unknown;
        verificationResult?: unknown;
      };
    } catch {
      continue;
    }

    const phase = metadata.phase;
    if (phase !== "execute" && phase !== "verify" && phase !== "repair") {
      continue;
    }

    const promptFile = resolveOptionalArtifactPath(phaseDir, metadata.promptFile, fileSystem, pathOperations);
    const stdoutFile = resolveOptionalArtifactPath(phaseDir, metadata.stdoutFile, fileSystem, pathOperations);
    const stderrFile = resolveOptionalArtifactPath(phaseDir, metadata.stderrFile, fileSystem, pathOperations);

    scanned.push({
      sequence: typeof metadata.sequence === "number" && Number.isInteger(metadata.sequence)
        ? metadata.sequence
        : entry.sequence,
      name: entry.name,
      phase,
      dir: phaseDir,
      metadataFile,
      promptFile,
      stdoutFile,
      stderrFile,
      exitCode: typeof metadata.exitCode === "number" || metadata.exitCode === null
        ? metadata.exitCode
        : null,
      verificationResult: typeof metadata.verificationResult === "string"
        ? metadata.verificationResult
        : "",
    });
  }

  return {
    execute: scanned.filter((phase) => phase.phase === "execute"),
    verify: scanned.filter((phase) => phase.phase === "verify"),
    repair: scanned.filter((phase) => phase.phase === "repair"),
    all: scanned,
  };
}

function resolveOptionalArtifactPath(
  phaseDir: string,
  artifactName: unknown,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): string | null {
  if (typeof artifactName !== "string" || artifactName.trim() === "") {
    return null;
  }

  const artifactPath = pathOperations.join(phaseDir, artifactName);
  return fileSystem.exists(artifactPath) ? artifactPath : null;
}

function formatPhaseSummary(phases: FinishedRunScannedPhase[]): string {
  if (phases.length === 0) {
    return "No execute/verify/repair phases were discovered in this run directory.";
  }

  return phases.map((phase) => {
    const exitCodeLabel = phase.exitCode === null ? "null" : String(phase.exitCode);
    const verificationLabel = phase.verificationResult || "(n/a)";
    return "- [" + String(phase.sequence).padStart(2, "0")
      + "] "
      + phase.phase
      + " ("
      + phase.name
      + "): exit="
      + exitCodeLabel
      + ", verification="
      + verificationLabel
      + ", prompt="
      + (phase.promptFile ? "present" : "missing")
      + ", stdout="
      + (phase.stdoutFile ? "present" : "missing")
      + ", stderr="
      + (phase.stderrFile ? "present" : "missing");
  }).join("\n");
}

function formatPhaseDirList(phases: FinishedRunScannedPhase[]): string {
  if (phases.length === 0) {
    return "- (none)";
  }

  return phases
    .map((phase) => "- " + phase.dir)
    .join("\n");
}

function formatMissingLogsSummary(phases: FinishedRunScannedPhase[]): string {
  if (phases.length === 0) {
    return "No phase artifacts were discovered, so no stdout/stderr logs are available.";
  }

  const lines: string[] = [];
  for (const phase of phases) {
    const missingStreams: string[] = [];
    if (!phase.stdoutFile) {
      missingStreams.push("stdout.log");
    }
    if (!phase.stderrFile) {
      missingStreams.push("stderr.log");
    }

    if (missingStreams.length === 0) {
      continue;
    }

    lines.push(
      "- ["
        + String(phase.sequence).padStart(2, "0")
        + "] "
        + phase.phase
        + " ("
        + phase.name
        + "): missing "
        + missingStreams.join(" and ")
        + ". Output may not have been captured (for example, a TUI run without --keep-artifacts) or the files were removed.",
    );
  }

  if (lines.length === 0) {
    return "All discovered phases include stdout/stderr log files.";
  }

  return lines.join("\n");
}

function extractCommitSha(extra: Record<string, unknown> | undefined): string {
  const commitSha = extra?.commitSha;
  return typeof commitSha === "string" && commitSha.trim() !== ""
    ? commitSha
    : "(none)";
}
