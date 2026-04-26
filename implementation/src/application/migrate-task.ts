import path from "node:path";
import {
  DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE,
  DEFAULT_MIGRATE_TEMPLATE,
} from "../domain/defaults.js";
import {
  formatMigrationFilename,
  formatSatelliteFilename,
  parseMigrationDirectory,
  parseMigrationFilename,
} from "../domain/migration-parser.js";
import type { SatelliteType } from "../domain/migration-types.js";
import { parseTasks } from "../domain/parser.js";
import type {
  ArtifactStore,
  FileSystem,
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
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import {
  createPredictionBaseline,
  createPredictionReconciliationEntryPoint,
  detectStalePendingPredictions,
  reResolvePendingPredictionSequence,
  reconcilePendingPredictedItemsAtomically,
  type PredictionBaseline,
  type PredictionInputs,
  type PredictionTrackedFile,
  type PredictionTrackedFileKind,
} from "../domain/prediction-reconciliation.js";
import {
  discoverDesignRevisionDirectories,
  findLowestUnplannedRevision,
  markRevisionMigrated,
  markRevisionPlanned,
  markRevisionUnmigrated,
  prepareDesignRevisionDiffContext,
  resolveDesignContext,
  resolveDesignContextSourceReferences,
} from "./design-context.js";
import {
  resolvePredictionWorkspaceDirectories,
  resolvePredictionWorkspacePaths,
  resolvePredictionWorkspacePlacement,
  resolvePredictionWorkspacePath,
} from "./prediction-workspace-paths.js";
import { resolveWorkspaceRootForPathSensitiveCommand } from "./workspace-selection.js";

type MigrateAction =
  | "up"
  | "down";

export interface MigrateTaskOptions {
  action?: string;
  downCount?: number;
  dir?: string;
  workspace?: string;
  confirm?: boolean;
  noBacklog?: boolean;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern?: ParsedWorkerPattern;
  keepArtifacts?: boolean;
  showAgentOutput?: boolean;
  runId?: string;
}

export interface MigrateTaskDependencies {
  workerExecutor: WorkerExecutorPort;
  fileSystem: FileSystem;
  templateLoader: TemplateLoader;
  sourceResolver: SourceResolverPort;
  workerConfigPort: WorkerConfigPort;
  artifactStore: ArtifactStore;
  interactiveInput: InteractiveInputPort;
  output: ApplicationOutputPort;
  runExplore?: (source: string, cwd: string) => Promise<number>;
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
    const workspaceDirectories = resolvePredictionWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const workspacePlacement = resolvePredictionWorkspacePlacement({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const workspacePaths = resolvePredictionWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });
    const migrationsDir = resolvePredictionWorkspacePath({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
      bucket: "migrations",
      overrideDir: options.dir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });

    if (!dependencies.fileSystem.exists(migrationsDir)) {
      emit({ kind: "error", message: "Migrations directory does not exist: " + migrationsDir });
      return EXIT_CODE_FAILURE;
    }

    const rawAction = options.action;
    const action = getMigrationActionFromArg(rawAction);
    if (rawAction !== undefined && rawAction.trim().length > 0 && !action) {
      emit({
        kind: "error",
        message: "Invalid migrate action: " + rawAction + ". Allowed: up, down.",
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

    emitLowDesignContextGuidance(
      dependencies.fileSystem,
      projectRoot,
      executionContext.invocationDir,
      emit,
    );

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

    try {
      let exitCode: number = EXIT_CODE_SUCCESS;
      if (!action) {
        exitCode = await runMigrateLoop({
          dependencies,
          migrationsDir,
          projectRoot,
          invocationRoot: executionContext.invocationDir,
          workspaceRoot,
          workspaceDirectories,
          workspacePlacement,
          workspacePaths,
          workerPattern: resolvedWorker.workerPattern,
          slugWorkerPattern,
          workerTimeoutMs,
          artifactContext,
          keepArtifacts: Boolean(options.keepArtifacts),
          showAgentOutput: Boolean(options.showAgentOutput),
          executionContext,
          confirm: Boolean(options.confirm),
          artifactRunExtra,
        });
      } else if (action === "up") {
        exitCode = await runMigrateUp({
          dependencies,
          migrationsDir,
          projectRoot,
          invocationRoot: executionContext.invocationDir,
          workspaceRoot,
          workspaceDirectories,
          workspacePlacement,
          workspacePaths,
          workerPattern: resolvedWorker.workerPattern,
          slugWorkerPattern,
          workerTimeoutMs,
          artifactContext,
          keepArtifacts: Boolean(options.keepArtifacts),
          showAgentOutput: Boolean(options.showAgentOutput),
          executionContext,
          newMigrationsSource: "",
          skipRunTaskWhenNoMigrations: false,
          artifactRunExtra,
        });
      } else {
        exitCode = await runMigrateDown({
          dependencies,
          migrationsDir,
          projectRoot,
          invocationRoot: executionContext.invocationDir,
          workspaceRoot,
          workspaceDirectories,
          workspacePlacement,
          workspacePaths,
          workerPattern: resolvedWorker.workerPattern,
          slugWorkerPattern,
          workerTimeoutMs,
          artifactContext,
          keepArtifacts: Boolean(options.keepArtifacts),
          showAgentOutput: Boolean(options.showAgentOutput),
          executionContext,
          downCount: options.downCount,
          noBacklog: Boolean(options.noBacklog),
          artifactRunExtra,
        });
      }

      const finalizeExtra = Object.keys(artifactRunExtra).length > 0
        ? artifactRunExtra
        : undefined;
      dependencies.artifactStore.finalize(artifactContext, {
        status: exitCode === EXIT_CODE_SUCCESS ? "completed" : "failed",
        preserve: Boolean(options.keepArtifacts),
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
        preserve: Boolean(options.keepArtifacts),
        extra: finalizeExtra,
      });
      emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return EXIT_CODE_FAILURE;
    }
  };
}

function persistPredictionBaselineSnapshot(fileSystem: FileSystem, migrationsDir: string, projectRoot: string): void {
  const predictionInputs = readPredictionInputs(fileSystem, migrationsDir, projectRoot);
  const baseline = createPredictionBaseline(predictionInputs);
  savePredictionBaseline(fileSystem, migrationsDir, baseline);
}

async function reconcilePendingMigrationPredictions(input: {
  dependencies: MigrateTaskDependencies;
  migrationsDir: string;
  workspaceRoot: string;
  slugWorkerPattern: ParsedWorkerPattern;
  workerTimeoutMs?: number;
  artifactContext: ReturnType<ArtifactStore["createContext"]> | undefined;
  showAgentOutput: boolean;
}): Promise<void> {
  const {
    dependencies,
    migrationsDir,
    workspaceRoot,
    slugWorkerPattern,
    workerTimeoutMs,
    artifactContext,
    showAgentOutput,
  } = input;
  const emit = dependencies.output.emit.bind(dependencies.output);
  const predictionInputs = readPredictionInputs(dependencies.fileSystem, migrationsDir, workspaceRoot);
  const baseline = loadPredictionBaseline(dependencies.fileSystem, migrationsDir);

  if (!baseline) {
    savePredictionBaseline(dependencies.fileSystem, migrationsDir, createPredictionBaseline(predictionInputs));
    return;
  }

  const staleness = detectStalePendingPredictions({
    baseline,
    current: predictionInputs,
  });

  if (!staleness.isStale) {
    savePredictionBaseline(dependencies.fileSystem, migrationsDir, createPredictionBaseline(predictionInputs));
    return;
  }

  const entryPoint = createPredictionReconciliationEntryPoint({
    baseline,
    current: predictionInputs,
    staleness,
  });

  try {
    const plan = await reResolvePendingPredictionSequence({
      entryPoint,
      current: predictionInputs,
      invokeWorker: async (prompt: string) => {
        const workerResult = await dependencies.workerExecutor.runWorker({
          workerPattern: slugWorkerPattern,
          prompt,
          mode: "wait",
          cwd: workspaceRoot,
          timeoutMs: workerTimeoutMs,
          artifactContext,
          artifactPhase: "worker",
          artifactPhaseLabel: "migrate-up-reconciliation",
        });

        if (showAgentOutput && workerResult.stderr.length > 0) {
          emit({ kind: "stderr", text: workerResult.stderr });
        }

        if ((workerResult.exitCode ?? 1) !== 0) {
          throw new Error("Worker failed during migrate prediction reconciliation.");
        }

        return workerResult.stdout;
      },
    });

    if (plan.fallback) {
      emit({
        kind: "warn",
        message:
          "Prediction reconciliation fallback ("
          + plan.fallback.reason
          + "): "
          + plan.fallback.message,
      });
      savePredictionBaseline(dependencies.fileSystem, migrationsDir, createPredictionBaseline(predictionInputs));
      return;
    }

    const reconciled = reconcilePendingPredictedItemsAtomically({
      current: predictionInputs,
      plan,
    });
    applyPendingPredictionPatch(
      dependencies.fileSystem,
      workspaceRoot,
      reconciled.patch.removeRelativePaths,
      reconciled.patch.writeFiles,
    );
    persistPredictionBaselineSnapshot(dependencies.fileSystem, migrationsDir, workspaceRoot);
  } catch (error) {
    emit({
      kind: "warn",
      message:
        "Prediction reconciliation skipped due to error: "
        + (error instanceof Error ? error.message : String(error)),
    });
    savePredictionBaseline(dependencies.fileSystem, migrationsDir, createPredictionBaseline(predictionInputs));
  }
}

function applyPendingPredictionPatch(
  fileSystem: FileSystem,
  projectRoot: string,
  removeRelativePaths: readonly string[],
  writeFiles: readonly PredictionTrackedFile[],
): void {
  for (const relativePath of removeRelativePaths) {
    const absolutePath = path.resolve(projectRoot, relativePath);
    if (fileSystem.exists(absolutePath)) {
      fileSystem.unlink(absolutePath);
    }
  }

  for (const file of writeFiles) {
    const absolutePath = path.resolve(projectRoot, file.relativePath);
    const directoryPath = path.dirname(absolutePath);
    if (!fileSystem.exists(directoryPath)) {
      fileSystem.mkdir(directoryPath, { recursive: true });
    }
    fileSystem.writeText(absolutePath, file.content);
  }
}

function readPredictionInputs(fileSystem: FileSystem, migrationsDir: string, projectRoot: string): PredictionInputs {
  const migrationFiles = fileSystem.readdir(migrationsDir)
    .filter((entry) => entry.isFile)
    .map((entry) => path.join(migrationsDir, entry.name))
    .filter((filePath) => parseMigrationFilename(path.basename(filePath)) !== null);
  const state = parseMigrationDirectory(migrationFiles, migrationsDir);
  const migrations = state.migrations.map((migration) => {
    const source = fileSystem.readText(migration.filePath);
    const tasks = parseTasks(source, migration.filePath);
    const hasTasks = tasks.length > 0;

    return {
      number: migration.number,
      name: migration.name,
      isApplied: hasTasks && tasks.every((task) => task.checked),
    };
  });

  const files: PredictionTrackedFile[] = [];
  for (const migration of state.migrations) {
    const migrationSource = fileSystem.readText(migration.filePath);
    files.push({
      relativePath: toProjectRelativePath(projectRoot, migration.filePath),
      migrationNumber: migration.number,
      kind: "migration",
      content: migrationSource,
    });

    for (const satellite of migration.satellites) {
      const kind = toPredictionTrackedFileKind(satellite.type);
      if (!kind) {
        continue;
      }

      files.push({
        relativePath: toProjectRelativePath(projectRoot, satellite.filePath),
        migrationNumber: migration.number,
        kind,
        content: fileSystem.readText(satellite.filePath),
      });
    }
  }

  return {
    migrations,
    files,
  };
}

function toPredictionTrackedFileKind(type: SatelliteType): PredictionTrackedFileKind | null {
  if (type === "snapshot") {
    return "snapshot";
  }
  if (type === "review") {
    return "review";
  }
  return null;
}

function toProjectRelativePath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).replace(/\\/g, "/");
}

function emitLowDesignContextGuidance(
  fileSystem: FileSystem,
  projectRoot: string,
  invocationRoot: string,
  emit: ApplicationOutputPort["emit"],
): void {
  const designContext = resolveDesignContext(fileSystem, projectRoot, { invocationRoot });
  if (!designContext.isLowContext || designContext.lowContextGuidance.trim().length === 0) {
    return;
  }

  emit({
    kind: "warn",
    message: designContext.lowContextGuidance,
  });
}

function isDirectory(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isDirectory === true;
}

function isFile(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isFile === true;
}

function getPredictionBaselinePath(migrationsDir: string): string {
  return path.join(migrationsDir, ".rundown", "prediction-baseline.json");
}

function loadPredictionBaseline(fileSystem: FileSystem, migrationsDir: string): PredictionBaseline | null {
  const baselinePath = getPredictionBaselinePath(migrationsDir);
  if (!fileSystem.exists(baselinePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(fileSystem.readText(baselinePath)) as PredictionBaseline;
    if (!Array.isArray(parsed.pendingPredictionMigrationNumbers) || !Array.isArray(parsed.fileFingerprints)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function savePredictionBaseline(fileSystem: FileSystem, migrationsDir: string, baseline: PredictionBaseline): void {
  const baselinePath = getPredictionBaselinePath(migrationsDir);
  const baselineDir = path.dirname(baselinePath);
  if (!fileSystem.exists(baselineDir)) {
    fileSystem.mkdir(baselineDir, { recursive: true });
  }

  fileSystem.writeText(baselinePath, JSON.stringify(baseline, null, 2) + "\n");
}

async function runMigrateLoop(input: {
  dependencies: MigrateTaskDependencies;
  migrationsDir: string;
  projectRoot: string;
  invocationRoot: string;
  workspaceRoot: string;
  workspaceDirectories: ReturnType<typeof resolvePredictionWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolvePredictionWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolvePredictionWorkspacePaths>;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern: ParsedWorkerPattern;
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
    workspacePlacement,
    workspacePaths,
    workerPattern,
    slugWorkerPattern,
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
  let processedAnyRevision = false;

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
        if (highestReleasedRevision) {
          emit({
            kind: "info",
            message:
              "Migrations are caught up to "
              + highestReleasedRevision.name
              + " (highest released revision). Edit design/current/ and run rundown design release to create the next revision.",
          });
        } else {
          emit({
            kind: "info",
            message: "No released design revisions yet. Run rundown design release to create rev.0.",
          });
        }
      }
      return EXIT_CODE_SUCCESS;
    }
    processedAnyRevision = true;

    const latestState = readMigrationState(dependencies.fileSystem, migrationsDir);
    const vars = buildTemplateVars({
      fileSystem: dependencies.fileSystem,
      state: latestState,
      projectRoot,
      invocationRoot,
      workspaceDirectories,
      workspacePlacement,
      workspacePaths,
      designRevisionTarget: targetRevision.name,
      newMigrations: "",
    });
    const prompt = renderTemplate(planningTemplate, vars);
    emit({
      kind: "info",
      message: "Planning migrations from design revision diff to "
        + targetRevision.name
        + " (position "
        + String(latestState.currentPosition)
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
      artifactPhaseLabel: "migrate-plan",
    });
    if ((result.exitCode ?? 1) !== 0) {
      throw new Error("Worker failed to generate migration plan.");
    }
    if (showAgentOutput && result.stderr.length > 0) {
      emit({ kind: "stderr", text: result.stderr });
    }

    const proposedNames = parseProposedMigrationNames(result.stdout);
    let plannerReturnedDone = false;
    const plannedNames: string[] = [];
    if (proposedNames === null) {
      plannerReturnedDone = true;
      emit({
        kind: "info",
        message: "Planner returned DONE for " + targetRevision.name + ": no new migrations needed.",
      });
    } else {
      const knownNames = new Set<string>(latestState.migrations.map((migration) => migration.name));
      for (const proposedName of proposedNames) {
        if (knownNames.has(proposedName)) {
          continue;
        }
        plannedNames.push(proposedName);
        knownNames.add(proposedName);
      }
    }

    if (plannedNames.length === 0) {
      if (plannerReturnedDone) {
        markRevisionPlanned(
          dependencies.fileSystem,
          workspaceRoot,
          targetRevision.name,
          [],
        );
        const upCode = await runMigrateUp({
          dependencies,
          migrationsDir,
          projectRoot,
          invocationRoot,
          workspaceRoot,
          workspaceDirectories,
          workspacePlacement,
          workspacePaths,
          workerPattern,
          slugWorkerPattern,
          workerTimeoutMs,
          artifactContext,
          keepArtifacts,
          showAgentOutput,
          executionContext,
          newMigrationsSource: "",
          skipRunTaskWhenNoMigrations: false,
          targetRevision: targetRevision.name,
          artifactRunExtra,
        });
        if (upCode !== EXIT_CODE_SUCCESS && upCode !== EXIT_CODE_NO_WORK) {
          return upCode;
        }
        continue;
      }

      emit({
        kind: "warn",
        message:
          "Planner produced no parseable migration names (expected lowercase kebab-case slugs). Re-run with --show-agent-output --keep-artifacts to inspect raw output.",
      });
      return EXIT_CODE_SUCCESS;
    }

    emit({
      kind: "info",
      message: "Creating "
        + String(plannedNames.length)
        + " migration file(s): "
        + plannedNames.join(", "),
    });

    const stateBeforeCreate = readMigrationState(dependencies.fileSystem, migrationsDir);
    const createdMigrationContents: string[] = [];
    const createdMigrationFileNames: string[] = [];
    for (const [index, migrationName] of plannedNames.entries()) {
      const number = stateBeforeCreate.currentPosition + index + 1;
      const migrationFileName = formatMigrationFilename(number, migrationName);
      const migrationPath = path.join(migrationsDir, migrationFileName);
      const migrationContent = createMigrationDocument(number, migrationName);
      dependencies.fileSystem.writeText(migrationPath, migrationContent);
      createdMigrationContents.push(migrationContent.trim());
      createdMigrationFileNames.push(migrationFileName);

      await runExploreForMigration({
        runExplore: dependencies.runExplore,
        migrationPath,
        projectRoot,
        emit,
      });
    }

    removePromotedBacklogItems({
      fileSystem: dependencies.fileSystem,
      backlogPath: stateBeforeCreate.backlogPath ?? path.join(migrationsDir, "Backlog.md"),
      promotedNames: plannedNames,
      promotedContents: createdMigrationContents,
    });

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
        return EXIT_CODE_SUCCESS;
      }
    }

    markRevisionPlanned(
      dependencies.fileSystem,
      workspaceRoot,
      targetRevision.name,
      createdMigrationFileNames,
    );

    const upCode = await runMigrateUp({
      dependencies,
      migrationsDir,
      projectRoot,
      invocationRoot,
      workspaceRoot,
      workspaceDirectories,
      workspacePlacement,
      workspacePaths,
      workerPattern,
      slugWorkerPattern,
      workerTimeoutMs,
      artifactContext,
      keepArtifacts,
      showAgentOutput,
      executionContext,
      newMigrationsSource: createdMigrationContents.join("\n\n---\n\n"),
      skipRunTaskWhenNoMigrations: false,
      targetRevision: targetRevision.name,
      artifactRunExtra,
    });
    if (upCode !== EXIT_CODE_SUCCESS) {
      return upCode;
    }
  }
}

async function runMigrateUp(input: {
  dependencies: MigrateTaskDependencies;
  migrationsDir: string;
  projectRoot: string;
  invocationRoot: string;
  workspaceRoot: string;
  workspaceDirectories: ReturnType<typeof resolvePredictionWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolvePredictionWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolvePredictionWorkspacePaths>;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  workerTimeoutMs?: number;
  keepArtifacts: boolean;
  showAgentOutput: boolean;
  executionContext: {
    invocationDir: string;
    workspaceDir: string;
    workspaceLinkPath: string;
    isLinkedWorkspace: boolean;
  };
  newMigrationsSource: string;
  skipRunTaskWhenNoMigrations: boolean;
  targetRevision?: string;
  artifactRunExtra: Record<string, unknown>;
}): Promise<number> {
  const {
    dependencies,
    migrationsDir,
    projectRoot,
    invocationRoot,
    workspaceRoot,
    workspaceDirectories,
    workspacePlacement,
    workspacePaths,
    workerPattern,
    slugWorkerPattern,
    artifactContext,
    workerTimeoutMs,
    keepArtifacts,
    showAgentOutput,
    executionContext,
    newMigrationsSource,
    skipRunTaskWhenNoMigrations,
    targetRevision,
    artifactRunExtra,
  } = input;

  if (targetRevision) {
    artifactRunExtra.targetRevision = targetRevision;
  }

  if (!dependencies.runTask) {
    throw new Error("migrate up requires runTask dependency.");
  }

  await reconcilePendingMigrationPredictions({
    dependencies,
    migrationsDir,
    workspaceRoot,
    slugWorkerPattern,
    workerTimeoutMs,
    artifactContext,
    showAgentOutput,
  });

  const stateAfterReconciliation = readMigrationState(dependencies.fileSystem, migrationsDir);
  const pendingAfterReconciliation = getPendingExecutableMigrationNumbers(
    dependencies.fileSystem,
    stateAfterReconciliation,
  );
  const migrationByNumber = new Map(
    stateAfterReconciliation.migrations.map((migration) => [migration.number, migration.filePath]),
  );
  const executedMigrationNumbers: number[] = [];

  let runExitCode: number = EXIT_CODE_SUCCESS;
  if (!skipRunTaskWhenNoMigrations || pendingAfterReconciliation.length > 0) {
    for (const migrationNumber of pendingAfterReconciliation) {
      const migrationPath = migrationByNumber.get(migrationNumber);
      if (!migrationPath) {
        continue;
      }

      runExitCode = await dependencies.runTask({
        source: migrationPath,
        cwd: workspaceRoot,
        invocationDir: executionContext.invocationDir,
        workspaceDir: executionContext.workspaceDir,
        workspaceLinkPath: executionContext.workspaceLinkPath,
        isLinkedWorkspace: executionContext.isLinkedWorkspace,
        mode: "wait",
        workerPattern,
        sortMode: "name-sort",
        verify: true,
        onlyVerify: false,
        forceExecute: false,
        forceAttempts: 2,
        noRepair: false,
        repairAttempts: 1,
        dryRun: false,
        printPrompt: false,
        keepArtifacts,
        varsFileOption: undefined,
        cliTemplateVarArgs: [],
        commitAfterComplete: true,
        commitMode: "per-task",
        runAll: true,
        redo: false,
        resetAfter: false,
        clean: false,
        rounds: 1,
        showAgentOutput,
        trace: false,
        traceOnly: false,
        forceUnlock: false,
        ignoreCliBlock: false,
        verbose: false,
      });

      if (runExitCode === EXIT_CODE_SUCCESS) {
        executedMigrationNumbers.push(migrationNumber);
        continue;
      }

      if (runExitCode !== EXIT_CODE_NO_WORK) {
        break;
      }
    }
  }

  if (runExitCode !== EXIT_CODE_SUCCESS && runExitCode !== EXIT_CODE_NO_WORK) {
    return runExitCode;
  }

  const stateAfterRun = readMigrationState(dependencies.fileSystem, migrationsDir);
  if (stateAfterRun.currentPosition <= 0) {
    persistPredictionBaselineSnapshot(dependencies.fileSystem, migrationsDir, workspaceRoot);
    return EXIT_CODE_SUCCESS;
  }

  const migrationsFromBatchFromRun = buildMigrationBatchSourceFromNumbers({
      fileSystem: dependencies.fileSystem,
      state: stateAfterRun,
      migrationNumbers: executedMigrationNumbers,
    });
  const migrationsFromBatch = migrationsFromBatchFromRun.trim().length > 0
    ? migrationsFromBatchFromRun
    : newMigrationsSource;

  if (migrationsFromBatch.trim().length === 0) {
    persistPredictionBaselineSnapshot(dependencies.fileSystem, migrationsDir, workspaceRoot);
    return EXIT_CODE_NO_WORK;
  }

  await generateSatellite({
    dependencies,
    state: stateAfterRun,
    projectRoot,
    invocationRoot,
    workspaceRoot,
    workspaceDirectories,
    workspacePlacement,
    workspacePaths,
    templateFile: "migrate-snapshot.md",
    defaultTemplate: DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE,
    satelliteType: "snapshot",
    workerPattern,
    workerTimeoutMs,
    artifactContext,
    confirm: false,
    showAgentOutput,
    additionalVars: {
      newMigrations: migrationsFromBatch,
    },
  });

  if (targetRevision) {
    markRevisionMigrated(dependencies.fileSystem, projectRoot, targetRevision);
  }

  persistPredictionBaselineSnapshot(dependencies.fileSystem, migrationsDir, workspaceRoot);
  return EXIT_CODE_SUCCESS;
}

async function runMigrateDown(input: {
  dependencies: MigrateTaskDependencies;
  migrationsDir: string;
  projectRoot: string;
  invocationRoot: string;
  workspaceRoot: string;
  workspaceDirectories: ReturnType<typeof resolvePredictionWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolvePredictionWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolvePredictionWorkspacePaths>;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  workerTimeoutMs?: number;
  keepArtifacts: boolean;
  showAgentOutput: boolean;
  executionContext: {
    invocationDir: string;
    workspaceDir: string;
    workspaceLinkPath: string;
    isLinkedWorkspace: boolean;
  };
  downCount?: number;
  noBacklog: boolean;
  artifactRunExtra: Record<string, unknown>;
}): Promise<number> {
  const {
    dependencies,
    migrationsDir,
    projectRoot,
    invocationRoot,
    workspaceRoot,
    workspaceDirectories,
    workspacePlacement,
    workspacePaths,
    workerPattern,
    slugWorkerPattern,
    artifactContext,
    workerTimeoutMs,
    keepArtifacts,
    showAgentOutput,
    executionContext,
    downCount,
    noBacklog,
    artifactRunExtra,
  } = input;

  const emit = dependencies.output.emit.bind(dependencies.output);
  const stateBeforeDown = readMigrationState(dependencies.fileSystem, migrationsDir);
  if (stateBeforeDown.migrations.length === 0) {
    emit({ kind: "info", message: "No migrations found to remove." });
    return EXIT_CODE_NO_WORK;
  }

  const requestedRemovalCount = Math.max(1, Math.floor(downCount ?? 1));
  const removedMigrations = stateBeforeDown.migrations.slice(-requestedRemovalCount);
  if (removedMigrations.length === 0) {
    emit({ kind: "info", message: "No migrations matched the requested down count." });
    return EXIT_CODE_NO_WORK;
  }

  const removedMigrationRecords = removedMigrations.map((migration) => ({
    name: migration.name,
    source: dependencies.fileSystem.exists(migration.filePath)
      ? dependencies.fileSystem.readText(migration.filePath)
      : "",
    filePath: migration.filePath,
  }));

  for (const migration of removedMigrationRecords) {
    if (dependencies.fileSystem.exists(migration.filePath)) {
      dependencies.fileSystem.unlink(migration.filePath);
    }
  }

  if (!noBacklog) {
    const backlogPath = stateBeforeDown.backlogPath ?? path.join(migrationsDir, "Backlog.md");
    const existingBacklog = dependencies.fileSystem.exists(backlogPath)
      ? dependencies.fileSystem.readText(backlogPath)
      : "";
    const removedSection = removedMigrationRecords
      .map((migration) => {
        return [
          `- ${migration.name}`,
          "",
          "```md",
          migration.source.trim(),
          "```",
        ].join("\n");
      })
      .join("\n\n");

    const normalizedExisting = existingBacklog.trim();
    const nextBacklog = normalizedExisting.length > 0
      ? normalizedExisting + "\n\n" + removedSection + "\n"
      : ["# Backlog", "", removedSection, ""].join("\n");
    dependencies.fileSystem.writeText(backlogPath, nextBacklog);
  }

  const remainingState = readMigrationState(dependencies.fileSystem, migrationsDir);
  for (const entry of dependencies.fileSystem.readdir(migrationsDir)) {
    if (!entry.isFile) {
      continue;
    }
    const parsed = parseMigrationFilename(entry.name);
    if (!parsed || !parsed.isSatellite || parsed.satelliteType !== "snapshot") {
      continue;
    }
    if (parsed.number <= remainingState.currentPosition) {
      continue;
    }
    dependencies.fileSystem.unlink(path.join(migrationsDir, entry.name));
  }

  const stateAfterPrune = readMigrationState(dependencies.fileSystem, migrationsDir);
  const fallbackSnapshotSource = buildMigrationBatchSourceFromNumbers({
    fileSystem: dependencies.fileSystem,
    state: stateAfterPrune,
    migrationNumbers: stateAfterPrune.migrations.map((migration) => migration.number),
  });

  const upCode = await runMigrateUp({
    dependencies,
    migrationsDir,
    projectRoot,
    invocationRoot,
    workspaceRoot,
    workspaceDirectories,
    workspacePlacement,
    workspacePaths,
    workerPattern,
    slugWorkerPattern,
    workerTimeoutMs,
    artifactContext,
    keepArtifacts,
    showAgentOutput,
    executionContext,
    newMigrationsSource: fallbackSnapshotSource,
    skipRunTaskWhenNoMigrations: false,
    artifactRunExtra,
  });

  if (upCode !== EXIT_CODE_SUCCESS) {
    return upCode;
  }

  const revertedRuns = dependencies.artifactStore
    .listSaved(artifactContext.configDir)
    .filter((run) => run.commandName === "migrate" && run.status === "completed")
    .slice(0, removedMigrations.length);
  const targetRevisionsFromRevertedRuns = collectTargetRevisionsFromRuns(revertedRuns);

  for (const revisionName of targetRevisionsFromRevertedRuns) {
    markRevisionUnmigrated(dependencies.fileSystem, projectRoot, revisionName);
    emit({
      kind: "info",
      message: "Cleared migratedAt on " + revisionName + "; re-run rundown migrate to re-apply.",
    });
  }

  return EXIT_CODE_SUCCESS;
}

function collectTargetRevisionsFromRuns(
  runs: ReadonlyArray<{ extra?: Record<string, unknown> }>,
): Set<string> {
  const targetRevisions = new Set<string>();

  for (const run of runs) {
    const targetRevision = typeof run.extra?.targetRevision === "string"
      ? run.extra.targetRevision.trim()
      : "";
    if (targetRevision.length === 0) {
      continue;
    }
    targetRevisions.add(targetRevision);
  }

  return targetRevisions;
}

function parseProposedMigrationNames(stdout: string): string[] | null {
  const trimmed = stdout.trim();
  if (trimmed.toUpperCase() === "DONE") {
    return null;
  }

  const names: string[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)?`?([a-z0-9]+(?:-[a-z0-9]+)*)`?\s*$/);
    if (!match) {
      continue;
    }
    const proposedName = match[1] ?? "";
    if (proposedName.length === 0 || seen.has(proposedName)) {
      continue;
    }
    seen.add(proposedName);
    names.push(proposedName);
  }

  return names;
}

function createMigrationDocument(number: number, migrationName: string): string {
  return [
    `# ${String(number)}. ${toTitleCase(migrationName)}`,
    "",
    "- [ ] Implement this migration",
    "",
  ].join("\n");
}

function removePromotedBacklogItems(input: {
  fileSystem: FileSystem;
  backlogPath: string;
  promotedNames: readonly string[];
  promotedContents: readonly string[];
}): void {
  const { fileSystem, backlogPath, promotedNames, promotedContents } = input;
  if (!fileSystem.exists(backlogPath)) {
    return;
  }

  const source = fileSystem.readText(backlogPath);
  const next = stripBacklogEntries(source, promotedNames, promotedContents);
  if (next !== source) {
    fileSystem.writeText(backlogPath, next);
  }
}

function stripBacklogEntries(
  source: string,
  promotedNames: readonly string[],
  promotedContents: readonly string[],
): string {
  if (source.length === 0) {
    return source;
  }

  const normalizedPromotedNames = new Set(promotedNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const normalizedPromotedContents = new Set(promotedContents.map((content) => normalizeBacklogEntryContent(content)).filter(Boolean));
  if (normalizedPromotedNames.size === 0 && normalizedPromotedContents.size === 0) {
    return source;
  }

  const lines = source.split(/\r?\n/);
  const entryRanges: Array<{ start: number; end: number }> = [];
  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (!/^\s*[-*]\s+/.test(line)) {
      continue;
    }

    entryRanges.push({ start: index, end: lines.length });
    if (entryRanges.length > 1) {
      entryRanges[entryRanges.length - 2]!.end = index;
    }
  }

  if (entryRanges.length === 0) {
    return source;
  }

  const removeIndexes = new Set<number>();
  for (const range of entryRanges) {
    const entryLines = lines.slice(range.start, range.end);
    const firstLine = entryLines[0] ?? "";
    const entryName = parseBacklogEntryName(firstLine);
    const entryContent = extractBacklogEntryFencedContent(entryLines);
    const byName = entryName.length > 0 && normalizedPromotedNames.has(entryName);
    const byContent = entryContent.length > 0 && normalizedPromotedContents.has(entryContent);
    if (!byName && !byContent) {
      continue;
    }

    for (let index = range.start; index < range.end; index += 1) {
      removeIndexes.add(index);
    }
  }

  if (removeIndexes.size === 0) {
    return source;
  }

  const nextLines = lines.filter((_line, index) => !removeIndexes.has(index));
  let next = nextLines.join("\n");
  if (/\r\n/.test(source)) {
    next = next.replace(/\n/g, "\r\n");
  }
  if (source.endsWith("\n") && !next.endsWith("\n")) {
    next += /\r\n/.test(source) ? "\r\n" : "\n";
  }
  return next;
}

function parseBacklogEntryName(line: string): string {
  const match = line.match(/^\s*[-*]\s+`?([a-z0-9]+(?:-[a-z0-9]+)*)`?\s*$/i);
  return (match?.[1] ?? "").trim().toLowerCase();
}

function extractBacklogEntryFencedContent(entryLines: readonly string[]): string {
  let start = -1;
  for (let index = 0; index < entryLines.length; index += 1) {
    if (/^```/.test((entryLines[index] ?? "").trim())) {
      start = index + 1;
      break;
    }
  }

  if (start < 0) {
    return "";
  }

  const contentLines: string[] = [];
  for (let index = start; index < entryLines.length; index += 1) {
    if (/^```/.test((entryLines[index] ?? "").trim())) {
      break;
    }
    contentLines.push(entryLines[index] ?? "");
  }

  return normalizeBacklogEntryContent(contentLines.join("\n"));
}

function normalizeBacklogEntryContent(content: string): string {
  return content.trim().replace(/\r\n/g, "\n");
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
  runExplore: MigrateTaskDependencies["runExplore"];
  migrationPath: string;
  projectRoot: string;
  emit: ApplicationOutputPort["emit"];
}): Promise<void> {
  const { runExplore, migrationPath, projectRoot, emit } = input;
  if (!runExplore) {
    emit({
      kind: "warn",
      message: "Explore integration is not configured; skipping enrichment for " + migrationPath,
    });
    return;
  }

  const exploreExitCode = await runExplore(migrationPath, projectRoot);
  if (exploreExitCode !== EXIT_CODE_SUCCESS) {
    throw new Error("Explore failed for " + migrationPath + ".");
  }
}

async function generateSatellite(input: {
  dependencies: MigrateTaskDependencies;
  state: ReturnType<typeof readMigrationState>;
  projectRoot: string;
  invocationRoot: string;
  workspaceRoot: string;
  workspaceDirectories: ReturnType<typeof resolvePredictionWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolvePredictionWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolvePredictionWorkspacePaths>;
  templateFile: string;
  defaultTemplate: string;
  satelliteType: SatelliteType;
  workerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  workerTimeoutMs?: number;
  confirm: boolean;
  showAgentOutput: boolean;
  additionalVars?: Partial<TemplateVars>;
}): Promise<void> {
  const {
    dependencies,
    state,
    projectRoot,
    invocationRoot,
    workspaceRoot,
    workspaceDirectories,
    workspacePlacement,
    workspacePaths,
    templateFile,
    defaultTemplate,
    satelliteType,
    workerPattern,
    artifactContext,
    workerTimeoutMs,
    confirm,
    showAgentOutput,
    additionalVars,
  } = input;
  const emit = dependencies.output.emit.bind(dependencies.output);

  const template = readTemplate(
    dependencies.templateLoader,
    projectRoot,
    templateFile,
    defaultTemplate,
  );
  const vars = {
    ...buildTemplateVars({
      fileSystem: dependencies.fileSystem,
      state,
      projectRoot,
      invocationRoot,
      workspaceDirectories,
      workspacePlacement,
      workspacePaths,
      newMigrations: "",
    }),
    ...(additionalVars ?? {}),
  };
  const prompt = renderTemplate(template, vars);

  const result = await dependencies.workerExecutor.runWorker({
    workerPattern,
    prompt,
    mode: "wait",
    cwd: workspaceRoot,
    timeoutMs: workerTimeoutMs,
    artifactContext,
    artifactPhase: "worker",
    artifactPhaseLabel: "migrate-" + satelliteType,
  });
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("Worker failed to generate migrate " + satelliteType + " output.");
  }

  if (showAgentOutput && result.stderr.length > 0) {
    emit({ kind: "stderr", text: result.stderr });
  }

  const position = state.currentPosition > 0 ? state.currentPosition : 1;
  const filename = formatSatelliteFilename(position, satelliteType);
  const filePath = path.join(state.migrationsDir, filename);

  if (confirm) {
    const approved = await confirmBeforeWrite(
      dependencies.output,
      dependencies.interactiveInput,
      filename,
      result.stdout,
    );
    if (!approved) {
      return;
    }
  }

  dependencies.fileSystem.writeText(filePath, result.stdout);
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
  workspaceDirectories: ReturnType<typeof resolvePredictionWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolvePredictionWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolvePredictionWorkspacePaths>;
  designRevisionTarget?: string | number;
  newMigrations?: string;
}): TemplateVars {
  const {
    fileSystem,
    state,
    projectRoot,
    invocationRoot,
    workspaceDirectories,
    workspacePlacement,
    workspacePaths,
    designRevisionTarget,
    newMigrations,
  } = input;
  const latestMigration = state.migrations[state.migrations.length - 1] ?? null;
  const latestSnapshot = state.latestSnapshot?.filePath ?? null;
  const backlog = state.backlogPath && fileSystem.exists(state.backlogPath)
    ? fileSystem.readText(state.backlogPath)
    : "";

  const design = resolveDesignContext(fileSystem, projectRoot, { invocationRoot }).design;
  const designContextSources = resolveDesignContextSourceReferences(fileSystem, projectRoot, { invocationRoot });
  const revisionDiff = prepareDesignRevisionDiffContext(fileSystem, projectRoot, {
    invocationRoot,
    target: designRevisionTarget,
  });
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
  const revisionDiffSourceRefs = revisionDiff.sourceReferences.map((sourcePath) => "- " + sourcePath).join("\n");
  const designContextSourceRefs = designContextSources.sourceReferences.map((sourcePath) => "- " + sourcePath).join("\n");

  const historyLines = state.migrations.map((migration) => {
    const fileName = path.basename(migration.filePath);
    return "- " + fileName;
  });

  return {
    task: "migrate",
    file: latestMigration?.filePath ?? "",
    context: "",
    taskIndex: 0,
    taskLine: 1,
    source: "",
    design,
    latestMigration: latestMigration ? fileSystem.readText(latestMigration.filePath) : "",
    backlog,
    latestSnapshot: latestSnapshot ? fileSystem.readText(latestSnapshot) : "",
    newMigrations: newMigrations ?? "",
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
    designRevisionDiffSources: revisionDiffSourceRefs,
    workspaceDesignDir: workspaceDirectories.design,
    workspaceSpecsDir: workspaceDirectories.specs,
    workspaceMigrationsDir: workspaceDirectories.migrations,
    workspaceDesignPlacement: workspacePlacement.design,
    workspaceSpecsPlacement: workspacePlacement.specs,
    workspaceMigrationsPlacement: workspacePlacement.migrations,
    workspaceDesignPath: workspacePaths.design,
    workspaceSpecsPath: workspacePaths.specs,
    workspaceMigrationsPath: workspacePaths.migrations,
    invocationDir: invocationRoot,
    workspaceDir: projectRoot,
    position: state.currentPosition,
  };
}

function toTitleCase(value: string): string {
  return value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}


function readMigrationState(fileSystem: FileSystem, migrationsDir: string) {
  const files = fileSystem.readdir(migrationsDir)
    .filter((entry) => entry.isFile)
    .map((entry) => path.join(migrationsDir, entry.name));
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

export function isMigrationAction(value: string | undefined): value is MigrateAction {
  return value === "up"
    || value === "down";
}


export function getMigrationActionFromArg(value: string | undefined): MigrateAction | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return isMigrationAction(value) ? value : undefined;
}

export function isMigrationLikeFileName(fileName: string): boolean {
  return parseMigrationFilename(fileName) !== null;
}
