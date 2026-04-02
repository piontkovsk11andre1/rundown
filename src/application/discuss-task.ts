import type { SortMode } from "../domain/sorting.js";
import type { Task } from "../domain/parser.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import {
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import {
  createDiscussionCompletedEvent,
  createDiscussionStartedEvent,
} from "../domain/trace.js";
import {
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
import { loadProjectTemplatesFromPorts } from "./project-templates.js";
import { resolveWorkerForInvocation } from "./resolve-worker.js";
import { formatTaskLabel } from "./run-task-utils.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import type { FileLock } from "../domain/ports/file-lock.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  CommandExecutor,
  FileSystem,
  ConfigDirResult,
  PathOperationsPort,
  ProcessRunMode,
  PromptTransport as PortPromptTransport,
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
 * Transport strategy used to deliver prompts to the discussion worker.
 */
export type PromptTransport = PortPromptTransport;

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
  mode: RunnerMode;
  transport: PromptTransport;
  sortMode: SortMode;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  workerCommand: string[];
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

  return async function discussTask(options: DiscussTaskOptions): Promise<number> {
    const {
      source,
      sortMode,
      dryRun,
      printPrompt,
      varsFileOption,
      cliTemplateVarArgs,
      workerCommand,
      cliBlockTimeoutMs,
    } = options;
    const cliExecutionOptions = cliBlockTimeoutMs === undefined
      ? undefined
      : { timeoutMs: cliBlockTimeoutMs };
    const cliExecutionOptionsWithTemplateFailureAbort = withTemplateCliFailureAbort(
      cliExecutionOptions,
      "discuss template",
    );

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

    // Resolve markdown sources up front so locking and selection operate on the same set.
    const files = await dependencies.sourceResolver.resolveSources(source);
    if (files.length === 0) {
      emit({ kind: "warn", message: "No Markdown files found matching: " + source });
      return 3;
    }

    // Deduplicate lock targets in case globbing or resolver behavior returns repeated paths.
    const lockTargets = Array.from(new Set(files));
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

      // Select a single unchecked task according to configured sort behavior.
      const selectedTask = dependencies.taskSelector.selectNextTask(files, sortMode);
      if (!selectedTask) {
        emit({ kind: "info", message: "No unchecked tasks found." });
        return 3;
      }

      const taskContext = resolveTaskContext(selectedTask);
      // Resolve worker command and prompt template for the selected task.
      const loadedWorkerConfig = dependencies.configDir?.configDir
        ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
        : undefined;
      const resolvedWorkerCommand = resolveWorkerForInvocation({
        commandName: "discuss",
        workerConfig: loadedWorkerConfig,
        source: taskContext.source,
        task: taskContext.task,
        cliWorkerCommand: workerCommand,
        emit,
      });
      const templates = loadProjectTemplatesFromPorts(
        dependencies.configDir,
        dependencies.templateLoader,
        dependencies.pathOperations,
      );
      const renderedPrompt = renderDiscussPrompt(templates.discuss, taskContext, extraTemplateVars);
      const promptCliBlockCount = extractCliBlocks(renderedPrompt).length;
      const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
      let prompt = renderedPrompt;

      // Expand `cli` fenced blocks unless expansion is suppressed for this run mode.
      if (!options.ignoreCliBlock && !dryRunSuppressesCliExpansion) {
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

      emit({ kind: "info", message: "Next task: " + formatTaskLabel(taskContext.task) });

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
              + " block"
              + (promptCliBlockCount === 1 ? "" : "s")
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
          message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <command...> or -- <command>.",
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
        commandName: "discuss",
        workerCommand: resolvedWorkerCommand,
        mode: "tui",
        transport: options.transport,
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

      // Invoke worker in TUI mode to collect discussion output.
      const result = await dependencies.workerExecutor.runWorker({
        command: resolvedWorkerCommand,
        prompt,
        mode: "tui",
        transport: options.transport,
        trace: options.trace,
        captureOutput: options.keepArtifacts,
        cwd,
        configDir: dependencies.configDir?.configDir,
        artifactContext,
        artifactPhase: "discuss",
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

      // Mark artifact status as cancelled when worker fails or checkbox state mutates.
      const status = result.exitCode === 0 && checkboxMutations.length === 0
        ? "discuss-completed"
        : "discuss-cancelled";
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
        emit({
          kind: "error",
          message: "Discussion changed checkbox state in "
            + checkboxMutations[0]
            + ". Discuss mode may rewrite task text, but must not mark/unmark checkboxes.",
        });
        return 1;
      }

      if (result.exitCode !== 0) {
        if (result.exitCode === null) {
          emit({ kind: "error", message: "Discussion failed: worker exited without a code." });
          return 1;
        } else {
          emit({ kind: "error", message: "Discussion exited with code " + result.exitCode + "." });
          return result.exitCode;
        }
      }

      emit({ kind: "success", message: "Discussion completed." });
      return 0;
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
