import type { SortMode } from "../domain/sorting.js";
import type { Task } from "../domain/parser.js";
import { DEFAULT_DISCUSS_TEMPLATE } from "../domain/defaults.js";
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
import { resolveWorkerForInvocation } from "./resolve-worker.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import type { FileLock } from "../domain/ports/file-lock.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  CommandExecutionOptions,
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
export type PromptTransport = PortPromptTransport;
type ArtifactContext = ArtifactRunContext;

interface ProjectTemplates {
  discuss: string;
}

interface ResolvedTaskContext {
  task: Task;
  source: string;
  contextBefore: string;
}

interface CheckboxStateSnapshot {
  orderedStates: boolean[];
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

type TaskSelectionResult = PortTaskSelectionResult;

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
  hideAgentOutput: boolean;
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
}

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
      templateCliFailureHandler("discuss template"),
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

    const files = await dependencies.sourceResolver.resolveSources(source);
    if (files.length === 0) {
      emit({ kind: "warn", message: "No Markdown files found matching: " + source });
      return 3;
    }

    const lockTargets = Array.from(new Set(files));
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

      const selectedTask = dependencies.taskSelector.selectNextTask(files, sortMode);
      if (!selectedTask) {
        emit({ kind: "info", message: "No unchecked tasks found." });
        return 3;
      }

      const taskContext = resolveTaskContext(selectedTask);
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

      if (resolvedWorkerCommand.length === 0) {
        emit({
          kind: "error",
          message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <command...> or -- <command>.",
        });
        return 1;
      }

      const beforeCheckboxStateByFile = new Map<string, CheckboxStateSnapshot>();
      const sourceBeforeDiscussionByFile = new Map<string, string>();
      for (const filePath of lockTargets) {
        const sourceBeforeDiscussion = dependencies.fileSystem.readText(filePath);
        sourceBeforeDiscussionByFile.set(filePath, sourceBeforeDiscussion);
        beforeCheckboxStateByFile.set(filePath, captureCheckboxState(sourceBeforeDiscussion));
      }

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

      if (!options.hideAgentOutput && !options.keepArtifacts) {
        if (result.stdout) {
          emit({ kind: "text", text: result.stdout });
        }
        if (result.stderr) {
          emit({ kind: "stderr", text: result.stderr });
        }
      }

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
      traceWriter.flush();
      try {
        dependencies.fileLock.releaseAll();
      } catch (error) {
        emit({ kind: "warn", message: "Failed to release file locks: " + String(error) });
      }
    }
  };
}

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

function loadProjectTemplatesFromPorts(
  configDir: ConfigDirResult | undefined,
  templateLoader: TemplateLoader,
  pathOperations: PathOperationsPort,
): ProjectTemplates {
  if (!configDir) {
    return {
      discuss: DEFAULT_DISCUSS_TEMPLATE,
    };
  }

  const dir = configDir.configDir;
  return {
    discuss: templateLoader.load(pathOperations.join(dir, "discuss.md")) ?? DEFAULT_DISCUSS_TEMPLATE,
  };
}

function resolveTaskContext(selection: TaskSelectionResult): ResolvedTaskContext {
  return {
    task: selection.task,
    source: selection.source,
    contextBefore: selection.contextBefore,
  };
}

function formatTaskLabel(task: Task): string {
  return `${task.file}:${task.line} [#${task.index}] ${task.text}`;
}

function captureCheckboxState(source: string): CheckboxStateSnapshot {
  const checkboxPattern = /^(\s*[-*+]\s+)\[([ xX])\](\s+\S.*)$/;
  const lines = source.split(/\r?\n/);
  const orderedStates: boolean[] = [];

  for (const line of lines) {
    const match = line.match(checkboxPattern);
    if (!match) {
      continue;
    }

    const checked = /[xX]/.test(match[2]);
    orderedStates.push(checked);
  }

  return {
    orderedStates,
  };
}

function detectCheckboxMutations(
  files: string[],
  beforeByFile: Map<string, CheckboxStateSnapshot>,
  fileSystem: FileSystem,
): string[] {
  const mutatedFiles: string[] = [];

  for (const filePath of files) {
    const before = beforeByFile.get(filePath);
    if (!before) {
      continue;
    }

    const after = captureCheckboxState(fileSystem.readText(filePath));
    const comparableCount = Math.min(before.orderedStates.length, after.orderedStates.length);
    let hasMutation = false;

    for (let index = 0; index < comparableCount; index += 1) {
      if (before.orderedStates[index] !== after.orderedStates[index]) {
        hasMutation = true;
        break;
      }
    }

    if (hasMutation) {
      mutatedFiles.push(filePath);
    }
  }

  return mutatedFiles;
}
