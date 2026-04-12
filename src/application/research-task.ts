import { getTraceInstructions } from "../domain/defaults.js";
import { expandCliBlocks, extractCliBlocks } from "../domain/cli-block.js";
import { EXIT_CODE_FAILURE, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import {
  buildMemoryTemplateVars,
  renderTemplate,
  type TemplateVars,
} from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
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
  buildWorkspaceContextTemplateVars,
  mergeTemplateVarsWithWorkspaceContext,
  resolveRuntimeWorkspaceContext,
} from "./runtime-workspace-context.js";
import { FileLockError } from "../domain/ports/file-lock.js";
import { formatSuccessFailureSummary, pluralize } from "./run-task-utils.js";
import type {
  ArtifactRunContext,
  ArtifactStore,
  ArtifactStoreStatus,
  CommandExecutor,
  ConfigDirResult,
  FileLock,
  FileSystem,
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

/**
 * Ports required to execute the `research` command.
 */
export interface ResearchTaskDependencies {
  workerExecutor: WorkerExecutorPort;
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
    const workspaceContextTemplateVars = buildWorkspaceContextTemplateVars(runtimeWorkspaceContext);
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

        const updatedDocument = runResult.stdout;
        try {
          dependencies.fileSystem.writeText(source, updatedDocument);
        } catch {
          const message = "Research produced output, but failed to update Markdown document: " + source;
          emit({
            kind: "error",
            message,
          });
          emitResearchGroupFailure(message);
          return finishResearch(EXIT_CODE_FAILURE, "execution-failed");
        }

        if (hasCheckboxStateMutation(sourceDocument, updatedDocument)) {
          const violationMessage = "Research changed checkbox state in "
            + source
            + ". Research may enrich prose, but must not mark/unmark checkboxes.";
          emit({ kind: "error", message: violationMessage });
          restoreOriginalDocumentAfterViolation(
            dependencies.fileSystem,
            source,
            sourceDocument,
            emit,
          );
          emit({
            kind: "error",
            message: "Research update rejected due to constraint violation.",
          });
          emitResearchGroupFailure(violationMessage);
          return finishResearch(EXIT_CODE_FAILURE, "execution-failed");
        }

        const strippedTodos = stripIntroducedUncheckedTodos(sourceDocument, updatedDocument);
        if (strippedTodos.removed.length > 0) {
          try {
            dependencies.fileSystem.writeText(source, strippedTodos.cleaned);
          } catch {
            const message = "Research produced output, but failed to update Markdown document: " + source;
            emit({
              kind: "error",
              message,
            });
            emitResearchGroupFailure(message);
            return finishResearch(EXIT_CODE_FAILURE, "execution-failed");
          }

          emit({
            kind: "warn",
            message: "Research introduced new unchecked TODO items in "
              + source
              + ". Removed "
              + strippedTodos.removed.length
              + " "
              + pluralize(strippedTodos.removed.length, "introduced item", "introduced items")
              + ": "
              + strippedTodos.removed.join("; ")
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

/**
 * Restores the original source content after a constraint violation.
 */
function restoreOriginalDocumentAfterViolation(
  fileSystem: FileSystem,
  source: string,
  sourceDocument: string,
  emit: ApplicationOutputPort["emit"],
): void {
  try {
    fileSystem.writeText(source, sourceDocument);
  } catch {
    emit({
      kind: "error",
      message: "Research constraint violation detected, but failed to restore original Markdown document: " + source,
    });
  }
}

/** Normalizes unchecked TODO list lines to canonical identity form. */
function normalizeUncheckedTodoIdentity(line: string): string {
  const normalized = line.replace(/^\s*[-*+]\s+\[ \]\s+/, "- [ ] ").trim();
  const content = normalized.replace(/^- \[ \]\s+/, "").replace(/\s+/g, " ").trim();
  return content.length === 0 ? "" : `- [ ] ${content}`;
}
