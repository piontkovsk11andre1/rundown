import { getTraceInstructions } from "../domain/defaults.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import {
  buildMemoryTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { parseTasks } from "../domain/parser.js";
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
import { captureCheckboxState } from "./checkbox-operations.js";
import { parseUncheckedTodoLines } from "../domain/todo-lines.js";
import { loadProjectTemplatesFromPorts } from "./project-templates.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";
import {
  resolvePredictionWorkspaceDirectories,
  resolvePredictionWorkspacePaths,
  resolvePredictionWorkspacePlacement,
} from "./prediction-workspace-paths.js";
import {
  buildWorkspaceContextTemplateVars,
  mergeTemplateVarsWithWorkspaceContext,
  resolveRuntimeWorkspaceContext,
} from "./runtime-workspace-context.js";
import { resolveDesignContext, resolveDesignContextSourceReferences } from "./design-context.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import { formatSuccessFailureSummary, pluralize } from "./run-task-utils.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import type { Task } from "../domain/parser.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  ArtifactStoreStatus,
  CommandExecutor,
  ConfigDirResult,
  FileLock,
  FileSystem,
  TaskRepairPort,
  TaskRepairResult,
  TaskResolveOptions,
  TaskResolveResult,
  TaskVerificationOptions,
  TaskVerificationPort,
  TaskVerificationResult,
  TraceWriterPort,
  VerificationStore,
  PathOperationsPort,
  ProcessRunMode,
  MemoryResolverPort,
  TemplateLoader,
  TemplateVarsLoaderPort,
  WorkerConfigPort,
  WorkerExecutorPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

/**
 * Execution mode used when invoking the research worker.
 */
export type RunnerMode = ProcessRunMode;

/**
 * Artifact context alias used for research command runs.
 */
type ArtifactContext = ArtifactRunContext;

const MAX_RESEARCH_REPAIR_ATTEMPTS = 2;
const MAX_RESEARCH_RESOLVE_REPAIR_ATTEMPTS = 1;

/**
 * Ports required to execute the `research` command.
 */
export interface ResearchTaskDependencies {
  workerExecutor: WorkerExecutorPort;
  taskVerification: TaskVerificationPort;
  taskRepair: TaskRepairPort;
  verificationStore: VerificationStore;
  traceWriter: TraceWriterPort;
  cliBlockExecutor: CommandExecutor;
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
  fileLock: FileLock;
  workingDirectory: WorkingDirectoryPort;
  pathOperations: PathOperationsPort;
  memoryResolver?: MemoryResolverPort;
  templateLoader: TemplateLoader;
  templateVarsLoader: TemplateVarsLoaderPort;
  workerConfigPort: WorkerConfigPort;
  configDir: ConfigDirResult | undefined;
  output: ApplicationOutputPort;
}

/**
 * Runtime options accepted by a single `research` command invocation.
 */
export interface ResearchTaskOptions {
  source: string;
  cwd?: string;
  invocationDir?: string;
  workspaceDir?: string;
  workspaceLinkPath?: string;
  isLinkedWorkspace?: boolean;
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

/**
 * Creates the research task runner.
 *
 * This placeholder keeps CLI wiring functional until the full research workflow
 * is implemented.
 */
export function createResearchTask(
  dependencies: ResearchTaskDependencies,
): (options: ResearchTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function researchTask(options: ResearchTaskOptions): Promise<number> {
    const {
      source,
      printPrompt,
      dryRun,
      varsFileOption,
      cliTemplateVarArgs,
      ignoreCliBlock,
      cliBlockTimeoutMs,
      trace,
      workerPattern,
      mode,
      showAgentOutput,
      keepArtifacts,
      forceUnlock,
      verbose = false,
      invocationDir,
      workspaceDir,
      workspaceLinkPath,
      isLinkedWorkspace,
    } = options;
    const executionCwd = options.cwd ?? dependencies.workingDirectory.cwd();
    const runtimeWorkspaceContext = resolveRuntimeWorkspaceContext(
      {
        executionCwd,
        invocationDir,
        workspaceDir,
        workspaceLinkPath,
        isLinkedWorkspace,
      },
      dependencies.pathOperations,
    );
    const workspaceDirectories = resolvePredictionWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
    });
    const workspacePlacement = resolvePredictionWorkspacePlacement({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
    });
    const workspacePaths = resolvePredictionWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: runtimeWorkspaceContext.workspaceDir,
      invocationRoot: runtimeWorkspaceContext.invocationDir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });
    const workspaceContextTemplateVars = buildWorkspaceContextTemplateVars(
      runtimeWorkspaceContext,
      {
        directories: workspaceDirectories,
        placement: workspacePlacement,
        paths: workspacePaths,
      },
    );
    const projectRoot = runtimeWorkspaceContext.workspaceDir;
    const designContext = resolveDesignContext(dependencies.fileSystem, projectRoot, {
      invocationRoot: runtimeWorkspaceContext.invocationDir,
    });
    const designContextSources = resolveDesignContextSourceReferences(dependencies.fileSystem, projectRoot, {
      invocationRoot: runtimeWorkspaceContext.invocationDir,
    });
    const designContextSourceReferences = designContextSources.sourceReferences
      .map((sourcePath) => "- " + sourcePath)
      .join("\n");
    let researchSuccessCount = 0;
    let researchFailureCount = 0;
    let researchGroupStarted = false;
    let researchSummaryEmitted = false;

    const emitResearchGroupStart = (label: string): void => {
      researchGroupStarted = true;
      emit({
        kind: "group-start",
        label,
        counter: {
          current: 1,
          total: 1,
        },
      });
    };

    const emitResearchGroupSuccess = (): void => {
      researchSuccessCount += 1;
      emit({ kind: "group-end", status: "success" });
    };

    const emitResearchGroupFailure = (message: string): void => {
      researchFailureCount += 1;
      emit({ kind: "group-end", status: "failure", message });
    };

    const emitResearchSummary = (): void => {
      if (!researchGroupStarted || researchSummaryEmitted) {
        return;
      }

      emit({
        kind: "info",
        message: formatSuccessFailureSummary("Research turn", researchSuccessCount, researchFailureCount),
      });
      researchSummaryEmitted = true;
    };

    const cliExecutionOptions = cliBlockTimeoutMs === undefined
      ? undefined
      : { timeoutMs: cliBlockTimeoutMs };
    const cliExecutionOptionsWithTemplateFailureAbort = withTemplateCliFailureAbort(
      cliExecutionOptions,
      "research template",
    );

    const runDiagnosticMode = async (): Promise<number> => {
      let sourceDocument: string;
      try {
        sourceDocument = dependencies.fileSystem.readText(source);
      } catch {
        emit({
          kind: "error",
          message: "Unable to read Markdown document: " + source,
        });
        return EXIT_CODE_FAILURE;
      }

      emitResearchGroupStart(deriveDocumentIntent(sourceDocument, source));
      try {
        const varsFilePath = resolveTemplateVarsFilePath(
          varsFileOption,
          dependencies.configDir?.configDir,
        );
        const cwd = executionCwd;
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

        const templates = loadProjectTemplatesFromPorts(
          dependencies.configDir,
          dependencies.templateLoader,
          dependencies.pathOperations,
        );
        const vars: TemplateVars = {
          ...templateVarsWithUserVariables,
          ...buildMemoryTemplateVars({
            memoryMetadata: dependencies.memoryResolver?.resolve(source) ?? null,
          }),
          traceInstructions: getTraceInstructions(trace),
          task: deriveDocumentIntent(sourceDocument, source),
          file: source,
          context: sourceDocument,
          taskIndex: 0,
          taskLine: 1,
          source: sourceDocument,
          design: designContext.design,
          designContextSourceReferences,
          designContextSourceReferencesJson: JSON.stringify(designContextSources.sourceReferences),
          designContextHasManagedDocs: designContextSources.hasManagedDocs ? "true" : "false",
        };
        const renderedPrompt = renderTemplate(templates.research, vars);
        const promptCliBlockCount = extractCliBlocks(renderedPrompt).length;
        const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
        let prompt = renderedPrompt;

        if (!ignoreCliBlock && !dryRunSuppressesCliExpansion) {
          try {
            prompt = await expandCliBlocks(
              renderedPrompt,
              dependencies.cliBlockExecutor,
              cwd,
              {
                ...cliExecutionOptionsWithTemplateFailureAbort,
                env: {
                  ...(cliExecutionOptionsWithTemplateFailureAbort?.env ?? {}),
                  ...rundownVarEnv,
                },
              },
            );
          } catch (error) {
            if (error instanceof TemplateCliBlockExecutionError) {
              const exitCodeLabel = error.exitCode === null ? "unknown" : String(error.exitCode);
              const message = "`cli` fenced command failed in "
                + error.templateLabel
                + " (exit "
                + exitCodeLabel
                + "): "
                + error.command
                + ". Aborting run.";
              emit({
                kind: "error",
                message,
              });
              emitResearchGroupFailure(message);
              return EXIT_CODE_FAILURE;
            }
            throw error;
          }
        }

        if (printPrompt) {
          emit({ kind: "text", text: prompt });
          emitResearchGroupSuccess();
          return EXIT_CODE_SUCCESS;
        }

        const loadedWorkerConfig = dependencies.configDir?.configDir
          ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
          : undefined;
        const resolvedWorker = resolveWorkerPatternForInvocation({
          commandName: "research",
          workerConfig: loadedWorkerConfig,
          source: sourceDocument,
          cliWorkerPattern: workerPattern,
          emit,
          mode,
        });
        const resolvedWorkerCommand = resolvedWorker.workerCommand;

        if (resolvedWorkerCommand.length === 0) {
          const message = "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.";
          emit({
            kind: "error",
            message,
          });
          emitResearchGroupFailure(message);
          return EXIT_CODE_FAILURE;
        }

        if (dryRunSuppressesCliExpansion && !ignoreCliBlock) {
          emit({
            kind: "info",
            message: "Dry run — skipped `cli` fenced block execution; would execute "
              + promptCliBlockCount
              + " "
              + pluralize(promptCliBlockCount, "block", "blocks")
              + ".",
          });
        }
        emit({ kind: "info", message: "Dry run - would research: " + resolvedWorkerCommand.join(" ") });
        emit({ kind: "info", message: "Prompt length: " + prompt.length + " chars" });
        emitResearchGroupSuccess();
        return EXIT_CODE_SUCCESS;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitResearchGroupFailure(message);
        throw error;
      } finally {
        emitResearchSummary();
      }
    };

    if (dryRun || printPrompt) {
      return runDiagnosticMode();
    }

    if (forceUnlock) {
      if (!dependencies.fileLock.isLocked(source)) {
        dependencies.fileLock.forceRelease(source);
        emit({ kind: "info", message: "Force-unlocked stale source lock: " + source });
      }
    }

    try {
      dependencies.fileLock.acquire(source, { command: "research" });
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

    const finishResearch = (
      code: number,
      status: ArtifactStoreStatus,
      extra?: Record<string, unknown>,
    ): number => {
      artifactStatus = status;
      if (artifactContext) {
        finalizeResearchArtifacts(
          dependencies.artifactStore,
          artifactContext,
          keepArtifacts,
          status,
          emit,
          extra,
        );
        artifactsFinalized = true;
      }

      return code;
    };

    try {
      let sourceDocument: string;
      try {
        sourceDocument = dependencies.fileSystem.readText(source);
      } catch {
        emit({
          kind: "error",
          message: "Unable to read Markdown document: " + source,
        });
        return EXIT_CODE_FAILURE;
      }

      emitResearchGroupStart(deriveDocumentIntent(sourceDocument, source));
      try {
        const varsFilePath = resolveTemplateVarsFilePath(
          varsFileOption,
          dependencies.configDir?.configDir,
        );
        const cwd = executionCwd;
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

        const templates = loadProjectTemplatesFromPorts(
          dependencies.configDir,
          dependencies.templateLoader,
          dependencies.pathOperations,
        );
        const vars: TemplateVars = {
          ...templateVarsWithUserVariables,
          ...buildMemoryTemplateVars({
            memoryMetadata: dependencies.memoryResolver?.resolve(source) ?? null,
          }),
          traceInstructions: getTraceInstructions(trace),
          task: deriveDocumentIntent(sourceDocument, source),
          file: source,
          context: sourceDocument,
          taskIndex: 0,
          taskLine: 1,
          source: sourceDocument,
          design: designContext.design,
          designContextSourceReferences,
          designContextSourceReferencesJson: JSON.stringify(designContextSources.sourceReferences),
          designContextHasManagedDocs: designContextSources.hasManagedDocs ? "true" : "false",
        };
        const renderedPrompt = renderTemplate(templates.research, vars);
        const promptCliBlockCount = extractCliBlocks(renderedPrompt).length;
        const dryRunSuppressesCliExpansion = dryRun && !printPrompt;
        let prompt = renderedPrompt;

        if (!ignoreCliBlock && !dryRunSuppressesCliExpansion) {
          try {
            prompt = await expandCliBlocks(
              renderedPrompt,
              dependencies.cliBlockExecutor,
              cwd,
              {
                ...cliExecutionOptionsWithTemplateFailureAbort,
                env: {
                  ...(cliExecutionOptionsWithTemplateFailureAbort?.env ?? {}),
                  ...rundownVarEnv,
                },
              },
            );
          } catch (error) {
            if (error instanceof TemplateCliBlockExecutionError) {
              const exitCodeLabel = error.exitCode === null ? "unknown" : String(error.exitCode);
              const message = "`cli` fenced command failed in "
                + error.templateLabel
                + " (exit "
                + exitCodeLabel
                + "): "
                + error.command
                + ". Aborting run.";
              emit({
                kind: "error",
                message,
              });
              emitResearchGroupFailure(message);
              return EXIT_CODE_FAILURE;
            }
            throw error;
          }
        }

        if (printPrompt) {
          emit({ kind: "text", text: prompt });
          emitResearchGroupSuccess();
          return EXIT_CODE_SUCCESS;
        }

        const loadedWorkerConfig = dependencies.configDir?.configDir
          ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)
          : undefined;
        const resolvedWorker = resolveWorkerPatternForInvocation({
          commandName: "research",
          workerConfig: loadedWorkerConfig,
          source: sourceDocument,
          cliWorkerPattern: workerPattern,
          emit,
          mode,
        });
        const resolvedWorkerCommand = resolvedWorker.workerCommand;
        const resolvedWorkerPattern = resolvedWorker.workerPattern;

        if (resolvedWorkerCommand.length === 0) {
          const message = "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.";
          emit({
            kind: "error",
            message,
          });
          emitResearchGroupFailure(message);
          return EXIT_CODE_FAILURE;
        }

        if (dryRun) {
          if (dryRunSuppressesCliExpansion && !ignoreCliBlock) {
            emit({
              kind: "info",
              message: "Dry run — skipped `cli` fenced block execution; would execute "
                + promptCliBlockCount
                + " "
                + pluralize(promptCliBlockCount, "block", "blocks")
                + ".",
            });
          }
          emit({ kind: "info", message: "Dry run - would research: " + resolvedWorkerCommand.join(" ") });
          emit({ kind: "info", message: "Prompt length: " + prompt.length + " chars" });
          emitResearchGroupSuccess();
          return EXIT_CODE_SUCCESS;
        }

        artifactContext = dependencies.artifactStore.createContext({
          cwd,
          configDir: dependencies.configDir?.configDir,
          commandName: "research",
          workerCommand: resolvedWorkerCommand,
          mode,
          source,
          keepArtifacts,
        });

        if (verbose) {
          emit({
            kind: "info",
            message: "Running research worker: "
              + resolvedWorkerCommand.join(" ")
              + " [mode="
              + mode
              + "]",
          });
        }

        const runResult = await dependencies.workerExecutor.runWorker({
          workerPattern: resolvedWorkerPattern,
          prompt,
          mode,
          trace,
          captureOutput: mode === "tui",
          cwd,
          env: rundownVarEnv,
          configDir: dependencies.configDir?.configDir,
          artifactContext,
          artifactPhase: "worker",
          artifactPhaseLabel: "research",
        });

        if (verbose) {
          emit({
            kind: "info",
            message: "Research worker completed (exit "
              + (runResult.exitCode === null ? "null" : String(runResult.exitCode))
              + ").",
          });
        }

        if (mode === "wait" && showAgentOutput && runResult.stderr) {
          emit({ kind: "stderr", text: runResult.stderr });
        }

        if (runResult.exitCode !== 0) {
          const message = runResult.exitCode === null
            ? "Research failed: worker exited without a code."
            : "Research worker exited with code " + runResult.exitCode + ".";
          if (runResult.exitCode === null) {
            emit({ kind: "error", message });
          } else {
            emit({ kind: "error", message });
          }
          emitResearchGroupFailure(message);
          return finishResearch(EXIT_CODE_FAILURE, "execution-failed");
        }

        let latestCandidate = runResult.stdout;
        const removedTodosAcrossAttempts: string[] = [];
        const verifyRepairTask = createResearchVerificationTask(source, sourceDocument);
        const verifyCliExecutionOptions = withTemplateCliFailureAbort(
          cliExecutionOptions,
          "research verify template",
        );
        const repairCliExecutionOptions = withTemplateCliFailureAbort(
          cliExecutionOptions,
          "research repair template",
        );
        const resolveCliExecutionOptions = withTemplateCliFailureAbort(
          cliExecutionOptions,
          "research resolve template",
        );

        const verifyCandidate = async (params: {
          task: Task;
          source: string;
          contextBefore: string;
          template: string;
          workerPattern: ParsedWorkerPattern;
          mode?: ProcessRunMode;
          onWorkerOutput?: (stdout: string, stderr: string) => void;
          trace?: boolean;
          configDir?: string;
          templateVars?: Record<string, unknown>;
          executionEnv?: Record<string, string>;
          artifactContext?: unknown;
          cliBlockExecutor?: CommandExecutor;
          cliExecutionOptions?: { timeoutMs?: number; env?: Record<string, string> };
          cliExpansionEnabled?: boolean;
        }): Promise<{ valid: boolean; stdout?: string }> => {
          const candidate = typeof params.templateVars?.executionStdout === "string"
            ? params.templateVars.executionStdout
            : "";
          const sanitization = sanitizeResearchCandidate({
            source,
            beforeSource: sourceDocument,
            afterSource: candidate,
          });

          if (!sanitization.ok) {
            dependencies.verificationStore.write(params.task, sanitization.failureReason);
            return {
              valid: false,
              stdout: "NOT_OK: " + sanitization.failureReason,
            };
          }

          latestCandidate = sanitization.cleaned;
          if (sanitization.removed.length > 0) {
            removedTodosAcrossAttempts.push(...sanitization.removed);
          }

          const verificationResult = await dependencies.taskVerification.verify({
            ...params,
            mode: params.mode ?? "wait",
            templateVars: {
              ...(params.templateVars ?? {}),
              executionStdout: latestCandidate,
            },
            cliExecutionOptions: params.cliExecutionOptions,
          });

          return {
            valid: verificationResult.valid,
            stdout: verificationResult.stdout,
          };
        };

        const researchTaskVerification: TaskVerificationPort = {
          verify: async (verificationOptions): Promise<TaskVerificationResult> => {
            const verified = await verifyCandidate(verificationOptions);
            return {
              valid: verified.valid,
              stdout: verified.stdout,
            };
          },
        };

        const researchTaskRepair: TaskRepairPort = {
          repair: async (repairOptions): Promise<TaskRepairResult> => {
            const verificationResult = dependencies.verificationStore.read(repairOptions.task)
              ?? "Verification failed (no details).";
            const repairVars: TemplateVars = {
              ...(repairOptions.templateVars ?? {}),
              task: repairOptions.task.text,
              file: repairOptions.task.file,
              context: repairOptions.contextBefore,
              taskIndex: repairOptions.task.index,
              taskLine: repairOptions.task.line,
              source: repairOptions.source,
              verificationResult,
              executionStdout: latestCandidate,
            };
            const renderedRepairPrompt = renderTemplate(repairOptions.repairTemplate, repairVars);
            const expandedRepairPrompt = repairOptions.cliExpansionEnabled === false
              ? renderedRepairPrompt
              : await expandCliBlocks(
                renderedRepairPrompt,
                repairOptions.cliBlockExecutor ?? dependencies.cliBlockExecutor,
                cwd,
                {
                  ...(repairOptions.cliExecutionOptions ?? {}),
                  env: {
                    ...(repairOptions.cliExecutionOptions?.env ?? {}),
                    ...(repairOptions.executionEnv ?? {}),
                  },
                },
              );

            const repairRunResult = await dependencies.workerExecutor.runWorker({
              workerPattern: repairOptions.workerPattern,
              prompt: expandedRepairPrompt,
              mode: repairOptions.mode ?? "wait",
              trace: repairOptions.trace,
              captureOutput: true,
              cwd,
              env: repairOptions.executionEnv,
              configDir: repairOptions.configDir,
              artifactContext: repairOptions.artifactContext,
              artifactPhase: "repair",
            });
            repairOptions.onWorkerOutput?.(repairRunResult.stdout, repairRunResult.stderr);

            if (repairRunResult.exitCode !== 0) {
              const failureMessage = repairRunResult.exitCode === null
                ? "Research repair failed: worker exited without a code."
                : "Research repair worker exited with code " + repairRunResult.exitCode + ".";
              dependencies.verificationStore.write(repairOptions.task, failureMessage);
              return {
                valid: false,
                attempts: 1,
                repairStdout: repairRunResult.stdout,
              };
            }

            latestCandidate = repairRunResult.stdout;
            const verified = await verifyCandidate({
              task: repairOptions.task,
              source: repairOptions.source,
              contextBefore: repairOptions.contextBefore,
              template: repairOptions.verifyTemplate,
              workerPattern: repairOptions.workerPattern,
              mode: "wait",
              onWorkerOutput: repairOptions.onWorkerOutput,
              trace: repairOptions.trace,
              configDir: repairOptions.configDir,
              templateVars: {
                ...(repairOptions.templateVars ?? {}),
                executionStdout: latestCandidate,
              },
              executionEnv: repairOptions.executionEnv,
              artifactContext: repairOptions.artifactContext,
              cliBlockExecutor: repairOptions.cliBlockExecutor,
              cliExecutionOptions: repairOptions.cliExecutionOptions,
              cliExpansionEnabled: repairOptions.cliExpansionEnabled,
            });

            return {
              valid: verified.valid,
              attempts: 1,
              repairStdout: repairRunResult.stdout,
              verificationStdout: verified.stdout,
            };
          },
          resolve: dependencies.taskRepair.resolve
            ? async (resolveOptions: TaskResolveOptions): Promise<TaskResolveResult> =>
              await dependencies.taskRepair.resolve!({
                ...resolveOptions,
                templateVars: {
                  ...(resolveOptions.templateVars ?? {}),
                  executionStdout: latestCandidate,
                },
                cliExecutionOptions: resolveCliExecutionOptions,
              })
            : undefined,
        };

        const verification = await runVerifyRepairLoop({
          taskVerification: researchTaskVerification,
          taskRepair: researchTaskRepair,
          verificationStore: dependencies.verificationStore,
          traceWriter: dependencies.traceWriter,
          output: dependencies.output,
        }, {
          task: verifyRepairTask,
          source: sourceDocument,
          contextBefore: sourceDocument,
          verifyTemplate: templates.researchVerify,
          repairTemplate: templates.researchRepair,
          resolveTemplate: templates.researchResolve,
          executionStdout: latestCandidate,
          workerPattern: resolvedWorkerPattern,
          configDir: dependencies.configDir?.configDir,
          maxRepairAttempts: MAX_RESEARCH_REPAIR_ATTEMPTS,
          maxResolveRepairAttempts: MAX_RESEARCH_RESOLVE_REPAIR_ATTEMPTS,
          allowRepair: true,
          templateVars: {
            ...vars,
            executionStdout: latestCandidate,
          },
          executionEnv: rundownVarEnv,
          artifactContext,
          trace,
          showAgentOutput,
          verbose,
          cliBlockExecutor: dependencies.cliBlockExecutor,
          cliExecutionOptions: verifyCliExecutionOptions,
          cliExpansionEnabled: !ignoreCliBlock,
          runMode: mode,
          executionOutputCaptured: mode !== "detached",
          isInlineCliTask: false,
          isToolExpansionTask: false,
        });

        if (!verification.valid) {
          const failureReason = verification.failureReason
            ?? "Research verification failed (no details).";
          emitResearchGroupFailure(failureReason);
          return finishResearch(EXIT_CODE_FAILURE, "verification-failed", {
            verificationFailureReason: failureReason,
          });
        }

        try {
          dependencies.fileSystem.writeText(source, latestCandidate);
        } catch {
          const message = "Research produced output, but failed to update Markdown document: " + source;
          emit({ kind: "error", message });
          emitResearchGroupFailure(message);
          return finishResearch(EXIT_CODE_FAILURE, "execution-failed");
        }

        if (removedTodosAcrossAttempts.length > 0) {
          emit({
            kind: "warn",
            message: "Research introduced new unchecked TODO items in "
              + source
              + ". Removed "
              + removedTodosAcrossAttempts.length
              + " "
              + pluralize(removedTodosAcrossAttempts.length, "introduced item", "introduced items")
              + ": "
              + removedTodosAcrossAttempts.join("; ")
              + "; continuing with cleaned output.",
          });
        }

        emit({ kind: "success", message: "Research worker completed." });
        emitResearchGroupSuccess();
        return finishResearch(EXIT_CODE_SUCCESS, "completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        emitResearchGroupFailure(message);
        throw error;
      } finally {
        emitResearchSummary();
      }
    } finally {
      if (artifactContext && !artifactsFinalized) {
        const finalStatus = artifactStatus === "running" ? "failed" : artifactStatus;
        finalizeResearchArtifacts(
          dependencies.artifactStore,
          artifactContext,
          keepArtifacts,
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

/**
 * Finalizes artifact storage and emits the artifact location when preserved.
 */
function finalizeResearchArtifacts(
  artifactStore: ArtifactStore,
  artifactContext: ArtifactContext,
  keepArtifacts: boolean,
  status: ArtifactStoreStatus,
  emit: ApplicationOutputPort["emit"],
  extra?: Record<string, unknown>,
): void {
  const preserve = keepArtifacts || artifactStore.isFailedStatus(status);
  artifactStore.finalize(artifactContext, {
    status,
    preserve,
    extra,
  });

  if (preserve) {
    emit({
      kind: "info",
      message: "Runtime artifacts saved at " + artifactStore.displayPath(artifactContext) + ".",
    });
  }
}

/**
 * Derives a user-facing research intent from the first H1 heading when present.
 */
function deriveDocumentIntent(source: string, fallbackPath: string): string {
  const headingMatch = source.match(/^\s{0,3}#\s+(.+)$/m);
  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  return "Research document context for " + fallbackPath;
}

/**
 * Detects checkbox completion-state mutations for existing checkbox positions.
 */
function hasCheckboxStateMutation(beforeSource: string, afterSource: string): boolean {
  const before = captureCheckboxState(beforeSource);
  const after = captureCheckboxState(afterSource);

  if (after.orderedStates.length < before.orderedStates.length) {
    return true;
  }

  const comparableCount = Math.min(before.orderedStates.length, after.orderedStates.length);

  for (let index = 0; index < comparableCount; index += 1) {
    if (before.orderedStates[index] !== after.orderedStates[index]) {
      return true;
    }
  }

  return false;
}

/**
 * Builds a synthetic task descriptor for research verify/repair orchestration.
 */
function createResearchVerificationTask(sourcePath: string, sourceDocument: string): Task {
  const parsedTasks = parseTasks(sourceDocument, sourcePath);
  const firstTask = parsedTasks[0];

  return {
    text: "research: validate enriched document",
    checked: false,
    index: firstTask?.index ?? 0,
    line: firstTask?.line ?? 1,
    column: firstTask?.column ?? 1,
    offsetStart: firstTask?.offsetStart ?? 0,
    offsetEnd: firstTask?.offsetEnd ?? sourceDocument.length,
    file: sourcePath,
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}

/**
 * Applies hard safety guards to research output before semantic verification.
 */
function sanitizeResearchCandidate(params: {
  source: string;
  beforeSource: string;
  afterSource: string;
}): {
  ok: boolean;
  cleaned: string;
  removed: string[];
  failureReason: string;
} {
  const { source, beforeSource, afterSource } = params;

  if (afterSource.trim().length === 0) {
    return {
      ok: false,
      cleaned: afterSource,
      removed: [],
      failureReason: "Research output was empty. Research must return the full updated Markdown document based on the original input.",
    };
  }

  if (hasCheckboxStateMutation(beforeSource, afterSource)) {
    return {
      ok: false,
      cleaned: afterSource,
      removed: [],
      failureReason: "Research changed checkbox state in "
        + source
        + ". Research may enrich prose, but must not mark/unmark checkboxes.",
    };
  }

  const strippedTodos = stripIntroducedUncheckedTodos(beforeSource, afterSource);
  try {
    parseTasks(strippedTodos.cleaned, source);
  } catch {
    return {
      ok: false,
      cleaned: strippedTodos.cleaned,
      removed: strippedTodos.removed,
      failureReason: "Research output was not valid Markdown for rundown task parsing.",
    };
  }

  return {
    ok: true,
    cleaned: strippedTodos.cleaned,
    removed: strippedTodos.removed,
    failureReason: "",
  };
}

export function stripIntroducedUncheckedTodos(
  beforeSource: string,
  afterSource: string,
): { cleaned: string; removed: string[] } {
  const beforeCounts = new Map<string, number>();
  const taskPattern = /^\s*[-*+]\s+\[ \]\s+\S/;
  const fencePattern = /^\s*(`{3,}|~{3,})/;
  let openFence: { char: "`" | "~"; length: number } | null = null;
  const lines = afterSource.split(/\r?\n/);
  const cleanedLines: string[] = [];
  const removed: string[] = [];

  for (const line of parseUncheckedTodoLines(beforeSource).map(normalizeUncheckedTodoIdentity)) {
    beforeCounts.set(line, (beforeCounts.get(line) ?? 0) + 1);
  }

  for (const line of lines) {
    const fenceMatch = line.match(fencePattern);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const char = marker[0] as "`" | "~";
      const length = marker.length;

      if (openFence === null) {
        openFence = { char, length };
      } else if (openFence.char === char && length >= openFence.length) {
        openFence = null;
      }

      cleanedLines.push(line);
      continue;
    }

    if (openFence !== null || !taskPattern.test(line)) {
      cleanedLines.push(line);
      continue;
    }

    const identity = normalizeUncheckedTodoIdentity(line);
    const availableBeforeCount = beforeCounts.get(identity) ?? 0;
    if (availableBeforeCount > 0) {
      beforeCounts.set(identity, availableBeforeCount - 1);
      cleanedLines.push(line);
      continue;
    }

    removed.push(identity);
  }

  if (removed.length === 0) {
    return { cleaned: afterSource, removed };
  }

  return {
    cleaned: cleanedLines.join(afterSource.includes("\r\n") ? "\r\n" : "\n"),
    removed,
  };
}

/** Normalizes unchecked TODO list lines to canonical identity form. */
function normalizeUncheckedTodoIdentity(line: string): string {
  const normalized = line.replace(/^\s*[-*+]\s+\[ \]\s+/, "- [ ] ").trim();
  const content = normalized.replace(/^- \[ \]\s+/, "").replace(/\s+/g, " ").trim();
  return content.length === 0 ? "" : `- [ ] ${content}`;
}
