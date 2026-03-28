import {
  DEFAULT_REPAIR_TEMPLATE,
  getTraceInstructions,
  DEFAULT_VERIFY_TEMPLATE,
} from "../domain/defaults.js";
import { type Task, parseTasks } from "../domain/parser.js";
import { resolveRunBehavior } from "../domain/run-options.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import {
  createRunCompletedEvent,
  createRunStartedEvent,
} from "../domain/trace.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import type {
  ArtifactStoreStatus,
  ArtifactRunMetadata,
  ArtifactStore,
  FileSystem,
  PathOperationsPort,
  PromptTransport,
  TaskRepairPort,
  TaskVerificationPort,
  TemplateLoader,
  TraceWriterPort,
  VerificationSidecar,
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
  vars: TemplateVars;
  verificationPrompt: string;
}

export interface ReverifyTaskDependencies {
  artifactStore: ArtifactStore;
  taskVerification: TaskVerificationPort;
  taskRepair: TaskRepairPort;
  verificationSidecar: VerificationSidecar;
  workingDirectory: WorkingDirectoryPort;
  fileSystem: FileSystem;
  // Intentionally no FileLock dependency: reverify reads markdown to resolve context,
  // but does not mutate source files.
  traceWriter: TraceWriterPort;
  createTraceWriter: (trace: boolean, artifactContext: { rootDir: string }) => TraceWriterPort;
  pathOperations: PathOperationsPort;
  templateLoader: TemplateLoader;
  output: ApplicationOutputPort;
}

export interface ReverifyTaskOptions {
  runId: string;
  last?: number;
  all?: boolean;
  transport: PromptTransport;
  repairAttempts: number;
  noRepair: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  workerCommand: string[];
  trace: boolean;
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
      transport,
      repairAttempts,
      noRepair,
      dryRun,
      printPrompt,
      keepArtifacts,
      workerCommand,
      trace,
    } = options;

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

      const templates = loadProjectTemplates(cwd, dependencies.templateLoader, dependencies.pathOperations);
      const promptContext = buildReverifyPromptContext(taskContext, templates.verify, trace);

      if (printPrompt) {
        emit({ kind: "text", text: promptContext.verificationPrompt });
        return { exitCode: 0, status: null };
      }

      const effectiveWorkerCommand = workerCommand.length > 0
        ? workerCommand
        : selectedRun.workerCommand ?? [];

      if (dryRun) {
        emit({ kind: "info", message: "Dry run - would run verification with: " + effectiveWorkerCommand.join(" ") });
        emit({ kind: "info", message: "Prompt length: " + promptContext.verificationPrompt.length + " chars" });
        return { exitCode: 0, status: null };
      }

      if (effectiveWorkerCommand.length === 0) {
        emit({ kind: "error", message: "No worker command specified. Use --worker <command...> or -- <command>." });
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
        const valid = await runVerifyRepairLoop({
          taskVerification: dependencies.taskVerification,
          taskRepair: dependencies.taskRepair,
          verificationSidecar: dependencies.verificationSidecar,
          traceWriter,
          output: dependencies.output,
        }, {
          task: taskContext.task,
          source: taskContext.source,
          contextBefore: taskContext.contextBefore,
          verifyTemplate: templates.verify,
          repairTemplate: templates.repair,
          workerCommand: effectiveWorkerCommand,
          transport,
          maxRepairAttempts: runBehavior.maxRepairAttempts,
          allowRepair: runBehavior.allowRepair,
          templateVars: promptContext.vars,
          artifactContext,
          trace,
        });

        if (!valid) {
          emit({ kind: "error", message: "Verification failed after all repair attempts." });
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

    const targetRuns = resolveTargetRuns(dependencies.artifactStore, cwd, { runId, last, all });
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
  cwd: string,
  templateLoader: TemplateLoader,
  pathOperations: PathOperationsPort,
): ReverifyTemplates {
  return {
    verify: templateLoader.load(pathOperations.join(cwd, ".rundown", "verify.md")) ?? DEFAULT_VERIFY_TEMPLATE,
    repair: templateLoader.load(pathOperations.join(cwd, ".rundown", "repair.md")) ?? DEFAULT_REPAIR_TEMPLATE,
  };
}

function resolveTargetRunMetadata(
  artifactStore: ArtifactStore,
  cwd: string,
  runId: string,
): ArtifactRunMetadata | null {
  if (runId === "latest") {
    const runs = artifactStore.listSaved(cwd);
    return runs.find((run) => isCompletedRun(run) && hasReverifiableTask(run)) ?? null;
  }

  return artifactStore.find(runId, cwd);
}

function resolveTargetRuns(
  artifactStore: ArtifactStore,
  cwd: string,
  options: Pick<ReverifyTaskOptions, "runId" | "last" | "all">,
): ArtifactRunMetadata[] {
  const { runId, last, all } = options;

  if (all) {
    return artifactStore
      .listSaved(cwd)
      .filter((run) => isCompletedRun(run) && hasReverifiableTask(run));
  }

  if (last !== undefined) {
    return artifactStore
      .listSaved(cwd)
      .filter((run) => isCompletedRun(run) && hasReverifiableTask(run))
      .slice(0, last);
  }

  const selectedRun = resolveTargetRunMetadata(artifactStore, cwd, runId);
  return selectedRun ? [selectedRun] : [];
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
  verifyTemplate: string,
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
  };

  return {
    vars,
    verificationPrompt: renderTemplate(verifyTemplate, vars),
  };
}

function formatTaskLabel(task: Task): string {
  return `${task.file}:${task.line} [#${task.index}] ${task.text}`;
}

function formatTaskMetadataLabel(task: RuntimeTaskMetadata): string {
  return `${task.file}:${task.line} [#${task.index}] ${task.text}`;
}

export const reverifyTask = createReverifyTask;
