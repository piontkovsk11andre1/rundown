import path from "node:path";
import {
  DEFAULT_MIGRATE_TEMPLATE,
  DEFAULT_TRANSLATE_TEMPLATE,
} from "../domain/defaults.js";
import {
  formatMigrationFilename,
  parseMigrationDirectory,
  parseMigrationFilename,
} from "../domain/migration-parser.js";
import { parseTasks, type Task } from "../domain/parser.js";
import type {
  ArtifactStore,
  FileSystem,
  TaskRepairPort,
  TaskVerificationPort,
  TraceWriterPort,
  VerificationStore,
  SourceResolverPort,
  TemplateLoader,
  WorkerConfigPort,
  WorkerExecutorPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { InteractiveInputPort } from "../domain/ports/interactive-input-port.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { resolveWorkerPatternForInvocation } from "./resolve-worker.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import { renderTranslatePrompt } from "./translate-task.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import {
  discoverDesignRevisionDirectories,
  findLowestUnplannedRevision,
  formatDesignRevisionUnifiedDiff,
  formatRevisionDesignContext,
  markRevisionPlanned,
  prepareDesignRevisionDiffContext,
  saveDesignRevisionSnapshot,
  materializeDesignReconciliationFromSource,
  type DesignRevisionDiffContext,
} from "./design-context.js";
import { runVerifyRepairLoop } from "./verify-repair-loop.js";
import {
  resolveArchiveWorkspacePaths,
  resolveMigrationThreadArchivePath,
  validateWorkspaceBucketRootDirectory,
  resolveWorkspaceDirectories,
  resolveWorkspacePaths,
  resolveWorkspacePath,
} from "./workspace-paths.js";
import { resolveWorkspaceRootForPathSensitiveCommand } from "./workspace-selection.js";
import type { AutoCompactCommandOptions } from "./post-command-auto-compact.js";

export interface MigrateTaskOptions {
  action?: string;
  title?: string;
  dir?: string;
  workspace?: string;
  sourceMode?: MigrateSourceMode;
  fromFile?: string;
  autoCompact?: AutoCompactCommandOptions;
  confirm?: boolean;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern?: ParsedWorkerPattern;
  keepArtifacts?: boolean;
  showAgentOutput?: boolean;
}

export type MigrateSourceMode = "design" | "implementation" | "prediction";

interface FileInputPlanningContext {
  sourcePath: string;
  sourcePathFromWorkspace: string;
  revisionName: string;
  revisionDiff: DesignRevisionDiffContext;
}

export interface MigrateTaskDependencies {
  workerExecutor: WorkerExecutorPort;
  fileSystem: FileSystem;
  traceWriter: TraceWriterPort;
  templateLoader: TemplateLoader;
  sourceResolver: SourceResolverPort;
  workerConfigPort: WorkerConfigPort;
  artifactStore: ArtifactStore;
  configDir?: string;
  interactiveInput: InteractiveInputPort;
  output: ApplicationOutputPort;
  runExplore: (source: string, cwd: string) => Promise<number>;
  runTask?: (options: {
    source: string;
    cwd?: string;
    invocationDir?: string;
    workspaceDir?: string;
    workspaceLinkPath?: string;
    isLinkedWorkspace?: boolean;
    mode: "wait";
    workerPattern: ParsedWorkerPattern;
    sortMode: "name-sort";
    verify: true;
    onlyVerify: false;
    forceExecute: false;
    forceAttempts: 2;
    noRepair: false;
    repairAttempts: 1;
    dryRun: false;
    printPrompt: false;
    keepArtifacts: boolean;
    varsFileOption: undefined;
    cliTemplateVarArgs: [];
    commitAfterComplete: true;
    commitMode: "per-task";
    runAll: true;
    redo: false;
    resetAfter: false;
    clean: false;
    rounds: 1;
    showAgentOutput: boolean;
    trace: false;
    traceOnly: false;
    forceUnlock: false;
    ignoreCliBlock: false;
    verbose: false;
  }) => Promise<number>;
  undoTask?: (options: {
    runId: string;
    last?: number;
    workerPattern: ParsedWorkerPattern;
    force?: boolean;
    dryRun?: boolean;
    keepArtifacts?: boolean;
    showAgentOutput?: boolean;
  }) => Promise<number>;
  revertTask?: (options: {
    runId: string;
    method: "revert" | "reset";
    dryRun: boolean;
    keepArtifacts: boolean;
    force: boolean;
  }) => Promise<number>;
}

export interface DiscoveredMigrationThread {
  fileName: string;
  sourcePath: string;
  sourcePathFromWorkspace: string;
  threadName: string;
  threadSlug: string;
}

export interface LoadedMigrationThreadState {
  thread: DiscoveredMigrationThread;
  migrationsDir: string;
  archivedMigrationsDir?: string;
  state: ReturnType<typeof readMigrationState>;
}

export interface MaterializedMigrationThreadBrief {
  thread: DiscoveredMigrationThread;
  outputPath: string;
  outputPathFromWorkspace: string;
}

export function createMigrateTask(
  dependencies: MigrateTaskDependencies,
): (options: MigrateTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function migrateTask(options: MigrateTaskOptions): Promise<number> {
    const invocationDir = process.cwd();
    const workspaceSelection = resolveWorkspaceRootForPathSensitiveCommand({
      fileSystem: dependencies.fileSystem,
      invocationDir,
      workspaceOption: options.workspace,
    });
    if (!workspaceSelection.ok) {
      emit({ kind: "error", message: workspaceSelection.message });
      return EXIT_CODE_FAILURE;
    }

    const workspaceRoot = workspaceSelection.workspaceRoot;
    const executionContext = workspaceSelection.executionContext;
    const workspaceDirectories = resolveWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const workspacePaths = resolveWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
    });
    const migrationsDir = resolveWorkspacePath({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
      bucket: "migrations",
      overrideDir: options.dir,
    });

    if (!dependencies.fileSystem.exists(migrationsDir)) {
      emit({ kind: "error", message: "Migrations directory does not exist: " + migrationsDir });
      return EXIT_CODE_FAILURE;
    }

    const rawAction = options.action;
    const normalizedAction = rawAction?.trim().toLowerCase();
    if (normalizedAction === "new") {
      const title = options.title?.trim();
      if (!title) {
        emit({ kind: "error", message: "Missing required title for `migrate new <title>`." });
        return EXIT_CODE_FAILURE;
      }

      const creation = createNewMigrationShortcut({
        fileSystem: dependencies.fileSystem,
        migrationsDir,
        archivedMigrationsDir: resolveMigrationArchiveScopeForShortcut({
          fileSystem: dependencies.fileSystem,
          workspaceRoot,
          invocationRoot: executionContext.invocationDir,
          workspaceMigrationsDir: workspacePaths.migrations,
          migrationScopeDir: migrationsDir,
        }),
        title,
      });
      if (!creation.ok) {
        emit({ kind: "error", message: creation.message });
        return EXIT_CODE_FAILURE;
      }

      emit({
        kind: "success",
        message: "Created migration " + creation.fileName + ".",
      });
      return EXIT_CODE_SUCCESS;
    }

    if (rawAction !== undefined && rawAction.trim().length > 0) {
      emit({
        kind: "error",
        message: "Invalid migrate action: " + rawAction + ".",
      });
      return EXIT_CODE_FAILURE;
    }
    const projectRoot = workspaceRoot;
    const configDir = path.join(projectRoot, ".rundown");
    const loadedWorkerConfig = dependencies.fileSystem.exists(configDir)
      ? dependencies.workerConfigPort.load(configDir)
      : undefined;
    const workerTimeoutMs = loadedWorkerConfig?.workerTimeoutMs;
    const resolvedWorker = resolveWorkerPatternForInvocation({
      commandName: "migrate",
      workerConfig: loadedWorkerConfig,
      cliWorkerPattern: options.workerPattern,
      emit,
      mode: "wait",
    });
    const resolvedSlugWorker = resolveWorkerPatternForInvocation({
      commandName: "migrate-slug",
      workerConfig: loadedWorkerConfig,
      cliWorkerPattern: options.slugWorkerPattern,
      fallbackWorkerCommand: resolvedWorker.workerCommand,
      emit,
      mode: "wait",
    });
    const slugWorkerPattern = resolvedSlugWorker.workerPattern;

    if (resolvedWorker.workerCommand.length === 0) {
      emit({
        kind: "error",
        message:
          "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.",
      });
      return EXIT_CODE_FAILURE;
    }

    const artifactContext = dependencies.artifactStore.createContext({
      cwd: workspaceRoot,
      configDir,
      commandName: "migrate",
      workerCommand: resolvedWorker.workerCommand,
      mode: "wait",
      source: migrationsDir,
      keepArtifacts: Boolean(options.keepArtifacts),
    });

    const artifactRunExtra: Record<string, unknown> = {};
    const sourceMode = options.sourceMode ?? "design";
    artifactRunExtra.sourceMode = sourceMode;

    try {
      const exitCode = await runMigrateLoop({
        dependencies,
        migrationsDir,
        projectRoot,
        invocationRoot: executionContext.invocationDir,
        workspaceRoot,
        workspaceDirectories,
        workspacePaths,
        workerPattern: resolvedWorker.workerPattern,
        slugWorkerPattern,
        sourceMode,
        fromFile: options.fromFile,
        workerTimeoutMs,
        artifactContext,
        keepArtifacts: Boolean(options.keepArtifacts),
        showAgentOutput: Boolean(options.showAgentOutput),
        executionContext,
        confirm: Boolean(options.confirm),
        artifactRunExtra,
      });

      const finalizeExtra = Object.keys(artifactRunExtra).length > 0
        ? artifactRunExtra
        : undefined;
      dependencies.artifactStore.finalize(artifactContext, {
        status: exitCode === EXIT_CODE_SUCCESS ? "completed" : "failed",
        preserve: shouldPreserveArtifactsForMigrateRun({
          keepArtifacts: Boolean(options.keepArtifacts),
          exitCode,
          artifactRunExtra,
        }),
        extra: finalizeExtra,
      });
      return exitCode;
    } catch (error) {
      const finalizeExtra: Record<string, unknown> = {
        ...artifactRunExtra,
        error: error instanceof Error ? error.message : String(error),
      };
      dependencies.artifactStore.finalize(artifactContext, {
        status: "failed",
        preserve: shouldPreserveArtifactsForMigrateRun({
          keepArtifacts: Boolean(options.keepArtifacts),
          exitCode: EXIT_CODE_FAILURE,
          artifactRunExtra: finalizeExtra,
        }),
        extra: finalizeExtra,
      });
      emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return EXIT_CODE_FAILURE;
    }
  };
}

function isDirectory(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isDirectory === true;
}

function shouldPreserveArtifactsForMigrateRun(input: {
  keepArtifacts: boolean;
  exitCode: number;
  artifactRunExtra: Record<string, unknown>;
}): boolean {
  if (input.keepArtifacts) {
    return true;
  }

  if (input.exitCode === EXIT_CODE_SUCCESS) {
    return false;
  }

  return input.artifactRunExtra.stagedDraftMigrationDirPrepared === true;
}

async function runMigrateLoop(input: {
  dependencies: MigrateTaskDependencies;
  migrationsDir: string;
  projectRoot: string;
  invocationRoot: string;
  workspaceRoot: string;
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern: ParsedWorkerPattern;
  sourceMode: MigrateSourceMode;
  fromFile?: string;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  workerTimeoutMs?: number;
  keepArtifacts: boolean;
  executionContext: {
    invocationDir: string;
    workspaceDir: string;
    workspaceLinkPath: string;
    isLinkedWorkspace: boolean;
  };
  confirm: boolean;
  showAgentOutput: boolean;
  artifactRunExtra: Record<string, unknown>;
}): Promise<number> {
  const {
    dependencies,
    migrationsDir,
    projectRoot,
    invocationRoot,
    workspaceRoot,
    workspaceDirectories,
    workspacePaths,
    workerPattern,
    slugWorkerPattern,
    sourceMode,
    fromFile,
    artifactContext,
    workerTimeoutMs,
    keepArtifacts,
    executionContext,
    confirm,
    showAgentOutput,
    artifactRunExtra,
  } = input;
  const emit = dependencies.output.emit.bind(dependencies.output);
  const planningTemplate = readTemplate(
    dependencies.templateLoader,
    projectRoot,
    "migrate.md",
    DEFAULT_MIGRATE_TEMPLATE,
  );
  const translateTemplate = readTemplate(
    dependencies.templateLoader,
    projectRoot,
    "translate.md",
    DEFAULT_TRANSLATE_TEMPLATE,
  );
  const archivePaths = resolveArchiveWorkspacePaths({
    fileSystem: dependencies.fileSystem,
    workspaceRoot,
    invocationRoot,
  });
  const discoveredThreads = discoverMigrationThreads(dependencies.fileSystem, projectRoot);
  const loadedThreadStates = loadMigrationThreadStates({
    fileSystem: dependencies.fileSystem,
    migrationsDir,
    archivedThreadsDir: archivePaths.migrationThreads,
    threads: discoveredThreads,
  });
  if (discoveredThreads.length > 0) {
    artifactRunExtra.migrationThreads = loadedThreadStates.map(({ thread, migrationsDir: threadMigrationsDir, state }) => ({
      fileName: thread.fileName,
      sourcePathFromWorkspace: thread.sourcePathFromWorkspace,
      threadSlug: thread.threadSlug,
      migrationsDir: toWorkspaceRelativeMigrationPath(workspaceRoot, threadMigrationsDir),
      currentPosition: state.currentPosition,
    }));
  }
  let processedAnyRevision = false;
  let completedRevisionCount = 0;

  if (fromFile) {
    if (sourceMode !== "design") {
      emit({
        kind: "error",
        message: "Invalid migrate options: --from-file cannot be combined with --from.",
      });
      artifactRunExtra.outcome = "invalid-source-mode-combination";
      return EXIT_CODE_FAILURE;
    }

    const fileInputPlanningContext = resolveFileInputPlanningContext({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot,
      fromFile,
    });
    if (!fileInputPlanningContext.ok) {
      emit({ kind: "error", message: fileInputPlanningContext.message });
      artifactRunExtra.outcome = "file-input-resolution-failed";
      return EXIT_CODE_FAILURE;
    }

    artifactRunExtra.sourceMode = "file-input";
    artifactRunExtra.fileInput = {
      sourcePathFromWorkspace: fileInputPlanningContext.context.sourcePathFromWorkspace,
    };
    artifactRunExtra.sourceReconciliation = {
      mode: "file-input",
      changed: null,
      sourceRoot: null,
      outputPath: fileInputPlanningContext.context.sourcePath,
    };

    return runMigrateFileInputPlanning({
      dependencies,
      planningTemplate,
      translateTemplate,
      workspaceRoot,
      projectRoot,
      invocationRoot,
      workspaceDirectories,
      workspacePaths,
      slugWorkerPattern,
      artifactContext,
      workerTimeoutMs,
      showAgentOutput,
      confirm,
      emit,
      migrationsDir,
      archivePaths,
      discoveredThreads,
      loadedThreadStates,
      artifactRunExtra,
      fileInput: fileInputPlanningContext.context,
    });
  }

  const sourceReconciliation = runMigrateSourceReconciliationPreflight({
    fileSystem: dependencies.fileSystem,
    sourceMode,
    workspaceRoot,
    invocationRoot,
    workspacePaths,
    emit,
  });
  if (!sourceReconciliation.ok) {
    artifactRunExtra.outcome = "source-reconciliation-failed";
    return sourceReconciliation.exitCode;
  }
  artifactRunExtra.sourceReconciliation = sourceReconciliation.metadata;

  const preflightExitCode = runDesignRevisionReleasePreflight({
    fileSystem: dependencies.fileSystem,
    workspaceRoot,
    invocationRoot,
    emit,
  });
  if (preflightExitCode !== EXIT_CODE_SUCCESS) {
    return preflightExitCode;
  }

  for (;;) {
    const targetRevision = findLowestUnplannedRevision(
      dependencies.fileSystem,
      workspaceRoot,
      { invocationRoot },
    );
    if (!targetRevision) {
      if (!processedAnyRevision) {
        const releasedRevisions = discoverDesignRevisionDirectories(
          dependencies.fileSystem,
          workspaceRoot,
          { invocationRoot },
        );
        const highestReleasedRevision = releasedRevisions[releasedRevisions.length - 1];
        const sourceModeLabel = sourceMode === "design" ? "default design-diff" : "--from " + sourceMode;
        if (sourceReconciliation.metadata.changed === false) {
          artifactRunExtra.outcome = "reconciliation-no-op-caught-up";
          if (highestReleasedRevision) {
            emit({
              kind: "info",
              message: "Migrate "
                + sourceModeLabel
                + " produced no effective design boundary change; migrations are already caught up to "
                + highestReleasedRevision.name
                + ".",
            });
          } else {
            emit({
              kind: "info",
              message: "Migrate "
                + sourceModeLabel
                + " produced no effective design boundary change and there are no released design revisions yet.",
            });
          }
          return EXIT_CODE_SUCCESS;
        }
        if (highestReleasedRevision) {
          artifactRunExtra.outcome = "caught-up";
          emit({
            kind: "info",
            message:
              "Migrations are caught up to "
              + highestReleasedRevision.name
              + " (highest released revision, source mode "
              + sourceModeLabel
              + "). Edit design/current/ and run rundown migrate to release and plan the next revision.",
          });
        } else {
          artifactRunExtra.outcome = "no-released-revisions";
          emit({
            kind: "info",
            message: "No released design revisions yet (source mode "
              + sourceModeLabel
              + "). Add design/current/ and run rundown migrate to bootstrap rev.0.",
          });
        }
      }
      if (processedAnyRevision && typeof artifactRunExtra.outcome !== "string") {
        artifactRunExtra.outcome = "revisions-planned";
      }
      return EXIT_CODE_SUCCESS;
    }
    processedAnyRevision = true;

    const revisionDiff = prepareDesignRevisionDiffContext(dependencies.fileSystem, projectRoot, {
      invocationRoot,
      target: targetRevision.name,
    });
    const materializedThreadBriefs = await materializeMigrationThreadBriefs({
      fileSystem: dependencies.fileSystem,
      workerExecutor: dependencies.workerExecutor,
      output: dependencies.output,
      workerPattern: slugWorkerPattern,
      workspaceRoot,
      artifactContext,
      revisionName: targetRevision.name,
      revisionDiff,
      threads: discoveredThreads,
      translateTemplate,
      workerTimeoutMs,
      showAgentOutput,
    });
    if (materializedThreadBriefs.length > 0) {
      const threadTranslationHistory = Array.isArray(artifactRunExtra.threadTranslations)
        ? artifactRunExtra.threadTranslations as Array<{
          revision: string;
          threadSlug: string;
          sourcePathFromWorkspace: string;
          outputPathFromWorkspace: string;
        }>
        : [];
      threadTranslationHistory.push(...materializedThreadBriefs.map((brief) => ({
        revision: targetRevision.name,
        threadSlug: brief.thread.threadSlug,
        sourcePathFromWorkspace: brief.thread.sourcePathFromWorkspace,
        outputPathFromWorkspace: brief.outputPathFromWorkspace,
      })));
      artifactRunExtra.threadTranslations = threadTranslationHistory;
    }
    const rootState = readMigrationStateFromDirectoryOrEmpty(
      dependencies.fileSystem,
      migrationsDir,
      archivePaths.migrationRootLane,
    );
    const laneStates = discoveredThreads.length > 0
      ? loadedThreadStates.map((lane) => ({
        kind: "thread" as const,
        thread: lane.thread,
        migrationsDir: lane.migrationsDir,
        state: lane.state,
        archivedMigrationsDir: lane.archivedMigrationsDir,
        migrationDraftDir: prepareStagedDraftMigrationDir(
          dependencies.fileSystem,
          artifactContext.rootDir,
          targetRevision.name,
          lane.thread.threadSlug,
        ),
      }))
      : [{
        kind: "root" as const,
        migrationsDir,
        state: rootState,
        archivedMigrationsDir: archivePaths.migrationRootLane,
        migrationDraftDir: prepareStagedDraftMigrationDir(
          dependencies.fileSystem,
          artifactContext.rootDir,
          targetRevision.name,
        ),
      }];
    artifactRunExtra.stagedDraftMigrationDirPrepared = true;
    artifactRunExtra.stagedDraftMigrationDir = laneStates[0]?.migrationDraftDir;
    artifactRunExtra.stagedDraftMigrationDirs = laneStates.map((lane) => ({
      kind: lane.kind,
      migrationDraftDir: lane.migrationDraftDir,
      ...(lane.kind === "thread"
        ? { threadSlug: lane.thread.threadSlug, threadName: lane.thread.threadName }
        : {}),
    }));
    artifactRunExtra.stagedDraftRevision = targetRevision.name;

    const laneResults: Array<{
      migrationsDir: string;
      promotedMigrationMetadataPaths: string[];
      promotedMigrationPaths: string[];
      state: ReturnType<typeof readMigrationState>;
      migrationDraftDir: string;
      thread?: DiscoveredMigrationThread;
      errorMessage?: string;
    }> = [];
    const laneFailures: Array<{ thread?: DiscoveredMigrationThread; errorMessage: string }> = [];

    for (const lane of laneStates) {
      const result = await runMigrationLaneDrafting({
        dependencies,
        planningTemplate,
        workspaceRoot,
        projectRoot,
        invocationRoot,
        workspaceDirectories,
        workspacePaths,
        slugWorkerPattern,
        artifactContext,
        workerTimeoutMs,
        showAgentOutput,
        confirm,
        emit,
        targetRevisionName: targetRevision.name,
        revisionDiff,
        migrationsDir: lane.migrationsDir,
        archivedMigrationsDir: lane.archivedMigrationsDir,
        state: lane.state,
        migrationDraftDir: lane.migrationDraftDir,
        thread: lane.kind === "thread" ? lane.thread : undefined,
      });
      laneResults.push({
        migrationsDir: lane.migrationsDir,
        promotedMigrationMetadataPaths: result.promotedMigrationMetadataPaths,
        promotedMigrationPaths: result.promotedMigrationPaths,
        state: lane.state,
        migrationDraftDir: lane.migrationDraftDir,
        thread: lane.kind === "thread" ? lane.thread : undefined,
        errorMessage: result.ok ? undefined : result.errorMessage,
      });

      if (!result.ok) {
        laneFailures.push({
          thread: lane.kind === "thread" ? lane.thread : undefined,
          errorMessage: result.errorMessage,
        });
      }
    }

    if (completedRevisionCount === 0) {
      for (const lane of laneResults) {
        if (lane.errorMessage) {
          continue;
        }
        for (const migrationPath of lane.promotedMigrationPaths) {
          await runExploreForMigration({
            runExplore: dependencies.runExplore,
            migrationPath,
            projectRoot,
          });
        }
      }
    }

    if (laneFailures.length > 0) {
      const failureSummary = laneFailures.map((failure) => {
        const laneLabel = failure.thread ? "thread " + failure.thread.threadSlug : "root lane";
        return laneLabel + ": " + failure.errorMessage;
      }).join("; ");
      throw new Error("One or more migration lanes failed: " + failureSummary);
    }

    const promotedMigrationMetadataPaths = laneResults.flatMap((lane) => lane.promotedMigrationMetadataPaths);
    if (promotedMigrationMetadataPaths.length === 0 && revisionDiff.changes.length === 0) {
      emit({
        kind: "info",
        message: "Planner drafted no migrations for " + targetRevision.name + ": no diff changes detected.",
      });
      markRevisionPlanned(
        dependencies.fileSystem,
        workspaceRoot,
        targetRevision.name,
        [],
      );
      completedRevisionCount += 1;
      if (discoveredThreads.length > 0) {
        artifactRunExtra.outcome = "revisions-planned";
        return EXIT_CODE_SUCCESS;
      }
      continue;
    }

    markRevisionPlanned(
      dependencies.fileSystem,
      workspaceRoot,
      targetRevision.name,
      promotedMigrationMetadataPaths,
    );
    completedRevisionCount += 1;
    if (discoveredThreads.length > 0) {
      artifactRunExtra.outcome = "revisions-planned";
      return EXIT_CODE_SUCCESS;
    }
  }
}

function resolveFileInputPlanningContext(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  fromFile: string;
}):
  | { ok: true; context: FileInputPlanningContext }
  | { ok: false; message: string } {
  const { fileSystem, workspaceRoot, invocationRoot, fromFile } = input;
  const sourcePath = path.isAbsolute(fromFile)
    ? fromFile
    : path.resolve(invocationRoot, fromFile);

  if (!fileSystem.exists(sourcePath)) {
    return {
      ok: false,
      message: "Cannot run migrate --from-file: source file does not exist at " + sourcePath,
    };
  }

  const stat = fileSystem.stat(sourcePath);
  if (!stat?.isFile) {
    return {
      ok: false,
      message: "Cannot run migrate --from-file: source path is not a file at " + sourcePath,
    };
  }

  const sourcePathFromWorkspace = toWorkspaceRelativeMigrationPath(workspaceRoot, sourcePath);
  const relativePath = "Target.md";
  const revisionName = "file-input";

  return {
    ok: true,
    context: {
      sourcePath,
      sourcePathFromWorkspace,
      revisionName,
      revisionDiff: {
        fromRevision: null,
        toTarget: {
          kind: "current",
          name: revisionName,
          absolutePath: sourcePath,
          metadata: {
            createdAt: "",
            label: "",
            plannedAt: null,
            migrations: [],
          },
          metadataPath: "",
        },
        hasComparison: false,
        summary: "File-input planning source: " + sourcePathFromWorkspace,
        addedCount: 0,
        removedCount: 0,
        modifiedCount: 0,
        changes: [
          {
            relativePath,
            kind: "modified",
            fromPath: sourcePath,
            toPath: sourcePath,
          },
        ],
        sourceReferences: [sourcePath],
      },
    },
  };
}

async function runMigrateFileInputPlanning(input: {
  dependencies: MigrateTaskDependencies;
  planningTemplate: string;
  translateTemplate: string;
  workspaceRoot: string;
  projectRoot: string;
  invocationRoot: string;
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  slugWorkerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  workerTimeoutMs?: number;
  showAgentOutput: boolean;
  confirm: boolean;
  emit: ApplicationOutputPort["emit"];
  migrationsDir: string;
  archivePaths: ReturnType<typeof resolveArchiveWorkspacePaths>;
  discoveredThreads: DiscoveredMigrationThread[];
  loadedThreadStates: LoadedMigrationThreadState[];
  artifactRunExtra: Record<string, unknown>;
  fileInput: FileInputPlanningContext;
}): Promise<number> {
  const {
    dependencies,
    planningTemplate,
    translateTemplate,
    workspaceRoot,
    projectRoot,
    invocationRoot,
    workspaceDirectories,
    workspacePaths,
    slugWorkerPattern,
    artifactContext,
    workerTimeoutMs,
    showAgentOutput,
    confirm,
    emit,
    migrationsDir,
    archivePaths,
    discoveredThreads,
    loadedThreadStates,
    artifactRunExtra,
    fileInput,
  } = input;

  emit({
    kind: "info",
    message: "Planning migrations from explicit source file " + fileInput.sourcePathFromWorkspace + ".",
  });

  const materializedThreadBriefs = await materializeMigrationThreadBriefs({
    fileSystem: dependencies.fileSystem,
    workerExecutor: dependencies.workerExecutor,
    output: dependencies.output,
    workerPattern: slugWorkerPattern,
    workspaceRoot,
    artifactContext,
    revisionName: fileInput.revisionName,
    revisionDiff: fileInput.revisionDiff,
    threads: discoveredThreads,
    translateTemplate,
    workerTimeoutMs,
    showAgentOutput,
  });
  if (materializedThreadBriefs.length > 0) {
    const threadTranslationHistory = Array.isArray(artifactRunExtra.threadTranslations)
      ? artifactRunExtra.threadTranslations as Array<{
        revision: string;
        threadSlug: string;
        sourcePathFromWorkspace: string;
        outputPathFromWorkspace: string;
      }>
      : [];
    threadTranslationHistory.push(...materializedThreadBriefs.map((brief) => ({
      revision: fileInput.revisionName,
      threadSlug: brief.thread.threadSlug,
      sourcePathFromWorkspace: brief.thread.sourcePathFromWorkspace,
      outputPathFromWorkspace: brief.outputPathFromWorkspace,
    })));
    artifactRunExtra.threadTranslations = threadTranslationHistory;
  }

  const rootState = readMigrationStateFromDirectoryOrEmpty(
    dependencies.fileSystem,
    migrationsDir,
    archivePaths.migrationRootLane,
  );
  const laneStates = discoveredThreads.length > 0
    ? loadedThreadStates.map((lane) => ({
      kind: "thread" as const,
      thread: lane.thread,
      migrationsDir: lane.migrationsDir,
      state: lane.state,
      archivedMigrationsDir: lane.archivedMigrationsDir,
      migrationDraftDir: prepareStagedDraftMigrationDir(
        dependencies.fileSystem,
        artifactContext.rootDir,
        fileInput.revisionName,
        lane.thread.threadSlug,
      ),
    }))
    : [{
      kind: "root" as const,
      migrationsDir,
      state: rootState,
      archivedMigrationsDir: archivePaths.migrationRootLane,
      migrationDraftDir: prepareStagedDraftMigrationDir(
        dependencies.fileSystem,
        artifactContext.rootDir,
        fileInput.revisionName,
      ),
    }];

  artifactRunExtra.stagedDraftMigrationDirPrepared = true;
  artifactRunExtra.stagedDraftMigrationDir = laneStates[0]?.migrationDraftDir;
  artifactRunExtra.stagedDraftMigrationDirs = laneStates.map((lane) => ({
    kind: lane.kind,
    migrationDraftDir: lane.migrationDraftDir,
    ...(lane.kind === "thread"
      ? { threadSlug: lane.thread.threadSlug, threadName: lane.thread.threadName }
      : {}),
  }));
  artifactRunExtra.stagedDraftRevision = fileInput.revisionName;

  const laneResults: Array<{
    migrationsDir: string;
    promotedMigrationMetadataPaths: string[];
    promotedMigrationPaths: string[];
    state: ReturnType<typeof readMigrationState>;
    migrationDraftDir: string;
    thread?: DiscoveredMigrationThread;
    errorMessage?: string;
  }> = [];
  const laneFailures: Array<{ thread?: DiscoveredMigrationThread; errorMessage: string }> = [];

  for (const lane of laneStates) {
    const result = await runMigrationLaneDrafting({
      dependencies,
      planningTemplate,
      workspaceRoot,
      projectRoot,
      invocationRoot,
      workspaceDirectories,
      workspacePaths,
      slugWorkerPattern,
      artifactContext,
      workerTimeoutMs,
      showAgentOutput,
      confirm,
      emit,
      targetRevisionName: fileInput.revisionName,
      revisionDiff: fileInput.revisionDiff,
      migrationsDir: lane.migrationsDir,
      archivedMigrationsDir: lane.archivedMigrationsDir,
      state: lane.state,
      migrationDraftDir: lane.migrationDraftDir,
      thread: lane.kind === "thread" ? lane.thread : undefined,
    });
    laneResults.push({
      migrationsDir: lane.migrationsDir,
      promotedMigrationMetadataPaths: result.promotedMigrationMetadataPaths,
      promotedMigrationPaths: result.promotedMigrationPaths,
      state: lane.state,
      migrationDraftDir: lane.migrationDraftDir,
      thread: lane.kind === "thread" ? lane.thread : undefined,
      errorMessage: result.ok ? undefined : result.errorMessage,
    });

    if (!result.ok) {
      laneFailures.push({
        thread: lane.kind === "thread" ? lane.thread : undefined,
        errorMessage: result.errorMessage,
      });
    }
  }

  for (const lane of laneResults) {
    if (lane.errorMessage) {
      continue;
    }
    for (const migrationPath of lane.promotedMigrationPaths) {
      await runExploreForMigration({
        runExplore: dependencies.runExplore,
        migrationPath,
        projectRoot,
      });
    }
  }

  if (laneFailures.length > 0) {
    const failureSummary = laneFailures.map((failure) => {
      const laneLabel = failure.thread ? "thread " + failure.thread.threadSlug : "root lane";
      return laneLabel + ": " + failure.errorMessage;
    }).join("; ");
    throw new Error("One or more migration lanes failed: " + failureSummary);
  }

  artifactRunExtra.outcome = "file-input-planned";
  return EXIT_CODE_SUCCESS;
}
function runMigrateSourceReconciliationPreflight(input: {
  fileSystem: FileSystem;
  sourceMode: MigrateSourceMode;
  workspaceRoot: string;
  invocationRoot: string;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  emit: ApplicationOutputPort["emit"];
}):
  | {
    ok: true;
    metadata: {
      mode: MigrateSourceMode;
      changed: boolean | null;
      sourceRoot: string | null;
      outputPath: string | null;
    };
  }
  | {
    ok: false;
    exitCode: number;
  } {
  const { fileSystem, sourceMode, workspaceRoot, invocationRoot, workspacePaths, emit } = input;

  if (sourceMode === "design") {
    return {
      ok: true,
      metadata: {
        mode: sourceMode,
        changed: null,
        sourceRoot: null,
        outputPath: null,
      },
    };
  }

  const sourceBucket = sourceMode === "implementation" ? "implementation" : "prediction";
  const sourceRootValidation = validateWorkspaceBucketRootDirectory({
    fileSystem,
    workspacePaths,
    bucket: sourceBucket,
  });
  if (!sourceRootValidation.ok) {
    emit({
      kind: "error",
      message: "Cannot run migrate --from "
        + sourceMode
        + ": "
        + sourceRootValidation.message,
    });
    return {
      ok: false,
      exitCode: EXIT_CODE_FAILURE,
    };
  }
  const sourceRoot = sourceRootValidation.absolutePath;

  emit({
    kind: "info",
    message: sourceMode === "implementation"
      ? "Reconciling design boundary from implementation changes before migration planning."
      : "Reconciling design boundary from prediction changes before migration planning.",
  });

  if (sourceMode === "implementation") {
    try {
      const reconcileResult = reconcileDesignFromImplementation({
        fileSystem,
        workspaceRoot,
        invocationRoot,
        workspacePaths,
      });
      emit({
        kind: "info",
        message: reconcileResult.changed
          ? "Implementation reconciliation updated design/current artifact at " + reconcileResult.outputPath + "."
          : "Implementation reconciliation detected no effective changes in " + reconcileResult.outputPath + ".",
      });
      return {
        ok: true,
        metadata: {
          mode: sourceMode,
          changed: reconcileResult.changed,
          sourceRoot,
          outputPath: reconcileResult.outputPath,
        },
      };
    } catch (error) {
      emit({
        kind: "error",
        message: "Implementation reconciliation failed: " + (error instanceof Error ? error.message : String(error)),
      });
      return {
        ok: false,
        exitCode: EXIT_CODE_FAILURE,
      };
    }
  }

  if (sourceMode === "prediction") {
    try {
      const reconcileResult = reconcileDesignFromPrediction({
        fileSystem,
        workspaceRoot,
        invocationRoot,
        workspacePaths,
      });
      emit({
        kind: "info",
        message: reconcileResult.changed
          ? "Prediction reconciliation updated design/current artifact at " + reconcileResult.outputPath + "."
          : "Prediction reconciliation detected no effective changes in " + reconcileResult.outputPath + ".",
      });
      return {
        ok: true,
        metadata: {
          mode: sourceMode,
          changed: reconcileResult.changed,
          sourceRoot,
          outputPath: reconcileResult.outputPath,
        },
      };
    } catch (error) {
      emit({
        kind: "error",
        message: "Prediction reconciliation failed: " + (error instanceof Error ? error.message : String(error)),
      });
      return {
        ok: false,
        exitCode: EXIT_CODE_FAILURE,
      };
    }
  }

  return {
    ok: true,
    metadata: {
      mode: sourceMode,
      changed: null,
      sourceRoot,
      outputPath: null,
    },
  };
}

function reconcileDesignFromImplementation(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}): { changed: boolean; outputPath: string } {
  const { fileSystem, workspaceRoot, invocationRoot, workspacePaths } = input;
  const result = materializeDesignReconciliationFromSource(fileSystem, workspaceRoot, {
    sourceMode: "implementation",
    sourceRoot: workspacePaths.implementation,
    invocationRoot,
  });
  return {
    changed: result.changed,
    outputPath: result.outputPath,
  };
}

function reconcileDesignFromPrediction(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
}): { changed: boolean; outputPath: string } {
  const { fileSystem, workspaceRoot, invocationRoot, workspacePaths } = input;
  const result = materializeDesignReconciliationFromSource(fileSystem, workspaceRoot, {
    sourceMode: "prediction",
    sourceRoot: workspacePaths.prediction,
    invocationRoot,
  });
  return {
    changed: result.changed,
    outputPath: result.outputPath,
  };
}

function runDesignRevisionReleasePreflight(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  emit: ApplicationOutputPort["emit"];
}): number {
  const { fileSystem, workspaceRoot, invocationRoot, emit } = input;

  try {
    const saveResult = saveDesignRevisionSnapshot(fileSystem, workspaceRoot, {
      invocationRoot,
    });
    if (saveResult.kind === "saved") {
      emit({
        kind: "info",
        message: "Released design revision " + saveResult.revision.name + " from current design before migration planning.",
      });
    }
    return EXIT_CODE_SUCCESS;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (
      errorMessage.includes("Design working directory is missing:")
      || errorMessage.includes("ENOENT")
    ) {
      return EXIT_CODE_SUCCESS;
    }
    emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    return EXIT_CODE_FAILURE;
  }
}

async function runMigrationLaneDrafting(input: {
  dependencies: MigrateTaskDependencies;
  planningTemplate: string;
  workspaceRoot: string;
  projectRoot: string;
  invocationRoot: string;
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  slugWorkerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  workerTimeoutMs?: number;
  showAgentOutput: boolean;
  confirm: boolean;
  emit: ApplicationOutputPort["emit"];
  targetRevisionName: string;
  revisionDiff: DesignRevisionDiffContext;
  migrationsDir: string;
  archivedMigrationsDir?: string;
  state: ReturnType<typeof readMigrationState>;
  migrationDraftDir: string;
  thread?: DiscoveredMigrationThread;
}): Promise<{
  ok: boolean;
  errorMessage: string;
  promotedMigrationPaths: string[];
  promotedMigrationMetadataPaths: string[];
}> {
  const {
    dependencies,
    planningTemplate,
    workspaceRoot,
    projectRoot,
    invocationRoot,
    workspaceDirectories,
    workspacePaths,
    slugWorkerPattern,
    artifactContext,
    workerTimeoutMs,
    showAgentOutput,
    confirm,
    emit,
    targetRevisionName,
    revisionDiff,
    migrationsDir,
    archivedMigrationsDir,
    state,
    migrationDraftDir,
    thread,
  } = input;

  const vars = buildTemplateVars({
    fileSystem: dependencies.fileSystem,
    state,
    projectRoot,
    invocationRoot,
    workspaceDirectories,
    workspacePaths,
    designRevisionTarget: targetRevisionName,
    revisionDiff,
    migrationDraftDir,
    newMigrations: "",
    threadContext: thread
      ? {
        mode: true,
        name: thread.threadName,
        slug: thread.threadSlug,
        sourcePathFromWorkspace: thread.sourcePathFromWorkspace,
        briefPathFromWorkspace: path.relative(workspaceRoot, path.join(artifactContext.rootDir, "thread-briefs", targetRevisionName, thread.threadSlug + ".md")).replace(/\\/g, "/"),
        translatedBrief: dependencies.fileSystem.exists(path.join(artifactContext.rootDir, "thread-briefs", targetRevisionName, thread.threadSlug + ".md"))
          ? dependencies.fileSystem.readText(path.join(artifactContext.rootDir, "thread-briefs", targetRevisionName, thread.threadSlug + ".md"))
          : "",
      }
      : undefined,
  });
  const prompt = renderTemplate(planningTemplate, vars);
  emit({
    kind: "info",
    message: "Planning migrations for "
      + (revisionDiff.fromRevision?.name ?? "nothing")
      + " → "
      + targetRevisionName
      + " (position "
      + String(state.currentPosition)
      + (thread ? ", thread " + thread.threadSlug : "")
      + ")...",
  });

  const result = await dependencies.workerExecutor.runWorker({
    workerPattern: slugWorkerPattern,
    prompt,
    mode: "wait",
    cwd: workspaceRoot,
    timeoutMs: workerTimeoutMs,
    artifactContext,
    artifactPhase: "worker",
    artifactPhaseLabel: thread ? "migrate-plan-thread" : "migrate-plan",
  });
  if ((result.exitCode ?? 1) !== 0) {
    return {
      ok: false,
      errorMessage: "Worker failed to generate migration plan.",
      promotedMigrationPaths: [],
      promotedMigrationMetadataPaths: [],
    };
  }
  if (showAgentOutput && result.stderr.length > 0) {
    emit({ kind: "stderr", text: result.stderr });
  }

  const syntheticTask = createSyntheticMigrateTask(
    path.join(migrationDraftDir, "_staged-migration-verification.md"),
    targetRevisionName,
  );
  const stagedVerificationStore = createInMemoryVerificationStore();
  const verifyStagedDraftTaskSet = async (): Promise<{ valid: boolean; stdout?: string }> => {
    const verification = verifyCurrentStagedDraftSet({
      fileSystem: dependencies.fileSystem,
      artifactRunRootDir: artifactContext.rootDir,
      revisionName: targetRevisionName,
      revisionDiff,
      currentPosition: state.currentPosition,
      migrationDraftDir,
      threadSlug: thread?.threadSlug,
    });
    const resultText = verification.valid
      ? "OK"
      : (verification.failureReason ?? "Verification failed (no details).");
    stagedVerificationStore.write(syntheticTask, resultText);
    return {
      valid: verification.valid,
      stdout: resultText,
    };
  };
  const stagedTaskVerification: TaskVerificationPort = {
    verify: async ({ onWorkerOutput }) => {
      const verification = await verifyStagedDraftTaskSet();
      if (onWorkerOutput) {
        onWorkerOutput(verification.stdout ?? "", "");
      }
      return verification;
    },
  };
  const stagedTaskRepair: TaskRepairPort = {
    repair: async ({ onWorkerOutput }) => {
      const previousFailure = stagedVerificationStore.read(syntheticTask)
        ?? "Verification failed (no details).";
      const repairPrompt = buildMigrateRepairPrompt({
        revisionName: targetRevisionName,
        migrationDraftDir,
        migrationsDir,
        currentPosition: state.currentPosition,
        failureReason: previousFailure,
        revisionDiff,
      });
      const migrationsDirSnapshotBeforeRepair = snapshotDirectoryContents(
        dependencies.fileSystem,
        migrationsDir,
      );
      const repairRunResult = await dependencies.workerExecutor.runWorker({
        workerPattern: slugWorkerPattern,
        prompt: repairPrompt,
        mode: "wait",
        cwd: workspaceRoot,
        timeoutMs: workerTimeoutMs,
        artifactContext,
        artifactPhase: "repair",
        artifactPhaseLabel: thread ? "migrate-staged-repair-thread" : "migrate-staged-repair",
        artifactExtra: {
          revision: targetRevisionName,
          migrationDraftDir,
          threadSlug: thread?.threadSlug,
        },
      });
      if (onWorkerOutput) {
        onWorkerOutput(repairRunResult.stdout, repairRunResult.stderr);
      }
      if ((repairRunResult.exitCode ?? 1) !== 0) {
        return {
          valid: false,
          attempts: 1,
          repairStdout: repairRunResult.stdout,
          verificationStdout: "Staged migration repair worker failed.",
        };
      }
      const migrationsDirSnapshotAfterRepair = snapshotDirectoryContents(
        dependencies.fileSystem,
        migrationsDir,
      );
      const migrationsMutation = diffDirectorySnapshots(
        migrationsDirSnapshotBeforeRepair,
        migrationsDirSnapshotAfterRepair,
      );
      if (migrationsMutation) {
        const failureReason = "Repair must mutate staged drafts only; real migrations directory changed ("
          + migrationsMutation
          + ").";
        stagedVerificationStore.write(syntheticTask, failureReason);
        return {
          valid: false,
          attempts: 1,
          repairStdout: repairRunResult.stdout,
          verificationStdout: failureReason,
        };
      }
      const verification = await verifyStagedDraftTaskSet();
      return {
        valid: verification.valid,
        attempts: 1,
        repairStdout: repairRunResult.stdout,
        verificationStdout: verification.stdout,
      };
    },
  };

  const stagedVerifyRepair = await runVerifyRepairLoop({
    taskVerification: stagedTaskVerification,
    taskRepair: stagedTaskRepair,
    verificationStore: stagedVerificationStore,
    traceWriter: dependencies.traceWriter,
    output: dependencies.output,
  }, {
    task: syntheticTask,
    source: "",
    contextBefore: "",
    verifyTemplate: "",
    repairTemplate: "",
    workerPattern: slugWorkerPattern,
    configDir: dependencies.configDir,
    maxRepairAttempts: MIGRATE_MAX_REPAIR_ATTEMPTS,
    allowRepair: true,
    templateVars: {},
    artifactContext,
    trace: false,
    showAgentOutput,
    runMode: "wait",
    executionOutputCaptured: true,
    isInlineCliTask: false,
    isToolExpansionTask: false,
  });

  if (!stagedVerifyRepair.valid) {
    return {
      ok: false,
      errorMessage: "Staged migration drafts failed verification after repair attempts: "
        + (stagedVerifyRepair.failureReason ?? "Verification failed (no details).")
        + " Staged drafts preserved in "
        + migrationDraftDir
        + ".",
      promotedMigrationPaths: [],
      promotedMigrationMetadataPaths: [],
    };
  }

  const stagedDraftVerificationAfterRepair = verifyCurrentStagedDraftSet({
    fileSystem: dependencies.fileSystem,
    artifactRunRootDir: artifactContext.rootDir,
    revisionName: targetRevisionName,
    revisionDiff,
    currentPosition: state.currentPosition,
    migrationDraftDir,
    threadSlug: thread?.threadSlug,
  });
  if (!stagedDraftVerificationAfterRepair.valid) {
    return {
      ok: false,
      errorMessage: stagedDraftVerificationAfterRepair.failureReason
        ?? "Staged migration drafts failed verification after repair.",
      promotedMigrationPaths: [],
      promotedMigrationMetadataPaths: [],
    };
  }
  const stagedDrafts = stagedDraftVerificationAfterRepair.drafts;
  if (stagedDrafts.length === 0 && revisionDiff.changes.length === 0) {
    emit({
      kind: "info",
      message: thread
        ? "Planner drafted no migrations for " + targetRevisionName + " in thread " + thread.threadSlug + ": no diff changes detected."
        : "Planner drafted no migrations for " + targetRevisionName + ": no diff changes detected.",
    });
    return {
      ok: true,
      errorMessage: "",
      promotedMigrationPaths: [],
      promotedMigrationMetadataPaths: [],
    };
  }

  emit({
    kind: "info",
    message: "Promoting "
      + String(stagedDrafts.length)
      + " staged migration file(s): "
      + stagedDrafts.map((draft) => draft.name).join(", ")
      + (thread ? " [thread " + thread.threadSlug + "]" : ""),
  });

  const promotedMigrationPaths: string[] = [];
  const promotedMigrationMetadataPaths: string[] = [];
  const promotedMigrationsDir = migrationsDir;
  dependencies.fileSystem.mkdir(promotedMigrationsDir, { recursive: true });
  const stateBeforeCreate = readMigrationStateFromDirectoryOrEmpty(
    dependencies.fileSystem,
    promotedMigrationsDir,
    archivedMigrationsDir,
  );
  const stagedValidationErrorBeforePromotion = validateStagedDraftMigrations(
    stagedDrafts,
    stateBeforeCreate.currentPosition,
  );
  if (stagedValidationErrorBeforePromotion) {
    return {
      ok: false,
      errorMessage: stagedValidationErrorBeforePromotion,
      promotedMigrationPaths: [],
      promotedMigrationMetadataPaths: [],
    };
  }
  for (const draft of stagedDrafts) {
    const migrationPath = path.join(promotedMigrationsDir, draft.fileName);
    const migrationContent = dependencies.fileSystem.readText(draft.filePath);
    dependencies.fileSystem.writeText(migrationPath, migrationContent);
    promotedMigrationPaths.push(migrationPath);
    promotedMigrationMetadataPaths.push(toWorkspaceRelativeMigrationPath(workspaceRoot, migrationPath));
  }

  if (confirm) {
    if (dependencies.interactiveInput.prepareForPrompt) {
      await dependencies.interactiveInput.prepareForPrompt();
    }
    const answer = await dependencies.interactiveInput.prompt({
      kind: "confirm",
      message: "Migration files created. Review or edit them, then confirm to continue prediction.",
      defaultValue: true,
    });
    if (answer.value.trim().toLowerCase() !== "true") {
      emit({
        kind: "info",
        message: "Stopped at migration file checkpoint before prediction continuation.",
      });
      return {
        ok: true,
        errorMessage: "",
        promotedMigrationPaths,
        promotedMigrationMetadataPaths,
      };
    }
  }

  return {
    ok: true,
    errorMessage: "",
    promotedMigrationPaths,
    promotedMigrationMetadataPaths,
  };
}


interface StagedDraftMigration {
  fileName: string;
  filePath: string;
  number: number;
  name: string;
}

const DRAFTED_MIGRATIONS_SUBDIR = "drafted-migrations";
const MIGRATE_MAX_REPAIR_ATTEMPTS = 2;
const PLACEHOLDER_DRAFT_LINE_PATTERN = /^(?:[-*]\s*\[[ xX]\]\s*)?(?:todo|to do|tbd|placeholder|implement this migration|implement migration|pending)\b/i;
const COVERAGE_TOKEN_IGNORE = new Set([
  "md",
  "docs",
  "doc",
  "design",
  "target",
  "current",
  "rev",
  "spec",
  "specs",
  "src",
  "file",
]);

function stagedDraftMigrationDirForRevision(
  artifactRunRootDir: string,
  revisionName: string,
  threadSlug?: string,
): string {
  return threadSlug
    ? path.join(artifactRunRootDir, DRAFTED_MIGRATIONS_SUBDIR, revisionName, "threads", threadSlug)
    : path.join(artifactRunRootDir, DRAFTED_MIGRATIONS_SUBDIR, revisionName);
}

function prepareStagedDraftMigrationDir(
  fileSystem: FileSystem,
  artifactRunRootDir: string,
  revisionName: string,
  threadSlug?: string,
): string {
  const draftDir = stagedDraftMigrationDirForRevision(artifactRunRootDir, revisionName, threadSlug);
  fileSystem.rm(draftDir, { recursive: true, force: true });
  fileSystem.mkdir(draftDir, { recursive: true });
  return draftDir;
}

export function discoverMigrationThreads(
  fileSystem: FileSystem,
  workspaceRoot: string,
): DiscoveredMigrationThread[] {
  const threadsDir = path.join(workspaceRoot, ".rundown", "threads");
  if (!fileSystem.exists(threadsDir)) {
    return [];
  }

  const stat = fileSystem.stat(threadsDir);
  if (!stat?.isDirectory) {
    return [];
  }

  const threadFiles = fileSystem.readdir(threadsDir)
    .filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (threadFiles.length === 0) {
    return [];
  }

  const slugCounts = new Map<string, number>();
  return threadFiles.map((fileName) => {
    const sourcePath = path.join(threadsDir, fileName);
    const threadName = fileName.slice(0, -3);
    const baseSlug = slugifyThreadFileName(threadName);
    const priorCount = slugCounts.get(baseSlug) ?? 0;
    const nextCount = priorCount + 1;
    slugCounts.set(baseSlug, nextCount);
    const threadSlug = nextCount === 1 ? baseSlug : baseSlug + "-" + String(nextCount);

    return {
      fileName,
      sourcePath,
      sourcePathFromWorkspace: toWorkspaceRelativeMigrationPath(workspaceRoot, sourcePath),
      threadName,
      threadSlug,
    };
  });
}

function slugifyThreadFileName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[`'".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug.length > 0 ? slug : "thread";
}

function toWorkspaceRelativeMigrationPath(workspaceRoot: string, migrationPath: string): string {
  return path.relative(workspaceRoot, migrationPath).replace(/\\/g, "/");
}

function readStagedDraftMigrationsFromArtifactRun(
  fileSystem: FileSystem,
  artifactRunRootDir: string,
  revisionName: string,
  threadSlug?: string,
): {
  drafts: StagedDraftMigration[];
  invalidFileNames: string[];
} {
  const draftDir = stagedDraftMigrationDirForRevision(artifactRunRootDir, revisionName, threadSlug);
  return readStagedDraftMigrations(fileSystem, draftDir);
}

function readStagedDraftMigrations(
  fileSystem: FileSystem,
  draftDir: string,
): {
  drafts: StagedDraftMigration[];
  invalidFileNames: string[];
} {
  if (!fileSystem.exists(draftDir)) {
    return {
      drafts: [],
      invalidFileNames: [],
    };
  }

  const staged: StagedDraftMigration[] = [];
  const invalidFileNames: string[] = [];
  for (const entry of fileSystem.readdir(draftDir)) {
    if (!entry.isFile) {
      continue;
    }
    const fileName = entry.name;
    const parsed = parseMigrationFilename(fileName);
    if (!parsed || fileName !== formatMigrationFilename(parsed.number, parsed.name)) {
      invalidFileNames.push(fileName);
      continue;
    }
    staged.push({
      fileName,
      filePath: path.join(draftDir, fileName),
      number: parsed.number,
      name: parsed.name,
    });
  }

  staged.sort((left, right) => left.number - right.number || left.fileName.localeCompare(right.fileName));
  return {
    drafts: staged,
    invalidFileNames,
  };
}

function validateStagedDraftMigrations(
  drafts: readonly StagedDraftMigration[],
  currentPosition: number,
): string | null {
  if (drafts.length === 0) {
    return null;
  }

  if (drafts[0]!.number <= currentPosition) {
    return "Drafted migration numbers must be greater than the current migration number ("
      + String(currentPosition)
      + ").";
  }

  for (let index = 1; index < drafts.length; index += 1) {
    const previous = drafts[index - 1]!;
    const current = drafts[index]!;
    if (current.number !== previous.number + 1) {
      return "Drafted migration numbers must form a continuous forward range without gaps.";
    }
  }

  return null;
}

function verifyStagedDraftCoverage(input: {
  fileSystem: FileSystem;
  drafts: readonly StagedDraftMigration[];
  revisionDiff: DesignRevisionDiffContext;
}): string | null {
  const { fileSystem, drafts, revisionDiff } = input;
  if (drafts.length === 0) {
    return null;
  }

  const draftTexts = drafts.map((draft) => {
    const content = fileSystem.readText(draft.filePath);
    return {
      fileName: draft.fileName,
      content,
      normalized: content.toLowerCase(),
    };
  });

  const lowValueDrafts = draftTexts
    .filter((draft) => !isMateriallyMeaningfulDraftContent(draft.content))
    .map((draft) => draft.fileName);
  if (lowValueDrafts.length > 0) {
    return "Drafted migrations must contain materially meaningful content. Replace placeholder-only drafts: "
      + lowValueDrafts.join(", ")
      + ".";
  }

  const mergedDraftText = draftTexts.map((draft) => draft.normalized).join("\n");
  const uncoveredChanges = revisionDiff.changes
    .map((change) => change.relativePath)
    .filter((relativePath) => !isDiffPathCoveredByDrafts(relativePath, mergedDraftText));
  if (uncoveredChanges.length > 0) {
    return "Drafted migrations do not appear to cover all changed design areas. Uncovered diff paths: "
      + uncoveredChanges.join(", ")
      + ".";
  }

  const overlappingPairs: string[] = [];
  for (let leftIndex = 0; leftIndex < draftTexts.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < draftTexts.length; rightIndex += 1) {
      const left = draftTexts[leftIndex]!;
      const right = draftTexts[rightIndex]!;
      if (areDraftsExcessivelyOverlapping(left.content, right.content)) {
        overlappingPairs.push(left.fileName + " <-> " + right.fileName);
      }
    }
  }

  if (overlappingPairs.length > 0) {
    return "Drafted migrations are excessively overlapping; split or de-duplicate responsibilities: "
      + overlappingPairs.join(", ")
      + ".";
  }

  return null;
}

function verifyCurrentStagedDraftSet(input: {
  fileSystem: FileSystem;
  artifactRunRootDir: string;
  revisionName: string;
  revisionDiff: DesignRevisionDiffContext;
  currentPosition: number;
  migrationDraftDir: string;
  threadSlug?: string;
}): {
  valid: boolean;
  failureReason: string | null;
  drafts: StagedDraftMigration[];
} {
  const {
    fileSystem,
    artifactRunRootDir,
    revisionName,
    revisionDiff,
    currentPosition,
    migrationDraftDir,
    threadSlug,
  } = input;
  const stagedDraftResult = readStagedDraftMigrationsFromArtifactRun(
    fileSystem,
    artifactRunRootDir,
    revisionName,
    threadSlug,
  );

  if (stagedDraftResult.invalidFileNames.length > 0) {
    return {
      valid: false,
      failureReason: "Drafted migration filenames must be canonical (N. Title.md)."
        + " Staging directory: "
        + migrationDraftDir
        + ". Invalid filenames: "
        + stagedDraftResult.invalidFileNames.join(", "),
      drafts: [],
    };
  }

  const stagedDrafts = stagedDraftResult.drafts;
  if (stagedDrafts.length === 0) {
    if (revisionDiff.changes.length === 0) {
      return {
        valid: true,
        failureReason: null,
        drafts: [],
      };
    }

    return {
      valid: false,
      failureReason: "Planner did not draft migration files in "
        + migrationDraftDir
        + ". Re-run with --show-agent-output --keep-artifacts to inspect worker output.",
      drafts: [],
    };
  }

  const stagedValidationError = validateStagedDraftMigrations(stagedDrafts, currentPosition);
  if (stagedValidationError) {
    return {
      valid: false,
      failureReason: stagedValidationError,
      drafts: [],
    };
  }

  const stagedCoverageError = verifyStagedDraftCoverage({
    fileSystem,
    drafts: stagedDrafts,
    revisionDiff,
  });
  if (stagedCoverageError) {
    return {
      valid: false,
      failureReason: stagedCoverageError,
      drafts: [],
    };
  }

  return {
    valid: true,
    failureReason: null,
    drafts: stagedDrafts,
  };
}

function buildMigrateRepairPrompt(input: {
  revisionName: string;
  migrationDraftDir: string;
  migrationsDir: string;
  currentPosition: number;
  failureReason: string;
  revisionDiff: DesignRevisionDiffContext;
}): string {
  const {
    revisionName,
    migrationDraftDir,
    migrationsDir,
    currentPosition,
    failureReason,
    revisionDiff,
  } = input;
  return [
    "Repair staged migration drafts for revision " + revisionName + ".",
    "",
    "Rules:",
    "- Edit only files inside this staging directory: " + migrationDraftDir,
    "- Do not modify files in real migrations directory: " + migrationsDir,
    "- Keep canonical migration filenames: N. Title.md",
    "- Use migration numbers strictly greater than " + String(currentPosition),
    "- Keep drafted numbers continuous with no gaps",
    "",
    "Latest verification failure:",
    failureReason,
    "",
    "Design diff summary:",
    revisionDiff.summary,
    "",
    "Changed files:",
    revisionDiff.changes.map((change) => "- " + change.kind + ": " + change.relativePath).join("\n"),
    "",
    "Update staged draft files now. If no migrations are needed because there is no diff drift, remove all staged files and output DONE.",
  ].join("\n");
}

function createSyntheticMigrateTask(filePath: string, revisionName: string): Task {
  return {
    text: "verify staged migration drafts for " + revisionName,
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: 0,
    file: filePath,
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}

function createInMemoryVerificationStore(): VerificationStore {
  const store = new Map<string, string>();
  const keyOf = (task: Task): string => task.file + "::" + String(task.index);
  return {
    write(task, content) {
      store.set(keyOf(task), content);
    },
    read(task) {
      return store.get(keyOf(task)) ?? null;
    },
    remove(task) {
      store.delete(keyOf(task));
    },
  };
}

function snapshotDirectoryContents(
  fileSystem: FileSystem,
  rootDir: string,
): Map<string, string> {
  const snapshot = new Map<string, string>();
  const visit = (currentDir: string, relativePrefix: string): void => {
    if (!fileSystem.exists(currentDir)) {
      return;
    }
    const entries = fileSystem.readdir(currentDir)
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = relativePrefix.length > 0
        ? relativePrefix + "/" + entry.name
        : entry.name;
      if (entry.isDirectory) {
        visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }
      snapshot.set(relativePath, fileSystem.readText(absolutePath));
    }
  };

  visit(rootDir, "");
  return snapshot;
}

function diffDirectorySnapshots(
  before: Map<string, string>,
  after: Map<string, string>,
): string | null {
  const beforeKeys = new Set(before.keys());
  for (const [relativePath, afterContent] of after) {
    if (!before.has(relativePath)) {
      return "unexpected file created: " + relativePath;
    }
    beforeKeys.delete(relativePath);
    const beforeContent = before.get(relativePath);
    if (beforeContent !== afterContent) {
      return "unexpected file modified: " + relativePath;
    }
  }
  for (const removedPath of beforeKeys) {
    return "unexpected file removed: " + removedPath;
  }

  return null;
}

function isMateriallyMeaningfulDraftContent(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length < 40) {
    return false;
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (lines.length === 0) {
    return false;
  }

  const nonPlaceholderLines = lines.filter((line) => !PLACEHOLDER_DRAFT_LINE_PATTERN.test(line));
  if (nonPlaceholderLines.length === 0) {
    return false;
  }

  return nonPlaceholderLines.some((line) => line.length >= 16);
}

function isDiffPathCoveredByDrafts(relativePath: string, mergedDraftText: string): boolean {
  const normalizedPath = relativePath.toLowerCase().replace(/\\/g, "/");
  if (normalizedPath.length > 0 && mergedDraftText.includes(normalizedPath)) {
    return true;
  }

  const tokens = normalizedPath
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3)
    .filter((token) => !COVERAGE_TOKEN_IGNORE.has(token));
  if (tokens.length === 0) {
    return true;
  }

  const matched = tokens.filter((token) => mergedDraftText.includes(token));
  const requiredMatches = tokens.length >= 2 ? 2 : 1;
  return matched.length >= requiredMatches;
}

function areDraftsExcessivelyOverlapping(leftContent: string, rightContent: string): boolean {
  const leftTerms = collectDraftTerms(leftContent);
  const rightTerms = collectDraftTerms(rightContent);
  if (leftTerms.size === 0 || rightTerms.size === 0) {
    return false;
  }

  let intersectionCount = 0;
  for (const term of leftTerms) {
    if (rightTerms.has(term)) {
      intersectionCount += 1;
    }
  }

  const smallerSize = Math.min(leftTerms.size, rightTerms.size);
  if (smallerSize < 20) {
    return false;
  }

  return intersectionCount / smallerSize >= 0.92;
}

function collectDraftTerms(content: string): Set<string> {
  const terms = new Set<string>();
  for (const token of content.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length < 4) {
      continue;
    }
    if (COVERAGE_TOKEN_IGNORE.has(token)) {
      continue;
    }
    terms.add(token);
  }
  return terms;
}


function buildMigrationBatchSourceFromNumbers(input: {
  fileSystem: FileSystem;
  state: ReturnType<typeof readMigrationState>;
  migrationNumbers: readonly number[];
}): string {
  const { fileSystem, state, migrationNumbers } = input;
  const selectedNumbers = new Set(migrationNumbers);
  const sections: string[] = [];
  for (const migration of state.migrations) {
    if (!selectedNumbers.has(migration.number)) {
      continue;
    }
    sections.push(`# ${path.basename(migration.filePath)}\n\n${fileSystem.readText(migration.filePath).trim()}`);
  }

  return sections.join("\n\n---\n\n");
}

function getPendingExecutableMigrationNumbers(
  fileSystem: FileSystem,
  state: ReturnType<typeof readMigrationState>,
): number[] {
  const pending: number[] = [];
  for (const migration of state.migrations) {
    const tasks = parseTasks(fileSystem.readText(migration.filePath), migration.filePath);
    if (tasks.length === 0) {
      continue;
    }

    if (tasks.some((task) => !task.checked)) {
      pending.push(migration.number);
    }
  }

  return pending;
}

async function runExploreForMigration(input: {
  runExplore: (source: string, cwd: string) => Promise<number>;
  migrationPath: string;
  projectRoot: string;
}): Promise<void> {
  const { runExplore, migrationPath, projectRoot } = input;

  const exploreExitCode = await runExplore(migrationPath, projectRoot);
  if (exploreExitCode !== EXIT_CODE_SUCCESS) {
    throw new Error("Explore failed for " + migrationPath + ".");
  }
}

function readTemplate(
  templateLoader: TemplateLoader,
  projectRoot: string,
  fileName: string,
  fallback: string,
): string {
  const templatePath = path.join(projectRoot, ".rundown", fileName);
  return templateLoader.load(templatePath) ?? fallback;
}

function buildTemplateVars(input: {
  fileSystem: FileSystem;
  state: ReturnType<typeof readMigrationState>;
  projectRoot: string;
  invocationRoot: string;
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  designRevisionTarget?: string | number;
  revisionDiff?: DesignRevisionDiffContext;
  migrationDraftDir?: string;
  newMigrations?: string;
  threadContext?: {
    mode: boolean;
    name?: string;
    slug?: string;
    sourcePathFromWorkspace?: string;
    briefPathFromWorkspace?: string;
    translatedBrief?: string;
    laneSummary?: string;
  };
}): TemplateVars {
  const {
    fileSystem,
    state,
    projectRoot,
    invocationRoot,
    workspaceDirectories,
    workspacePaths,
    designRevisionTarget,
    revisionDiff: providedRevisionDiff,
    migrationDraftDir,
    newMigrations,
    threadContext,
  } = input;
  const latestMigration = state.migrations[state.migrations.length - 1] ?? null;

  const revisionDiff = providedRevisionDiff
    ?? prepareDesignRevisionDiffContext(fileSystem, projectRoot, {
      invocationRoot,
      target: designRevisionTarget,
    });
  const design = isDirectory(fileSystem, revisionDiff.toTarget.absolutePath)
    ? formatRevisionDesignContext(fileSystem, revisionDiff.toTarget.absolutePath)
    : (fileSystem.exists(revisionDiff.toTarget.absolutePath)
      ? fileSystem.readText(revisionDiff.toTarget.absolutePath)
      : "");
  const designContextSources = {
    sourceReferences: [revisionDiff.toTarget.absolutePath],
    hasManagedDocs: isDirectory(fileSystem, revisionDiff.toTarget.absolutePath),
  };
  const previousRevisionId = revisionDiff.fromRevision?.name ?? (revisionDiff.hasComparison ? "nothing" : "");
  const currentRevisionId = revisionDiff.toTarget.name;
  const currentRevisionCreatedAt = revisionDiff.toTarget.metadata.createdAt;
  const currentRevisionLabel = revisionDiff.toTarget.metadata.label;
  const previousRevisionCreatedAt = revisionDiff.fromRevision?.metadata.createdAt ?? "";
  const previousRevisionLabel = revisionDiff.fromRevision?.metadata.label ?? "";
  const currentRevisionMetadataPath = revisionDiff.toTarget.metadataPath;
  const previousRevisionMetadataPath = revisionDiff.fromRevision?.metadataPath ?? "";
  const revisionDiffFiles = revisionDiff.changes.map((change) => {
    return "- " + change.kind + ": " + change.relativePath;
  }).join("\n");
  const revisionDiffContent = formatDesignRevisionUnifiedDiff(fileSystem, revisionDiff);
  const revisionDiffSourceRefs = revisionDiff.sourceReferences.map((sourcePath) => "- " + sourcePath).join("\n");
  const designContextSourceRefs = designContextSources.sourceReferences.map((sourcePath) => "- " + sourcePath).join("\n");

  const historyLines = state.migrations.map((migration) => {
    const fileName = path.basename(migration.filePath);
    return "- " + fileName;
  });

  const threadMode = threadContext?.mode === true;
  const threadName = threadContext?.name ?? "";
  const threadSlug = threadContext?.slug ?? "";
  const threadSourcePath = threadContext?.sourcePathFromWorkspace ?? "";
  const threadBriefPath = threadContext?.briefPathFromWorkspace ?? "";
  const translatedThreadBrief = threadContext?.translatedBrief ?? "";
  const threadLaneSummary = threadContext?.laneSummary
    ?? (threadMode
      ? [
        "- This drafting run is scoped to one migration thread lane.",
        "- Use only thread-local migration history and numbering.",
        "- Use the translated thread brief below to specialize migration planning.",
      ].join("\n")
      : "- Thread mode is disabled for this run; use shared root migration context only.");

  return {
    task: "migrate",
    file: latestMigration?.filePath ?? "",
    context: "",
    taskIndex: 0,
    taskLine: 1,
    source: "",
    design,
    latestMigration: latestMigration ? fileSystem.readText(latestMigration.filePath) : "",
    newMigrations: newMigrations ?? "",
    migrationDraftDir: migrationDraftDir ?? "",
    migrationHistory: historyLines.join("\n"),
    designContextSourceReferences: designContextSourceRefs,
    designContextSourceReferencesJson: JSON.stringify(designContextSources.sourceReferences),
    designContextHasManagedDocs: designContextSources.hasManagedDocs ? "true" : "false",
    currentRevisionId,
    previousRevisionId,
    currentRevisionCreatedAt,
    currentRevisionLabel,
    previousRevisionCreatedAt,
    previousRevisionLabel,
    currentRevisionMetadataPath,
    previousRevisionMetadataPath,
    revisionDiffSummary: revisionDiff.summary,
    revisionDiffSourceReferences: revisionDiffSourceRefs,
    revisionDiffSourceReferencesJson: JSON.stringify(revisionDiff.sourceReferences),
    designRevisionDiffSummary: revisionDiff.summary,
    designRevisionDiffHasComparison: revisionDiff.hasComparison ? "true" : "false",
    designRevisionFromRevision: previousRevisionId,
    designRevisionToTarget: currentRevisionId,
    designRevisionDiffAddedCount: revisionDiff.addedCount,
    designRevisionDiffModifiedCount: revisionDiff.modifiedCount,
    designRevisionDiffRemovedCount: revisionDiff.removedCount,
    designRevisionDiffFiles: revisionDiffFiles,
    designRevisionDiffContent: revisionDiffContent,
    designRevisionDiffSources: revisionDiffSourceRefs,
    workspaceDesignDir: workspaceDirectories.design,
    workspaceImplementationDir: workspaceDirectories.implementation,
    workspaceSpecsDir: workspaceDirectories.specs,
    workspaceMigrationsDir: workspaceDirectories.migrations,
    workspacePredictionDir: workspaceDirectories.prediction,
    workspaceDesignPlacement: "",
    workspaceImplementationPlacement: "",
    workspaceSpecsPlacement: "",
    workspaceMigrationsPlacement: "",
    workspacePredictionPlacement: "",
    workspaceDesignPath: workspacePaths.design,
    workspaceImplementationPath: workspacePaths.implementation,
    workspaceSpecsPath: workspacePaths.specs,
    workspaceMigrationsPath: workspacePaths.migrations,
    workspacePredictionPath: workspacePaths.prediction,
    workspacePredictionLatestPath: path.join(workspacePaths.prediction, "latest"),
    workspacePredictionSnapshotsRootPath: path.join(workspacePaths.prediction, "snapshots", "root"),
    workspacePredictionSnapshotsThreadsPath: path.join(workspacePaths.prediction, "snapshots", "threads"),
    invocationDir: invocationRoot,
    workspaceDir: projectRoot,
    position: state.currentPosition,
    migrateThreadMode: threadMode ? "true" : "false",
    migrateThreadName: threadName,
    migrateThreadSlug: threadSlug,
    migrateThreadSourcePath: threadSourcePath,
    migrateThreadBriefPath: threadBriefPath,
    migrateThreadTranslatedBrief: translatedThreadBrief,
    migrateThreadLaneSummary: threadLaneSummary,
  };
}

function readMigrationState(
  fileSystem: FileSystem,
  migrationsDir: string,
  archivedMigrationsDir?: string,
) {
  const files = listMigrationLaneFiles({
    fileSystem,
    migrationsDir,
    archivedMigrationsDir,
  });
  return parseMigrationDirectory(files, migrationsDir);
}

function createNewMigrationShortcut(input: {
  fileSystem: FileSystem;
  migrationsDir: string;
  archivedMigrationsDir?: string;
  title: string;
}):
  | { ok: true; fileName: string }
  | { ok: false; message: string } {
  const { fileSystem, migrationsDir, archivedMigrationsDir, title } = input;
  const state = readMigrationStateFromDirectoryOrEmpty(fileSystem, migrationsDir, archivedMigrationsDir);
  const nextNumber = state.currentPosition + 1;
  const fileName = formatMigrationFilename(nextNumber, title);
  const targetPath = path.join(migrationsDir, fileName);

  if (fileSystem.exists(targetPath)) {
    return {
      ok: false,
      message: "Cannot create migration: target file already exists: " + targetPath,
    };
  }

  fileSystem.writeText(targetPath, "");
  return {
    ok: true,
    fileName,
  };
}

function resolveMigrationArchiveScopeForShortcut(input: {
  fileSystem: FileSystem;
  workspaceRoot: string;
  invocationRoot: string;
  workspaceMigrationsDir: string;
  migrationScopeDir: string;
}): string | undefined {
  const {
    fileSystem,
    workspaceRoot,
    invocationRoot,
    workspaceMigrationsDir,
    migrationScopeDir,
  } = input;
  if (arePathsEqual(workspaceMigrationsDir, migrationScopeDir)) {
    return resolveArchiveWorkspacePaths({
      fileSystem,
      workspaceRoot,
      invocationRoot,
    }).migrationRootLane;
  }

  const threadSlug = resolveThreadLaneSlugFromScopeDirectory(workspaceMigrationsDir, migrationScopeDir);
  if (!threadSlug) {
    return undefined;
  }

  return resolveMigrationThreadArchivePath({
    fileSystem,
    workspaceRoot,
    invocationRoot,
    threadSlug,
  });
}

function resolveThreadLaneSlugFromScopeDirectory(
  workspaceMigrationsDir: string,
  migrationScopeDir: string,
): string | undefined {
  const threadsRoot = path.join(workspaceMigrationsDir, "threads");
  const relativeScopePath = path.relative(threadsRoot, migrationScopeDir);
  if (relativeScopePath.length === 0 || relativeScopePath === ".") {
    return undefined;
  }

  if (relativeScopePath.startsWith("..") || path.isAbsolute(relativeScopePath)) {
    return undefined;
  }

  const segments = relativeScopePath.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 1) {
    return undefined;
  }

  return segments[0];
}

function arePathsEqual(leftPath: string, rightPath: string): boolean {
  const normalizedLeft = path.resolve(leftPath).replace(/\\/g, "/");
  const normalizedRight = path.resolve(rightPath).replace(/\\/g, "/");
  if (process.platform === "win32") {
    return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
  }

  return normalizedLeft === normalizedRight;
}

function listMigrationLaneFiles(input: {
  fileSystem: FileSystem;
  migrationsDir: string;
  archivedMigrationsDir?: string;
}): string[] {
  const { fileSystem, migrationsDir, archivedMigrationsDir } = input;
  const archivedFiles = listMigrationFilesInDirectory(fileSystem, archivedMigrationsDir);
  const hotFiles = listMigrationFilesInDirectory(fileSystem, migrationsDir);

  // Preserve archived-then-hot enumeration for parser precedence while
  // dropping archived entries that have the same filename as hot entries.
  const hotFileKeys = new Set(hotFiles.map(migrationLaneFileKey));
  const archivedWithoutHotOverlaps = archivedFiles
    .filter((filePath) => !hotFileKeys.has(migrationLaneFileKey(filePath)));

  return [...archivedWithoutHotOverlaps, ...hotFiles];
}

function listMigrationFilesInDirectory(fileSystem: FileSystem, migrationsDir?: string): string[] {
  if (!migrationsDir) {
    return [];
  }
  if (!fileSystem.exists(migrationsDir)) {
    return [];
  }

  const stat = fileSystem.stat(migrationsDir);
  if (!stat?.isDirectory) {
    return [];
  }

  return fileSystem.readdir(migrationsDir)
    .filter((entry) => entry.isFile)
    .map((entry) => path.join(migrationsDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function migrationLaneFileKey(filePath: string): string {
  return path.basename(filePath).toLowerCase();
}

function migrationThreadMigrationsDir(migrationsDir: string, threadSlug: string): string {
  return path.join(migrationsDir, "threads", threadSlug);
}

export async function materializeMigrationThreadBriefs(input: {
  fileSystem: FileSystem;
  workerExecutor: WorkerExecutorPort;
  output: ApplicationOutputPort;
  workerPattern: ParsedWorkerPattern;
  workspaceRoot: string;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  revisionName: string;
  revisionDiff: DesignRevisionDiffContext;
  threads: readonly DiscoveredMigrationThread[];
  translateTemplate: string;
  workerTimeoutMs?: number;
  showAgentOutput: boolean;
}): Promise<MaterializedMigrationThreadBrief[]> {
  const {
    fileSystem,
    workerExecutor,
    output,
    workerPattern,
    workspaceRoot,
    artifactContext,
    revisionName,
    revisionDiff,
    threads,
    translateTemplate,
    workerTimeoutMs,
    showAgentOutput,
  } = input;
  if (threads.length === 0) {
    return [];
  }

  const emit = output.emit.bind(output);
  const diffDocument = formatDesignRevisionUnifiedDiff(fileSystem, revisionDiff);
  const outputDir = path.join(artifactContext.rootDir, "thread-briefs", revisionName);
  fileSystem.mkdir(outputDir, { recursive: true });

  const materializedBriefs: MaterializedMigrationThreadBrief[] = [];
  for (const thread of threads) {
    const threadInstruction = fileSystem.readText(thread.sourcePath);
    const prompt = renderTranslatePrompt({
      translateTemplate,
      whatDocument: diffDocument,
      howDocument: threadInstruction,
      whatPath: path.posix.join("design", revisionName + ".diff.md"),
    });
    const runResult = await workerExecutor.runWorker({
      workerPattern,
      prompt,
      mode: "wait",
      cwd: workspaceRoot,
      timeoutMs: workerTimeoutMs,
      artifactContext,
      artifactPhase: "translate",
      artifactPhaseLabel: "migrate-thread-translate",
      artifactExtra: {
        workflow: "migrate-thread-translate",
        revision: revisionName,
        threadSlug: thread.threadSlug,
        threadSourcePath: thread.sourcePathFromWorkspace,
      },
    });
    if ((runResult.exitCode ?? 1) !== 0) {
      throw new Error("Worker failed to translate migration thread brief for " + thread.threadSlug + ".");
    }
    if (showAgentOutput && runResult.stderr.length > 0) {
      emit({ kind: "stderr", text: runResult.stderr });
    }

    const outputPath = path.join(outputDir, thread.threadSlug + ".md");
    fileSystem.writeText(outputPath, runResult.stdout);
    materializedBriefs.push({
      thread,
      outputPath,
      outputPathFromWorkspace: toWorkspaceRelativeMigrationPath(workspaceRoot, outputPath),
    });
  }

  return materializedBriefs;
}

export function loadMigrationThreadStates(input: {
  fileSystem: FileSystem;
  migrationsDir: string;
  archivedThreadsDir?: string;
  threads: readonly DiscoveredMigrationThread[];
}): LoadedMigrationThreadState[] {
  const { fileSystem, migrationsDir, archivedThreadsDir, threads } = input;
  return threads.map((thread) => {
    const threadMigrationsDir = migrationThreadMigrationsDir(migrationsDir, thread.threadSlug);
    const archivedThreadMigrationsDir = archivedThreadsDir
      ? path.join(archivedThreadsDir, thread.threadSlug)
      : undefined;
    const state = readMigrationStateFromDirectoryOrEmpty(
      fileSystem,
      threadMigrationsDir,
      archivedThreadMigrationsDir,
    );
    return {
      thread,
      migrationsDir: threadMigrationsDir,
      archivedMigrationsDir: archivedThreadMigrationsDir,
      state,
    };
  });
}

function readMigrationStateFromDirectoryOrEmpty(
  fileSystem: FileSystem,
  migrationsDir: string,
  archivedMigrationsDir?: string,
) {
  if (!fileSystem.exists(migrationsDir) && !archivedMigrationsDir) {
    return parseMigrationDirectory([], migrationsDir);
  }

  if (fileSystem.exists(migrationsDir)) {
    const stat = fileSystem.stat(migrationsDir);
    if (!stat?.isDirectory) {
      return parseMigrationDirectory([], migrationsDir);
    }
  }

  if (archivedMigrationsDir && fileSystem.exists(archivedMigrationsDir)) {
    const archiveStat = fileSystem.stat(archivedMigrationsDir);
    if (!archiveStat?.isDirectory) {
      return parseMigrationDirectory([], migrationsDir);
    }
  }

  const files = listMigrationLaneFiles({
    fileSystem,
    migrationsDir,
    archivedMigrationsDir,
  });
  if (files.length === 0) {
    return parseMigrationDirectory([], migrationsDir);
  }

  return parseMigrationDirectory(files, migrationsDir);
}

export async function confirmBeforeWrite(
  output: ApplicationOutputPort,
  interactiveInput: InteractiveInputPort,
  filename: string,
  content: string,
): Promise<boolean> {
  output.emit({ kind: "text", text: content.endsWith("\n") ? content : content + "\n" });

  if (interactiveInput.prepareForPrompt) {
    await interactiveInput.prepareForPrompt();
  }

  const answer = await interactiveInput.prompt({
    kind: "confirm",
    message: "Write " + filename + "?",
    defaultValue: true,
  });
  const approved = answer.value.trim().toLowerCase() === "true";

  if (!approved) {
    output.emit({ kind: "info", message: "Skipped " + filename + "." });
  }

  return approved;
}

export function isMigrationLikeFileName(fileName: string): boolean {
  return parseMigrationFilename(fileName) !== null;
}
