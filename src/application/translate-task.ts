import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import {
  createOutputVolumeEvent,
  createPhaseCompletedEvent,
  createPhaseStartedEvent,
  createRunCompletedEvent,
  createRunStartedEvent,
  type TraceRunStatus,
} from "../domain/trace.js";
import { countTraceLines } from "./run-task-utils.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";
import { loadProjectTemplatesFromPorts } from "./project-templates.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  ArtifactStoreStatus,
  ConfigDirResult,
  FileLock,
  FileSystem,
  PathOperationsPort,
  ProcessRunMode,
  TemplateLoader,
  TraceWriterPort,
  WorkerConfigPort,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

type ArtifactContext = ArtifactRunContext;

export type RunnerMode = ProcessRunMode;

export interface TranslateTaskDependencies {
  workerExecutor: WorkerExecutorPort;
  workingDirectory: WorkingDirectoryPort;
  fileSystem: FileSystem;
  fileLock: FileLock;
  workerConfigPort: WorkerConfigPort;
  templateLoader: TemplateLoader;
  pathOperations: PathOperationsPort;
  artifactStore: ArtifactStore;
  traceWriter: TraceWriterPort;
  configDir: ConfigDirResult | undefined;
  createTraceWriter: (trace: boolean, artifactContext: ArtifactContext) => TraceWriterPort;
  output: ApplicationOutputPort;
}

export interface TranslateTaskOptions {
  what: string;
  how: string;
  output: string;
  cwd?: string;
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
  configDirOption?: string;
  verbose?: boolean;
}

export function createTranslateTask(
  dependencies: TranslateTaskDependencies,
): (options: TranslateTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function translateTask(options: TranslateTaskOptions): Promise<number> {
    const executionCwd = options.cwd ?? dependencies.workingDirectory.cwd();
    const outputDocumentPath = dependencies.pathOperations.resolve(executionCwd, options.output);

    let whatDocument: string;
    try {
      whatDocument = dependencies.fileSystem.readText(options.what);
    } catch {
      emit({
        kind: "error",
        message: "Unable to read translate input <what>: " + options.what,
      });
      return EXIT_CODE_FAILURE;
    }

    let howDocument: string;
    try {
      howDocument = dependencies.fileSystem.readText(options.how);
    } catch {
      emit({
        kind: "error",
        message: "Unable to read translate input <how>: " + options.how,
      });
      return EXIT_CODE_FAILURE;
    }

    const loadedWorkerConfig = dependencies.configDir?.configDir
      ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
      : undefined;
    const resolvedWorker = resolveWorkerPatternForInvocation({
      commandName: "translate",
      workerConfig: loadedWorkerConfig,
      source: whatDocument,
      cliWorkerPattern: options.workerPattern,
      emit,
      mode: options.mode,
    });
    const resolvedWorkerCommand = resolvedWorker.workerCommand;
    const resolvedWorkerPattern = resolvedWorker.workerPattern;
    const workerTimeoutMs = loadedWorkerConfig?.workerTimeoutMs;

    if (resolvedWorkerCommand.length === 0) {
      emit({
        kind: "error",
        message: "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.",
      });
      return EXIT_CODE_FAILURE;
    }

    const templates = loadProjectTemplatesFromPorts(
      dependencies.configDir,
      dependencies.templateLoader,
      dependencies.pathOperations,
    );
    const promptVars: TemplateVars = {
      task: "Translate document",
      file: options.what,
      context: whatDocument,
      source: whatDocument,
      taskIndex: 0,
      taskLine: 1,
      what: whatDocument,
      how: howDocument,
    };
    const prompt = renderTemplate(templates.translate, promptVars);

    if (options.printPrompt) {
      emit({ kind: "text", text: prompt });
      return EXIT_CODE_SUCCESS;
    }

    if (options.dryRun) {
      emit({ kind: "info", message: "Dry run - would translate: " + resolvedWorkerCommand.join(" ") });
      emit({ kind: "info", message: "Prompt length: " + prompt.length + " chars" });
      return EXIT_CODE_SUCCESS;
    }

    if (options.forceUnlock) {
      if (!dependencies.fileLock.isLocked(outputDocumentPath)) {
        dependencies.fileLock.forceRelease(outputDocumentPath);
        emit({ kind: "info", message: "Force-unlocked stale source lock: " + outputDocumentPath });
      }
    }

    try {
      dependencies.fileLock.acquire(outputDocumentPath, { command: "translate" });
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

    let artifactContext: ArtifactContext | null = null;
    let artifactsFinalized = false;
    let artifactStatus: ArtifactStoreStatus = "running";
    let traceWriter: TraceWriterPort = dependencies.traceWriter;
    let tracePhaseCount = 0;
    let traceCompleted = false;
    let traceStartedAtMs = 0;

    const nowIso = (): string => new Date().toISOString();
    const toTraceStatus = (status: ArtifactStoreStatus): TraceRunStatus => status;

    const completeTraceRun = (status: ArtifactStoreStatus): void => {
      if (!artifactContext || traceCompleted) {
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

    const finishTranslate = (code: number, status: ArtifactStoreStatus): number => {
      artifactStatus = status;
      completeTraceRun(status);
      traceWriter.flush();
      if (artifactContext) {
        finalizeTranslateArtifacts(
          dependencies.artifactStore,
          artifactContext,
          options.keepArtifacts,
          status,
          emit,
        );
        artifactsFinalized = true;
      }

      return code;
    };

    try {
      artifactContext = dependencies.artifactStore.createContext({
        cwd: executionCwd,
        configDir: dependencies.configDir?.configDir,
        commandName: "translate",
        workerCommand: resolvedWorkerCommand,
        mode: options.mode,
        source: outputDocumentPath,
        keepArtifacts: options.keepArtifacts,
      });
      traceWriter = dependencies.createTraceWriter(options.trace, artifactContext);
      traceStartedAtMs = Date.now();

      traceWriter.write(createRunStartedEvent({
        timestamp: nowIso(),
        run_id: artifactContext.runId,
        payload: {
          command: "translate",
          source: options.what,
          worker: resolvedWorkerCommand,
          mode: options.mode,
          transport: "pattern",
          task_text: "Translate document",
          task_file: options.what,
          task_line: 1,
        },
      }));

      if (options.verbose) {
        emit({
          kind: "info",
          message: "Running translate worker: " + resolvedWorkerCommand.join(" ") + " [mode=" + options.mode + "]",
        });
      }

      const phaseSequence = tracePhaseCount + 1;
      tracePhaseCount = phaseSequence;
      const phaseStartedAtMs = Date.now();
      traceWriter.write(createPhaseStartedEvent({
        timestamp: nowIso(),
        run_id: artifactContext.runId,
        payload: {
          phase: "execute",
          sequence: phaseSequence,
          command: resolvedWorkerCommand,
        },
      }));

      const runResult = await dependencies.workerExecutor.runWorker({
        workerPattern: resolvedWorkerPattern,
        prompt,
        mode: options.mode,
        trace: options.trace,
        captureOutput: options.mode === "tui",
        cwd: executionCwd,
        configDir: dependencies.configDir?.configDir,
        timeoutMs: workerTimeoutMs,
        artifactContext,
        artifactPhase: "translate",
        artifactExtra: {
          workflow: "translate",
          what: options.what,
          how: options.how,
          output: options.output,
        },
        artifactPhaseLabel: "translate",
      });
      const phaseTimestamp = nowIso();
      traceWriter.write(createPhaseCompletedEvent({
        timestamp: phaseTimestamp,
        run_id: artifactContext.runId,
        payload: {
          phase: "execute",
          sequence: phaseSequence,
          exit_code: runResult.exitCode,
          duration_ms: Math.max(0, Date.now() - phaseStartedAtMs),
          stdout_bytes: Buffer.byteLength(runResult.stdout, "utf8"),
          stderr_bytes: Buffer.byteLength(runResult.stderr, "utf8"),
          output_captured: options.mode === "wait",
        },
      }));
      traceWriter.write(createOutputVolumeEvent({
        timestamp: phaseTimestamp,
        run_id: artifactContext.runId,
        payload: {
          phase: "execute",
          sequence: phaseSequence,
          stdout_bytes: Buffer.byteLength(runResult.stdout, "utf8"),
          stderr_bytes: Buffer.byteLength(runResult.stderr, "utf8"),
          stdout_lines: countTraceLines(runResult.stdout),
          stderr_lines: countTraceLines(runResult.stderr),
        },
      }));

      if (options.verbose) {
        emit({
          kind: "info",
          message: "Translate worker completed (exit "
            + (runResult.exitCode === null ? "null" : String(runResult.exitCode))
            + ").",
        });
      }

      if (options.mode === "wait" && options.showAgentOutput && runResult.stderr) {
        emit({ kind: "stderr", text: runResult.stderr });
      }

      if (runResult.exitCode !== 0) {
        const message = runResult.exitCode === null
          ? "Translate failed: worker exited without a code."
          : "Translate worker exited with code " + runResult.exitCode + ".";
        emit({ kind: "error", message });
        return finishTranslate(EXIT_CODE_FAILURE, "execution-failed");
      }

      try {
        dependencies.fileSystem.writeText(outputDocumentPath, runResult.stdout);
      } catch {
        const message = "Translate produced output, but failed to write Markdown document: " + outputDocumentPath;
        emit({ kind: "error", message });
        return finishTranslate(EXIT_CODE_FAILURE, "execution-failed");
      }

      emit({ kind: "success", message: "Translated document written to: " + outputDocumentPath });
      return finishTranslate(EXIT_CODE_SUCCESS, "completed");
    } finally {
      if (artifactContext && !artifactsFinalized) {
        const finalStatus = artifactStatus === "running" ? "failed" : artifactStatus;
        completeTraceRun(finalStatus);
        traceWriter.flush();
        finalizeTranslateArtifacts(
          dependencies.artifactStore,
          artifactContext,
          options.keepArtifacts,
          finalStatus,
          emit,
        );
      }

      try {
        dependencies.fileLock.releaseAll();
      } catch (error) {
        emit({ kind: "warn", message: "Failed to release file locks: " + String(error) });
      }
    }
  };
}

function finalizeTranslateArtifacts(
  artifactStore: ArtifactStore,
  artifactContext: ArtifactContext,
  keepArtifacts: boolean,
  status: ArtifactStoreStatus,
  emit: ApplicationOutputPort["emit"],
): void {
  const preserve = keepArtifacts || artifactStore.isFailedStatus(status);
  artifactStore.finalize(artifactContext, {
    status,
    preserve,
  });

  if (preserve) {
    emit({
      kind: "info",
      message: "Runtime artifacts saved at " + artifactStore.displayPath(artifactContext) + ".",
    });
  }
}
