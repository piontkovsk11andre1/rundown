import { markUnchecked } from "../domain/checkbox.js";
import {
  DEFAULT_UNDO_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
} from "../domain/defaults.js";
import {
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import type {
  ArtifactRunMetadata,
  ArtifactStore,
  ConfigDirResult,
  FileSystem,
  GitClient,
  PathOperationsPort,
  TaskVerificationPort,
  TemplateLoader,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { findTaskByFallback } from "./task-context-resolution.js";
import { parseTasks, type Task } from "../domain/parser.js";
import {
  isGitRepoWithGitClient,
  isWorkingDirectoryClean,
} from "./git-operations.js";

export interface UndoTaskDependencies {
  artifactStore: ArtifactStore;
  workerExecutor: WorkerExecutorPort;
  taskVerification: TaskVerificationPort;
  fileSystem: FileSystem;
  gitClient: GitClient;
  templateLoader: TemplateLoader;
  workingDirectory: WorkingDirectoryPort;
  pathOperations: PathOperationsPort;
  configDir?: ConfigDirResult;
  output: ApplicationOutputPort;
}

export interface UndoTaskOptions {
  runId: string;
  last?: number;
  workerPattern: ParsedWorkerPattern;
  force?: boolean;
  dryRun?: boolean;
  keepArtifacts?: boolean;
  showAgentOutput?: boolean;
}

export function createUndoTask(
  dependencies: UndoTaskDependencies,
): (options: UndoTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function undoTask(options: UndoTaskOptions): Promise<number> {
    const {
      runId,
      last,
      workerPattern,
      force = false,
      dryRun = false,
      keepArtifacts = false,
      showAgentOutput = false,
    } = options;

    if (last !== undefined && (!Number.isInteger(last) || last < 1)) {
      emit({ kind: "error", message: "--last must be a positive integer." });
      return EXIT_CODE_FAILURE;
    }

    if (last !== undefined && runId !== "latest") {
      emit({ kind: "error", message: "Cannot combine --run <id> with --last." });
      return EXIT_CODE_FAILURE;
    }

    const cwd = dependencies.workingDirectory.cwd();
    const configDirPath = dependencies.configDir?.configDir;
    const targetRuns = resolveTargetRuns(dependencies.artifactStore, configDirPath, {
      runId,
      last,
    });

    if (targetRuns.length === 0) {
      emit({ kind: "error", message: "No completed runs with task metadata found to undo." });
      return EXIT_CODE_NO_WORK;
    }

    if (dryRun) {
      emit({ kind: "info", message: "Dry run - would undo " + targetRuns.length + " run(s)." });
      return EXIT_CODE_SUCCESS;
    }

    if (force) {
      emit({
        kind: "info",
        message: "--force enabled: skipping clean-worktree precondition check.",
      });
    } else {
      const inGitRepo = await isGitRepoWithGitClient(dependencies.gitClient, cwd);
      if (!inGitRepo) {
        emit({
          kind: "error",
          message: "Undo cannot proceed safely outside a git repository. Initialize git and commit/stash your current changes before retrying, or rerun with --force to bypass this safety check.",
        });
        return EXIT_CODE_FAILURE;
      }

      const isClean = await isWorkingDirectoryClean(
        dependencies.gitClient,
        cwd,
        dependencies.configDir,
        dependencies.pathOperations,
      );
      if (!isClean) {
        emit({
          kind: "error",
          message: "Working directory is not clean. Commit or stash changes, then retry `rundown undo` (or `rundown migrate down`). Use --force to bypass this safety check.",
        });
        return EXIT_CODE_FAILURE;
      }
    }

    const templatePath = dependencies.pathOperations.join(
      configDirPath ?? cwd,
      "undo.md",
    );
    const undoTemplate = dependencies.templateLoader.load(templatePath) ?? DEFAULT_UNDO_TEMPLATE;

    const artifactContext = dependencies.artifactStore.createContext({
      cwd,
      configDir: configDirPath,
      commandName: "undo",
      workerCommand: workerPattern.command,
      mode: "wait",
      source: targetRuns[0]?.source,
      task: targetRuns.length === 1 ? targetRuns[0]?.task : undefined,
      keepArtifacts,
    });

    const undoneRunIds: string[] = [];
    try {
      for (const run of targetRuns) {
        if (!run.task) {
          throw new Error("Run " + run.runId + " has no task metadata.");
        }

        const taskFilePath = toAbsoluteTaskFilePath(run.task.file, cwd, dependencies.pathOperations);
        if (!dependencies.fileSystem.exists(taskFilePath)) {
          throw new Error("Task file does not exist: " + taskFilePath);
        }

        const sourceBeforeUndo = dependencies.fileSystem.readText(taskFilePath);
        const resolvedTask = resolveUndoTask(sourceBeforeUndo, taskFilePath, run);
        if (!resolvedTask) {
          throw new Error("Could not resolve task in source file for run " + run.runId + ".");
        }

        if (!resolvedTask.checked) {
          throw new Error("Task is already unchecked for run " + run.runId + ".");
        }

        const promptVars: TemplateVars = {
          task: run.task.text,
          file: taskFilePath,
          context: sourceBeforeUndo,
          taskIndex: resolvedTask.index,
          taskLine: resolvedTask.line,
          source: sourceBeforeUndo,
          taskText: run.task.text,
          executionOutput: readExecutionOutput(run),
        };
        const prompt = renderTemplate(undoTemplate, promptVars);
        const workerResult = await dependencies.workerExecutor.runWorker({
          workerPattern,
          prompt,
          mode: "wait",
          cwd,
          artifactContext,
          artifactPhase: "worker",
          artifactPhaseLabel: "undo",
        });

        if (showAgentOutput) {
          if (workerResult.stdout.length > 0) {
            emit({ kind: "text", text: workerResult.stdout });
          }
          if (workerResult.stderr.length > 0) {
            emit({ kind: "stderr", text: workerResult.stderr });
          }
        }

        if ((workerResult.exitCode ?? 1) !== 0) {
          throw new Error("Undo worker failed for run " + run.runId + ".");
        }

        const sourceAfterUndo = markUnchecked(sourceBeforeUndo, resolvedTask);
        dependencies.fileSystem.writeText(taskFilePath, sourceAfterUndo);

        const verifyResult = await dependencies.taskVerification.verify({
          task: resolvedTask,
          source: sourceAfterUndo,
          contextBefore: sourceAfterUndo.split(/\r?\n/).slice(0, resolvedTask.line - 1).join("\n"),
          template: DEFAULT_VERIFY_TEMPLATE,
          workerPattern,
          mode: "wait",
          cwd,
          configDir: configDirPath,
          artifactContext,
        });

        if (!verifyResult.valid) {
          dependencies.fileSystem.writeText(taskFilePath, sourceBeforeUndo);
          throw new Error("Undo verification failed for run " + run.runId + ".");
        }

        undoneRunIds.push(run.runId);
      }

      dependencies.artifactStore.finalize(artifactContext, {
        status: "completed",
        preserve: keepArtifacts,
        extra: {
          undoneRunIds,
          undoneCount: undoneRunIds.length,
        },
      });
      emit({ kind: "success", message: "Undid " + undoneRunIds.length + " run(s) successfully." });
      return EXIT_CODE_SUCCESS;
    } catch (error) {
      dependencies.artifactStore.finalize(artifactContext, {
        status: "failed",
        preserve: keepArtifacts,
        extra: {
          undoneRunIds,
          undoneCount: undoneRunIds.length,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      emit({ kind: "error", message: String(error) });
      return EXIT_CODE_FAILURE;
    }
  };
}

function resolveTargetRuns(
  artifactStore: ArtifactStore,
  configDir: string | undefined,
  options: Pick<UndoTaskOptions, "runId" | "last">,
): ArtifactRunMetadata[] {
  const { runId, last } = options;

  if (last !== undefined) {
    return artifactStore
      .listSaved(configDir)
      .filter((run) => run.status === "completed" && run.task)
      .slice(0, last);
  }

  if (runId === "latest") {
    const latest = artifactStore
      .listSaved(configDir)
      .find((run) => run.status === "completed" && run.task);
    return latest ? [latest] : [];
  }

  const selected = artifactStore.find(runId, configDir);
  if (!selected || selected.status !== "completed" || !selected.task) {
    return [];
  }

  return [selected];
}

function toAbsoluteTaskFilePath(
  taskFile: string,
  cwd: string,
  pathOperations: PathOperationsPort,
): string {
  return pathOperations.isAbsolute(taskFile)
    ? taskFile
    : pathOperations.resolve(cwd, taskFile);
}

function resolveUndoTask(
  source: string,
  filePath: string,
  run: ArtifactRunMetadata,
): Task | null {
  if (!run.task) {
    return null;
  }

  const tasks = parseTasks(source, filePath);
  return findTaskByFallback(tasks, {
    text: run.task.text,
    file: filePath,
    line: run.task.line,
    index: run.task.index,
    source: run.task.source,
  });
}

function readExecutionOutput(run: ArtifactRunMetadata): string {
  const value = run.extra?.["executionOutput"];
  return typeof value === "string" ? value : "";
}
