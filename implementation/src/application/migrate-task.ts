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
  readPredictionTreeAsTrackedFiles,
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
  formatDesignRevisionUnifiedDiff,
  formatRevisionDesignContext,
  markRevisionMigrated,
  markRevisionPlanned,
  markRevisionUnplanned,
  markRevisionUnmigrated,
  parseDesignRevisionDirectoryName,
  prepareDesignRevisionDiffContext,
  type DesignRevisionDiffContext,
} from "./design-context.js";
import {
  resolveWorkspaceDirectories,
  resolveWorkspacePaths,
  resolveWorkspacePlacement,
  resolveWorkspacePath,
} from "./workspace-paths.js";
import { resolveWorkspaceRootForPathSensitiveCommand } from "./workspace-selection.js";

type MigrateAction =
  | "up"
  | "down";

export interface MigrateTaskOptions {
  action?: string;
  downCount?: number;
  toRevName?: string;
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
  revertTask?: (options: {
    runId: string;
    method: "revert" | "reset";
    dryRun: boolean;
    keepArtifacts: boolean;
    force: boolean;
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
    const workspaceDirectories = resolveWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const workspacePlacement = resolveWorkspacePlacement({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const workspacePaths = resolveWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });
    const migrationsDir = resolveWorkspacePath({
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
          toRevName: options.toRevName,
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

function persistPredictionBaselineSnapshot(
  fileSystem: FileSystem,
  migrationsDir: string,
  projectRoot: string,
  options?: { preferPredictionTree?: boolean; writePredictionBucket?: boolean },
): void {
  const predictionInputs = readPredictionInputs(fileSystem, migrationsDir, projectRoot, options);
  const baseline = createPredictionBaseline(predictionInputs);
  if (options?.writePredictionBucket !== false) {
    const predictionDir = resolveWorkspacePath({
      fileSystem,
      workspaceRoot: projectRoot,
      invocationRoot: projectRoot,
      bucket: "prediction",
    });
    writePredictionTree({
      fileSystem,
      predictionDir,
      baseline: predictionInputs,
    });
  }
  savePredictionBaseline(fileSystem, migrationsDir, baseline);
}

function writePredictionTree(input: {
  fileSystem: FileSystem;
  predictionDir: string;
  baseline: { files: readonly PredictionTrackedFile[] };
}): void {
  const { fileSystem, predictionDir, baseline } = input;
  if (!fileSystem.exists(predictionDir)) {
    fileSystem.mkdir(predictionDir, { recursive: true });
  }

  const expectedRelativePaths = new Set<string>();
  for (const file of baseline.files) {
    const normalizedRelativePath = normalizeRelativeFilePath(file.relativePath);
    expectedRelativePaths.add(normalizedRelativePath);

    const filePath = path.join(predictionDir, file.relativePath);
    const parentDirectory = path.dirname(filePath);
    if (!fileSystem.exists(parentDirectory)) {
      fileSystem.mkdir(parentDirectory, { recursive: true });
    }
    fileSystem.writeText(filePath, file.content);
  }

  const existingFiles = listRelativeFiles(fileSystem, predictionDir);
  for (const relativePath of existingFiles) {
    if (expectedRelativePaths.has(normalizeRelativeFilePath(relativePath))) {
      continue;
    }
    fileSystem.unlink(path.join(predictionDir, relativePath));
  }
}

function listRelativeFiles(fileSystem: FileSystem, rootDirectory: string): string[] {
  if (!fileSystem.exists(rootDirectory)) {
    return [];
  }

  const relativePaths: string[] = [];
  const pendingDirectories = [rootDirectory];
  while (pendingDirectories.length > 0) {
    const currentDirectory = pendingDirectories.pop();
    if (!currentDirectory) {
      continue;
    }

    for (const entry of fileSystem.readdir(currentDirectory)) {
      const entryPath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory) {
        pendingDirectories.push(entryPath);
        continue;
      }
      if (!entry.isFile) {
        continue;
      }

      relativePaths.push(path.relative(rootDirectory, entryPath).replace(/\\/g, "/"));
    }
  }

  return relativePaths;
}

function normalizeRelativeFilePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
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

function readPredictionInputs(
  fileSystem: FileSystem,
  migrationsDir: string,
  projectRoot: string,
  options?: { preferPredictionTree?: boolean },
): PredictionInputs {
  const shouldPreferPredictionTree = options?.preferPredictionTree !== false;
  const predictionDir = resolveWorkspacePath({
    fileSystem,
    workspaceRoot: projectRoot,
    invocationRoot: projectRoot,
    bucket: "prediction",
  });
  const predictionTrackedFiles = readPredictionTreeAsTrackedFiles({
    fileSystem,
    predictionDir,
  });
  const shouldReadFromPredictionTree = shouldPreferPredictionTree && predictionTrackedFiles.length > 0;

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
  if (shouldReadFromPredictionTree) {
    files.push(...predictionTrackedFiles);
  }

  for (const migration of state.migrations) {
    const migrationSource = fileSystem.readText(migration.filePath);
    files.push({
      relativePath: toProjectRelativePath(projectRoot, migration.filePath),
      migrationNumber: migration.number,
      kind: "migration",
      content: migrationSource,
    });

    if (!shouldReadFromPredictionTree) {
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
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolveWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
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
    const revisionDiff = prepareDesignRevisionDiffContext(dependencies.fileSystem, projectRoot, {
      invocationRoot,
      target: targetRevision.name,
    });
    const vars = buildTemplateVars({
      fileSystem: dependencies.fileSystem,
      state: latestState,
      projectRoot,
      invocationRoot,
      workspaceDirectories,
      workspacePlacement,
      workspacePaths,
      designRevisionTarget: targetRevision.name,
      revisionDiff,
      newMigrations: "",
    });
    const prompt = renderTemplate(planningTemplate, vars);
    emit({
      kind: "info",
      message: "Planning migrations for "
        + (revisionDiff.fromRevision?.name ?? "nothing")
        + " → "
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
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolveWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
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
    designRevisionTarget: targetRevision,
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
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolveWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
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
  toRevName?: string;
  noBacklog: boolean;
  artifactRunExtra: Record<string, unknown>;
}): Promise<number> {
  const {
    dependencies,
    migrationsDir,
    invocationRoot,
    workspaceRoot,
    artifactContext,
    keepArtifacts,
    downCount,
    toRevName,
    noBacklog,
  } = input;

  const emit = dependencies.output.emit.bind(dependencies.output);
  const revisions = discoverDesignRevisionDirectories(
    dependencies.fileSystem,
    workspaceRoot,
    { invocationRoot },
  );
  const plannedRevisions = revisions
    .slice()
    .sort((left, right) => left.index - right.index)
    .filter((revision) => revision.metadata.plannedAt !== null);
  const lastPlannedRevision = plannedRevisions[plannedRevisions.length - 1];
  if (!lastPlannedRevision || lastPlannedRevision.index === 0) {
    emit({ kind: "info", message: "Already at baseline (rev.0). Nothing to rewind." });
    return EXIT_CODE_SUCCESS;
  }

  const { stopAfter } = resolveRewindTarget(revisions, downCount, toRevName);
  const parsedStopAfter = parseDesignRevisionDirectoryName(stopAfter);
  if (!parsedStopAfter) {
    throw new Error("Failed to resolve rewind boundary: " + stopAfter + ".");
  }

  const revisionsToRewind = plannedRevisions
    .filter((revision) => revision.index > parsedStopAfter.index)
    .sort((left, right) => right.index - left.index);
  if (revisionsToRewind.length === 0) {
    emit({ kind: "info", message: "Already at " + stopAfter + ". Nothing to rewind." });
    return EXIT_CODE_SUCCESS;
  }

  if (!dependencies.revertTask) {
    throw new Error("migrate down requires revertTask dependency.");
  }

  const completedRunBySource = new Map<string, { runId: string }>();
  for (const run of dependencies.artifactStore
    .listSaved(artifactContext.configDir)
    .filter((savedRun) => savedRun.commandName === "run" && savedRun.status === "completed")) {
    const normalizedSource = typeof run.source === "string"
      ? run.source.trim().replace(/\\/g, "/")
      : "";
    if (normalizedSource.length === 0 || completedRunBySource.has(normalizedSource)) {
      continue;
    }
    completedRunBySource.set(normalizedSource, { runId: run.runId });
  }

  for (const revision of revisionsToRewind) {
    const revisionMigrations = (revision.metadata.migrations ?? [])
      .map((migrationFileName) => migrationFileName.trim())
      .filter((migrationFileName) => migrationFileName.length > 0);
    const rewoundMigrationRecords: Array<{ name: string; source: string }> = [];

    for (const migrationFileName of revisionMigrations) {
      const migrationPath = path.join(migrationsDir, migrationFileName);
      const migrationSource = dependencies.fileSystem.exists(migrationPath)
        ? dependencies.fileSystem.readText(migrationPath)
        : "";

      const normalizedMigrationPath = migrationPath.replace(/\\/g, "/");
      const normalizedMigrationFileName = migrationFileName.replace(/\\/g, "/");
      const matchingRun = completedRunBySource.get(normalizedMigrationPath)
        ?? completedRunBySource.get(normalizedMigrationFileName)
        ?? [...completedRunBySource.entries()]
          .find(([sourcePath]) => {
            return sourcePath.endsWith("/" + normalizedMigrationFileName)
              || sourcePath === normalizedMigrationFileName;
          })?.[1];

      if (matchingRun) {
        const revertCode = await dependencies.revertTask({
          runId: matchingRun.runId,
          method: "revert",
          dryRun: false,
          keepArtifacts,
          force: false,
        });
        if (revertCode !== EXIT_CODE_SUCCESS) {
          emit({
            kind: "error",
            message:
              "Failed to rewind revision "
              + revision.name
              + " while reverting "
              + migrationFileName
              + ".",
          });
          return revertCode;
        }
      } else {
        emit({
          kind: "warn",
          message:
            "No artifact run found for "
            + migrationFileName
            + "; treating it as already reverted.",
        });
      }

      rewoundMigrationRecords.push({
        name: parseMigrationFilename(migrationFileName)?.name ?? migrationFileName,
        source: migrationSource,
      });

      if (dependencies.fileSystem.exists(migrationPath)) {
        dependencies.fileSystem.unlink(migrationPath);
      }
    }

    markRevisionUnplanned(dependencies.fileSystem, workspaceRoot, revision.name);
    markRevisionUnmigrated(dependencies.fileSystem, workspaceRoot, revision.name);
    if (!noBacklog && rewoundMigrationRecords.length > 0) {
      const stateBeforeBacklogUpdate = readMigrationState(dependencies.fileSystem, migrationsDir);
      const backlogPath = stateBeforeBacklogUpdate.backlogPath ?? path.join(migrationsDir, "Backlog.md");
      appendMigrationsToBacklog({
        fileSystem: dependencies.fileSystem,
        backlogPath,
        migrations: rewoundMigrationRecords,
      });
    }
    emit({
      kind: "info",
      message:
        "Rewound "
        + revision.name
        + " ("
        + String(revisionMigrations.length)
        + " migrations reverted).",
    });
  }

  if (revisionsToRewind.length > 1) {
    const newestRewoundRevision = revisionsToRewind[0];
    const oldestRewoundRevision = revisionsToRewind[revisionsToRewind.length - 1];
    if (newestRewoundRevision && oldestRewoundRevision) {
      emit({
        kind: "info",
        message:
          "Migrations rewound from "
          + oldestRewoundRevision.name
          + " to "
          + newestRewoundRevision.name
          + ".",
      });
    }
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

  persistPredictionBaselineSnapshot(dependencies.fileSystem, migrationsDir, workspaceRoot, {
    preferPredictionTree: false,
  });

  return EXIT_CODE_SUCCESS;
}

function appendMigrationsToBacklog(input: {
  fileSystem: FileSystem;
  backlogPath: string;
  migrations: ReadonlyArray<{ name: string; source: string }>;
}): void {
  const { fileSystem, backlogPath, migrations } = input;
  if (migrations.length === 0) {
    return;
  }

  const existingBacklog = fileSystem.exists(backlogPath)
    ? fileSystem.readText(backlogPath)
    : "";
  const removedSection = migrations
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
  fileSystem.writeText(backlogPath, nextBacklog);
}

function resolveRewindTarget(
  metas: ReadonlyArray<{
    index: number;
    name: string;
    metadata: {
      plannedAt: string | null;
    };
  }>,
  downCount?: number,
  toRevName?: string,
): { stopAfter: string } {
  const sortedMetas = metas
    .slice()
    .sort((left, right) => left.index - right.index);
  const plannedRevisions = sortedMetas
    .filter((revision) => revision.metadata.plannedAt !== null);

  if (toRevName !== undefined) {
    if (downCount !== undefined) {
      throw new Error("Cannot combine `migrate down [n]` with `--to <revName>`. Choose one rewind target mode.");
    }

    const normalizedToRevisionName = toRevName.trim();
    const parsedTargetRevision = parseDesignRevisionDirectoryName(normalizedToRevisionName);
    if (!parsedTargetRevision) {
      throw new Error(
        "Invalid --to value: "
          + toRevName
          + ". Allowed: rev.<n> (for example: rev.0).",
      );
    }

    if (parsedTargetRevision.index === 0) {
      return { stopAfter: "rev.0" };
    }

    const matchedPlannedRevision = plannedRevisions.find((revision) => revision.index === parsedTargetRevision.index);
    if (!matchedPlannedRevision) {
      throw new Error(
        "Invalid --to value: "
          + normalizedToRevisionName
          + ". Target revision must be currently planned (or rev.0).",
      );
    }

    return { stopAfter: matchedPlannedRevision.name };
  }

  const highestPlannedRevision = plannedRevisions[plannedRevisions.length - 1];
  if (!highestPlannedRevision) {
    return { stopAfter: "rev.0" };
  }

  const requestedDownCount = Number.isFinite(downCount)
    ? Math.max(1, Math.floor(downCount ?? 1))
    : 1;
  const stopAfterIndex = Math.max(0, highestPlannedRevision.index - requestedDownCount);
  const matchedStopAfterRevision = sortedMetas.find((revision) => revision.index === stopAfterIndex);

  return {
    stopAfter: matchedStopAfterRevision?.name ?? `rev.${String(stopAfterIndex)}`,
  };
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
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolveWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  templateFile: string;
  defaultTemplate: string;
  satelliteType: SatelliteType;
  workerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  workerTimeoutMs?: number;
  confirm: boolean;
  showAgentOutput: boolean;
  designRevisionTarget?: string | number;
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
    designRevisionTarget,
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
      designRevisionTarget,
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
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>;
  workspacePlacement: ReturnType<typeof resolveWorkspacePlacement>;
  workspacePaths: ReturnType<typeof resolveWorkspacePaths>;
  designRevisionTarget?: string | number;
  revisionDiff?: DesignRevisionDiffContext;
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
    revisionDiff: providedRevisionDiff,
    newMigrations,
  } = input;
  const latestMigration = state.migrations[state.migrations.length - 1] ?? null;
  const latestSnapshot = state.latestSnapshot?.filePath ?? null;
  const backlog = state.backlogPath && fileSystem.exists(state.backlogPath)
    ? fileSystem.readText(state.backlogPath)
    : "";

  const revisionDiff = providedRevisionDiff
    ?? prepareDesignRevisionDiffContext(fileSystem, projectRoot, {
      invocationRoot,
      target: designRevisionTarget,
    });
  const designContextSources = {
    sourceReferences: [revisionDiff.toTarget.absolutePath],
    hasManagedDocs: isDirectory(fileSystem, revisionDiff.toTarget.absolutePath),
  };
  const design = formatRevisionDesignContext(fileSystem, revisionDiff.toTarget.absolutePath);
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
    designRevisionDiffContent: revisionDiffContent,
    designRevisionDiffSources: revisionDiffSourceRefs,
    workspaceDesignDir: workspaceDirectories.design,
    workspaceSpecsDir: workspaceDirectories.specs,
    workspaceMigrationsDir: workspaceDirectories.migrations,
    workspacePredictionDir: workspaceDirectories.prediction,
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
