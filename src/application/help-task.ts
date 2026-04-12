import { EXIT_CODE_FAILURE, EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { expandCliBlocks } from "../domain/cli-block.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import {
  createRunCompletedEvent,
  createRunStartedEvent,
  type TraceRunStatus,
} from "../domain/trace.js";
import { loadProjectTemplatesFromPorts } from "./project-templates.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";
import { withCliTrace, withTemplateCliFailureAbort } from "./cli-block-handlers.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  ArtifactStoreStatus,
  CommandExecutionOptions,
  CommandExecutor,
  ConfigDirResult,
  FileSystem,
  PathOperationsPort,
  TemplateLoader,
  TraceWriterPort,
  WorkerConfigPort,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

type ArtifactContext = ArtifactRunContext;

export interface HelpTaskDependencies {
  workerExecutor: WorkerExecutorPort;
  workingDirectory: WorkingDirectoryPort;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  templateLoader: TemplateLoader;
  artifactStore: ArtifactStore;
  workerConfigPort: WorkerConfigPort;
  traceWriter: TraceWriterPort;
  cliBlockExecutor: CommandExecutor;
  configDir: ConfigDirResult | undefined;
  createTraceWriter: (trace: boolean, artifactContext: ArtifactContext) => TraceWriterPort;
  output: ApplicationOutputPort;
}

export interface HelpTaskOptions {
  workerPattern: ParsedWorkerPattern;
  keepArtifacts: boolean;
  trace: boolean;
  cliVersion: string;
}

export function createHelpTask(
  dependencies: HelpTaskDependencies,
): (options: HelpTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function helpTask(options: HelpTaskOptions): Promise<number> {
    const cwd = dependencies.workingDirectory.cwd();
    let traceWriter: TraceWriterPort = dependencies.traceWriter;
    let artifactContext: ArtifactContext | null = null;
    let artifactsFinalized = false;
    let artifactStatus: ArtifactStoreStatus = "running";
    let completeTraceRun: ((status: ArtifactStoreStatus) => void) | null = null;

    try {
      let resolvedWorkerCommand: string[] = [];
      let resolvedWorkerPattern: ParsedWorkerPattern = {
        command: [],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      };

      try {
        const loadedWorkerConfig = dependencies.configDir?.configDir
          ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
          : undefined;
        const resolvedWorker = resolveWorkerPatternForInvocation({
          commandName: "help",
          workerConfig: loadedWorkerConfig,
          source: "",
          cliWorkerPattern: options.workerPattern,
          emit,
          mode: "tui",
        });
        resolvedWorkerCommand = resolvedWorker.workerCommand;
        resolvedWorkerPattern = resolvedWorker.workerPattern;
      } catch (error) {
        emit({
          kind: "info",
          message: "Interactive help worker could not be resolved. Falling back to static help output."
            + (error instanceof Error && error.message.length > 0 ? " " + error.message : ""),
        });
        return EXIT_CODE_NO_WORK;
      }

      if (resolvedWorkerCommand.length === 0) {
        emit({
          kind: "info",
          message: "No interactive help worker is configured. Falling back to static help output.",
        });
        return EXIT_CODE_NO_WORK;
      }

      const templates = loadProjectTemplatesFromPorts(
        dependencies.configDir,
        dependencies.templateLoader,
        dependencies.pathOperations,
      );
      const renderedPrompt = renderHelpPrompt(templates.help, {
        cliVersion: options.cliVersion,
        workingDirectory: cwd,
        commandIndex: buildCommandIndex(),
        docsContext: buildDocsContext(cwd, dependencies.fileSystem, dependencies.pathOperations),
      });

      artifactContext = dependencies.artifactStore.createContext({
        cwd,
        configDir: dependencies.configDir?.configDir,
        commandName: "help",
        workerCommand: resolvedWorkerCommand,
        mode: "tui",
        keepArtifacts: options.keepArtifacts,
      });
      const activeArtifactContext = artifactContext;

      traceWriter = dependencies.createTraceWriter(options.trace, activeArtifactContext);
      const nowIso = (): string => new Date().toISOString();
      const baseCliExecutionOptions: CommandExecutionOptions | undefined = options.keepArtifacts
        ? {
          artifactContext: activeArtifactContext,
          artifactPhase: "worker",
          artifactPhaseLabel: "cli-help-template",
          artifactExtra: { promptType: "help-template" },
        }
        : undefined;
      const cliExecutionOptionsWithTrace = withCliTrace(
        baseCliExecutionOptions,
        traceWriter,
        activeArtifactContext.runId,
        nowIso,
      );
      const prompt = await expandCliBlocks(
        renderedPrompt,
        dependencies.cliBlockExecutor,
        cwd,
        withTemplateCliFailureAbort(cliExecutionOptionsWithTrace, "help template"),
      );

      let traceCompleted = false;
      const traceStartedAtMs = Date.now();
      const toTraceStatus = (status: ArtifactStoreStatus): TraceRunStatus => status;

      traceWriter.write(createRunStartedEvent({
        timestamp: nowIso(),
        run_id: activeArtifactContext.runId,
        payload: {
          command: "help",
          source: cwd,
          worker: resolvedWorkerCommand,
          mode: "tui",
          transport: "pattern",
          task_text: "Interactive help session",
          task_file: "(none)",
          task_line: 1,
        },
      }));

      completeTraceRun = (status: ArtifactStoreStatus): void => {
        if (traceCompleted) {
          return;
        }

        traceWriter.write(createRunCompletedEvent({
          timestamp: nowIso(),
          run_id: activeArtifactContext.runId,
          payload: {
            status: toTraceStatus(status),
            total_duration_ms: Math.max(0, Date.now() - traceStartedAtMs),
            total_phases: 0,
          },
        }));
        traceCompleted = true;
      };

      const result = await dependencies.workerExecutor.runWorker({
        workerPattern: resolvedWorkerPattern,
        prompt,
        mode: "tui",
        trace: options.trace,
        captureOutput: options.keepArtifacts,
        cwd,
        configDir: dependencies.configDir?.configDir,
        artifactContext: activeArtifactContext,
        artifactPhase: "worker",
        artifactPhaseLabel: "help",
      });

      const status: ArtifactStoreStatus = result.exitCode === 0 ? "completed" : "failed";
      artifactStatus = status;
      completeTraceRun(status);
      dependencies.artifactStore.finalize(activeArtifactContext, {
        status,
        preserve: options.keepArtifacts,
      });
      artifactsFinalized = true;

      if (options.keepArtifacts) {
        emit({
            kind: "info",
            message: "Runtime artifacts saved at " + dependencies.artifactStore.displayPath(activeArtifactContext) + ".",
          });
      }

      if (result.exitCode !== 0) {
        const message = result.exitCode === null
          ? "Interactive help failed: worker exited without a code."
          : "Interactive help exited with code " + result.exitCode + ".";
        emit({ kind: "error", message });
        return EXIT_CODE_FAILURE;
      }

      return EXIT_CODE_SUCCESS;
    } finally {
      if (artifactContext && !artifactsFinalized) {
        const finalStatus = artifactStatus === "running" ? "failed" : artifactStatus;
        completeTraceRun?.(finalStatus);
        dependencies.artifactStore.finalize(artifactContext, {
          status: finalStatus,
          preserve: options.keepArtifacts,
        });
      }
      traceWriter.flush();
    }
  };
}

function renderHelpPrompt(
  template: string,
  input: {
    cliVersion: string;
    workingDirectory: string;
    commandIndex: string;
    docsContext: string;
  },
): string {
  const vars: TemplateVars = {
    task: "Provide interactive CLI help for this repository.",
    file: "(none)",
    context: "",
    taskIndex: 0,
    taskLine: 1,
    source: "",
    cliVersion: input.cliVersion,
    workingDirectory: input.workingDirectory,
    commandIndex: input.commandIndex,
    docsContext: input.docsContext,
  };

  return renderTemplate(template, vars);
}

function buildCommandIndex(): string {
  return [
    "- run: execute unchecked TODO tasks",
    "- call: run clean full-pass execution",
    "- loop: repeat full-pass call executions",
    "- plan: generate TODO tasks from documents",
    "- research: enrich documents with implementation context",
    "- make: create + research + plan a task file",
    "- do: make, then execute all tasks",
    "- discuss: interactive task discussion",
    "- reverify: rerun verification from saved artifacts",
    "- revert: undo completed task runs",
    "- next/list: inspect upcoming tasks",
    "- artifacts/log: inspect saved run metadata",
    "- memory-view/memory-validate/memory-clean: manage source memory",
    "- init: scaffold .rundown defaults",
    "- unlock: release stale source lockfiles",
  ].join("\n");
}

function buildDocsContext(
  cwd: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): string {
  const docsDir = pathOperations.join(cwd, "docs");
  if (!fileSystem.exists(docsDir)) {
    return "- docs/ directory not found.";
  }

  const docsDirStat = fileSystem.stat(docsDir);
  if (!docsDirStat || !docsDirStat.isDirectory) {
    return "- docs/ path exists but is not a directory.";
  }

  const markdownDocs = fileSystem.readdir(docsDir)
    .filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => `- docs/${entry.name}`)
    .sort((left, right) => left.localeCompare(right));

  if (markdownDocs.length === 0) {
    return "- docs/ contains no Markdown files.";
  }

  return markdownDocs.join("\n");
}
