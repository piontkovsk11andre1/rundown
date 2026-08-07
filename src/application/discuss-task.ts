import type { SortMode } from "../domain/sorting.js";
import type { Task } from "../domain/parser.js";
import { parseTasks } from "../domain/parser.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import {
  buildMemoryTemplateVars,
  buildTaskHierarchyTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import {
  createDiscussionCompletedEvent,
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
  buildWorkspaceContextTemplateVars,
  mergeTemplateVarsWithWorkspaceContext,
  resolveRuntimeWorkspaceContext,
} from "./runtime-workspace-context.js";
import {
  resolvePredictionWorkspacePaths,
  resolveWorkspaceDirectories,
  resolveWorkspaceMounts,
  resolveWorkspacePaths,
} from "./workspace-paths.js";
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
import {
  formatSuccessFailureSummary,
  formatTaskLabel,
} from "./run-task-utils.js";
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
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import { msg, type LocaleMessages } from "../domain/locale.js";

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

interface RelatedRunCandidate {
  run: ArtifactRunMetadata;
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
  localeMessages?: LocaleMessages;
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
  verbose?: boolean;
}

/**
 * Creates the discuss task runner that renders prompts, invokes the worker,
 * restores checkbox integrity, and records discussion trace events.
 */
export function createDiscussTask(
  dependencies: DiscussTaskDependencies,
): (options: DiscussTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);
  const localeMessages = dependencies.localeMessages ?? {};
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
      sortMode,
      dryRun,
      printPrompt,
      varsFileOption,
      cliTemplateVarArgs,
      workerPattern,
      cliBlockTimeoutMs,
      verbose = false,
      mode,
    } = options;
    const varsFilePath = resolveTemplateVarsFilePath(
      varsFileOption,
      dependencies.configDir?.configDir,
    );
    const cwd = dependencies.workingDirectory.cwd();
    const runtimeWorkspaceContext = resolveRuntimeWorkspaceContext(
      {
        executionCwd: cwd,
      },
      dependencies.pathOperations,
    );
    const workspaceDirectories = resolveWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
    });
    const workspacePaths = resolveWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
      invocationRoot: runtimeWorkspaceContext.invocationDir,
    });
    const predictionPaths = resolvePredictionWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
      invocationRoot: runtimeWorkspaceContext.invocationDir,
    });
    const workspaceMounts = resolveWorkspaceMounts({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
      invocationRoot: runtimeWorkspaceContext.invocationDir,
    });
    const workspaceContextTemplateVars = buildWorkspaceContextTemplateVars(
      runtimeWorkspaceContext,
      {
        directories: workspaceDirectories,
        paths: workspacePaths,
        predictionPaths,
        mounts: workspaceMounts,
      },
    );
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
    const cliExecutionOptions = cliBlockTimeoutMs === undefined
      ? { env: rundownVarEnv }
      : { timeoutMs: cliBlockTimeoutMs, env: rundownVarEnv };

    const artifactBaseDir = dependencies.configDir?.configDir;
    let files: string[] = [];
    let lockTargets: string[] = [];
    let discussionTurnStarted = false;
    let discussionTurnEnded = false;
    let discussionSuccessCount = 0;
    let discussionFailureCount = 0;
    let discussionSummaryEmitted = false;

    const emitDiscussionSummary = (): void => {
      if (!discussionTurnStarted || discussionSummaryEmitted) {
        return;
      }

      emit({
        kind: "info",
        message: formatSuccessFailureSummary("Discuss turn", discussionSuccessCount, discussionFailureCount),
      });
      discussionSummaryEmitted = true;
    };

    // Resolve markdown sources up front so locking and selection operate on the same set.
    files = await dependencies.sourceResolver.resolveSources(source);
    if (files.length === 0) {
      emit({
        kind: "warn",
        message: msg("discuss.no-markdown-found", { source }, localeMessages),
      });
      return EXIT_CODE_NO_WORK;
    }

    // Deduplicate lock targets in case globbing or resolver behavior returns repeated paths.
    lockTargets = Array.from(new Set(files));
    // Optionally clear stale lock files before acquiring fresh locks for this run.
    if (options.forceUnlock) {
      for (const filePath of lockTargets) {
        if (dependencies.fileLock.isLocked(filePath)) {
          continue;
        }

        dependencies.fileLock.forceRelease(filePath);
        emit({
          kind: "info",
          message: msg("discuss.force-unlocked", { filePath }, localeMessages),
        });
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
          message: msg("discuss.lock-error", {
            filePath: error.filePath,
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

      let taskContext: ResolvedTaskContext;
      let relatedRunsSummary = "No saved run artifacts found for this file.";

      // Select a single unchecked task according to configured sort behavior.
      const selectedBatch = dependencies.taskSelector.selectNextTask(files, sortMode);
      if (!selectedBatch || selectedBatch.length === 0) {
        taskContext = resolveFileDiscussContext(files[0]!, dependencies.fileSystem);
      } else {
        const selectedTask = selectedBatch[0]!;
        taskContext = resolveTaskContext(selectedTask);
      }

      const selectedTaskFile = dependencies.pathOperations.isAbsolute(taskContext.task.file)
        ? dependencies.pathOperations.resolve(taskContext.task.file)
        : dependencies.pathOperations.resolve(cwd, taskContext.task.file);
      const savedRuns = dependencies.artifactStore.listSaved(artifactBaseDir);
      const failedRuns = dependencies.artifactStore.listFailed(artifactBaseDir);
      const relatedRuns = savedRuns
        .concat(failedRuns)
        .filter((run) => matchesDiscussFileRun(
          run,
          selectedTaskFile,
          cwd,
          dependencies.pathOperations,
        ))
        .filter((run, index, runs) => runs.findIndex((candidate) => candidate.runId === run.runId) === index)
        .sort((left, right) => compareStartedAtDesc(left.startedAt, right.startedAt))
        .map((run) => ({ run }));

      relatedRunsSummary = buildRelatedRunsSummary(
        relatedRuns,
      );

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
        mode,
      });
      const resolvedWorkerCommand = resolvedWorker.workerCommand;
      const resolvedWorkerPattern = resolvedWorker.workerPattern;
      const workerTimeoutMs = loadedWorkerConfig?.workerTimeoutMs;
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
      const renderedPrompt = renderDiscussPrompt(templates.discuss, taskContext, {
        ...templateVarsWithUserVariables,
        ...templateVarsWithMemory,
      }, relatedRunsSummary);
      const promptCliBlockCount = extractCliBlocks(renderedPrompt).length;
      const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
      let prompt = renderedPrompt;

      // Expand `cli` fenced blocks unless expansion is suppressed for this run mode.
      if (!options.ignoreCliBlock && !dryRunSuppressesCliExpansion) {
        const templateLabel = "discuss template";
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
              message: msg("discuss.cli-block-failed", {
                location: error.templateLabel,
                code: exitCodeLabel,
                command: error.command,
              }, localeMessages),
            });
            return EXIT_CODE_FAILURE;
          }
          throw error;
        }
      }

      if (verbose) {
        emit({
          kind: "info",
          message: msg("discuss.next-verbose", { label: formatTaskLabel(taskContext.task) }, localeMessages),
        });
      }

      if (printPrompt) {
        emit({ kind: "text", text: prompt });
        return EXIT_CODE_SUCCESS;
      }

      if (dryRun) {
        if (dryRunSuppressesCliExpansion && !options.ignoreCliBlock) {
          emit({
            kind: "info",
            message: msg("discuss.dry-run-cli-skipped", { count: String(promptCliBlockCount) }, localeMessages),
          });
        }
        emit({
          kind: "info",
          message: msg("discuss.dry-run-would-run", { command: resolvedWorkerCommand.join(" ") }, localeMessages),
        });
        emit({
          kind: "info",
          message: msg("discuss.prompt-length", { length: String(prompt.length) }, localeMessages),
        });
        return EXIT_CODE_SUCCESS;
      }

      // Discuss execution requires a worker command from config or CLI flags.
      if (resolvedWorkerCommand.length === 0) {
        emit({
          kind: "error",
          message: msg("discuss.no-worker", {}, localeMessages),
        });
        return EXIT_CODE_FAILURE;
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

      const discussionTurnLabel = msg("discuss.group-label", {
        label: formatTaskLabel(taskContext.task),
      }, localeMessages);
      emitDiscussionTurnStart(discussionTurnLabel);
      discussionTurnStarted = true;

      try {
        // Invoke worker in TUI mode to collect discussion output.
        emit({ kind: "progress", progress: { label: "discuss" } });
        if (verbose) {
          emit({
            kind: "info",
            message: msg("discuss.worker-running-verbose", {
              command: resolvedWorkerCommand.join(" "),
            }, localeMessages),
          });
        }
        const result = await dependencies.workerExecutor.runWorker({
          workerPattern: resolvedWorkerPattern,
          prompt,
          mode: "tui",
          trace: options.trace,
          captureOutput: options.keepArtifacts,
          cwd,
          env: rundownVarEnv,
          configDir: dependencies.configDir?.configDir,
          timeoutMs: workerTimeoutMs,
          artifactContext,
          artifactPhase: "discuss",
        });
        if (verbose) {
          emit({
            kind: "info",
            message: msg("discuss.worker-done-verbose", {
              code: result.exitCode === null ? "null" : String(result.exitCode),
            }, localeMessages),
          });
        }

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
            message: msg("discuss.artifacts-saved", {
              path: dependencies.artifactStore.displayPath(artifactContext),
            }, localeMessages),
          });
        }

        if (checkboxMutations.length > 0) {
          const message = msg("discuss.checkbox-changed", { filePath: checkboxMutations[0] ?? "" }, localeMessages);
          emit({
            kind: "error",
            message,
          });
          emitDiscussionTurnFailure(message);
          discussionFailureCount += 1;
          discussionTurnEnded = true;
          return EXIT_CODE_FAILURE;
        }

        if (result.exitCode !== 0) {
          if (result.exitCode === null) {
            const message = "Discussion failed: worker exited without a code.";
            emit({ kind: "error", message });
            emitDiscussionTurnFailure(message);
            discussionFailureCount += 1;
            discussionTurnEnded = true;
            return EXIT_CODE_FAILURE;
          } else {
            const message = "Discussion exited with code " + result.exitCode + ".";
            emit({ kind: "error", message });
            emitDiscussionTurnFailure(message);
            discussionFailureCount += 1;
            discussionTurnEnded = true;
            return EXIT_CODE_FAILURE;
          }
        }

        emitDiscussionTurnSuccess();
        discussionSuccessCount += 1;
        discussionTurnEnded = true;
        emit({ kind: "success", message: "Discussion completed." });
        return EXIT_CODE_SUCCESS;
      } catch (error) {
        if (discussionTurnStarted && !discussionTurnEnded) {
          const message = error instanceof Error ? error.message : String(error);
          emitDiscussionTurnFailure(message);
          discussionFailureCount += 1;
          discussionTurnEnded = true;
        }
        throw error;
      } finally {
        emitDiscussionSummary();
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
  relatedRunsSummary: string,
): string {
  const vars: TemplateVars = {
    ...extraTemplateVars,
    task: taskContext.task.text,
    file: taskContext.task.file,
    context: taskContext.contextBefore,
    taskIndex: taskContext.task.index,
    taskLine: taskContext.task.line,
    source: taskContext.source,
    relatedRunsSummary,
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

function resolveFileDiscussContext(filePath: string, fileSystem: FileSystem): ResolvedTaskContext {
  const source = fileSystem.readText(filePath);
  const parsedTasks = parseTasks(source, filePath);
  const anchorTask = parsedTasks[0] ?? createFallbackDiscussAnchorTask(filePath, source);
  const contextBefore = source.split("\n").slice(0, Math.max(0, anchorTask.line - 1)).join("\n");

  return {
    task: anchorTask,
    source,
    contextBefore,
  };
}

function createFallbackDiscussAnchorTask(filePath: string, source: string): Task {
  return {
    text: "Discuss file context and related artifacts",
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: source.length,
    file: filePath,
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}

function compareStartedAtDesc(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);

  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
    return rightMs - leftMs;
  }

  if (Number.isFinite(leftMs)) {
    return -1;
  }

  if (Number.isFinite(rightMs)) {
    return 1;
  }

  return right.localeCompare(left);
}

function matchesDiscussFileRun(
  run: ArtifactRunMetadata,
  selectedTaskFile: string,
  cwd: string,
  pathOperations: PathOperationsPort,
): boolean {
  const selectedTaskFilePath = pathOperations.isAbsolute(selectedTaskFile)
    ? pathOperations.resolve(selectedTaskFile)
    : pathOperations.resolve(cwd, selectedTaskFile);
  const relatedRunFilePaths = collectRunFileMetadataPaths(run, cwd, pathOperations);
  return relatedRunFilePaths.includes(selectedTaskFilePath);
}

function collectRunFileMetadataPaths(
  run: ArtifactRunMetadata,
  cwd: string,
  pathOperations: PathOperationsPort,
): string[] {
  const relatedFilePaths: string[] = [];
  const runTaskFile = run.task?.file;
  if (typeof runTaskFile === "string" && runTaskFile.trim() !== "") {
    relatedFilePaths.push(pathOperations.isAbsolute(runTaskFile)
      ? pathOperations.resolve(runTaskFile)
      : pathOperations.resolve(cwd, runTaskFile));
  }

  const sourcePath = resolveRunSourcePath(run.source, cwd, pathOperations);
  if (sourcePath !== null) {
    relatedFilePaths.push(sourcePath);
  }

  return Array.from(new Set(relatedFilePaths));
}

function resolveRunSourcePath(
  source: string | undefined,
  cwd: string,
  pathOperations: PathOperationsPort,
): string | null {
  if (typeof source !== "string") {
    return null;
  }

  const trimmedSource = source.trim();
  if (trimmedSource === "") {
    return null;
  }

  if (trimmedSource.includes("\n") || trimmedSource.includes("\r")) {
    return null;
  }

  if (/[\*\?\[\]\{\}]/.test(trimmedSource)) {
    return null;
  }

  return pathOperations.isAbsolute(trimmedSource)
    ? pathOperations.resolve(trimmedSource)
    : pathOperations.resolve(cwd, trimmedSource);
}

function buildRelatedRunsSummary(
  candidates: RelatedRunCandidate[],
): string {
  if (candidates.length === 0) {
    return "No saved run artifacts found for this file.";
  }

  const header = [
    "Related saved artifacts:",
    "- format: run id | command | status | started | completed | artifact dir | label",
  ];
  const rows = candidates.map((candidate) => {
    const run = candidate.run;
    const shortLabel = resolveRelatedRunLabel(run);
    return "- "
      + run.runId
      + " | "
      + run.commandName
      + " | "
      + (run.status ?? "unknown")
      + " | "
      + (run.startedAt.trim() === "" ? "(n/a)" : run.startedAt)
      + " | "
      + (typeof run.completedAt === "string" && run.completedAt.trim() !== "" ? run.completedAt : "(n/a)")
      + " | "
      + run.rootDir
      + " | "
      + (shortLabel ?? "");
  });

  return [...header, ...rows].join("\n");
}

function resolveRelatedRunLabel(run: ArtifactRunMetadata): string | null {
  const extraLabel = run.extra?.label;
  if (typeof extraLabel === "string" && extraLabel.trim() !== "") {
    return extraLabel.trim();
  }

  const taskText = run.task?.text;
  if (typeof taskText !== "string") {
    return null;
  }

  const normalizedTaskText = taskText.trim();
  if (normalizedTaskText === "") {
    return null;
  }

  return normalizedTaskText.length <= 72
    ? normalizedTaskText
    : normalizedTaskText.slice(0, 69) + "...";
}
