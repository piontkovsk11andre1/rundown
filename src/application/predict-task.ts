import path from "node:path";
import { parseMigrationDirectory } from "../domain/migration-parser.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type {
  FileSystem,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { resolveWorkspaceRootForPathSensitiveCommand } from "./workspace-selection.js";
import {
  resolveArchiveWorkspacePaths,
  resolvePredictionWorkspacePaths,
  resolveWorkspacePath,
  resolveWorkspacePaths,
} from "./workspace-paths.js";
import {
  discoverMigrationThreads,
  loadMigrationThreadStates,
} from "./migrate-task.js";
import {
  readPredictionProgress,
  toMigrationContentHash,
  toPredictionProgressRecord,
  writePredictionProgress,
  type PredictionProgressRecord,
} from "./prediction-progress-state.js";

export interface PredictTaskOptions {
  dir?: string;
  workspace?: string;
  workerPattern: ParsedWorkerPattern;
  keepArtifacts?: boolean;
  showAgentOutput?: boolean;
}

export interface PredictTaskDependencies {
  fileSystem: FileSystem;
  output: ApplicationOutputPort;
  runTask: (options: {
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
    commitAfterComplete: false;
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
}

export function createPredictTask(
  dependencies: PredictTaskDependencies,
): (options: PredictTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function predictTask(options: PredictTaskOptions): Promise<number> {
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

    const archivePaths = resolveArchiveWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
    });
    const workspacePaths = resolveWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
    });
    const predictionWorkspacePaths = resolvePredictionWorkspacePaths({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: executionContext.invocationDir,
    });
    const legacyPredictionState = inspectLegacyPredictionRoot({
      fileSystem: dependencies.fileSystem,
      predictionRootPath: workspacePaths.prediction,
    });
    if (legacyPredictionState.hasLegacyEntries && !dependencies.fileSystem.exists(predictionWorkspacePaths.latest)) {
      seedPredictionLatestFromLegacyRoot({
        fileSystem: dependencies.fileSystem,
        predictionRootPath: workspacePaths.prediction,
        latestPath: predictionWorkspacePaths.latest,
      });
    }
    const rootState = readMigrationStateFromDirectoryOrEmpty(
      dependencies.fileSystem,
      migrationsDir,
      archivePaths.migrationRootLane,
    );
    const discoveredThreads = discoverMigrationThreads(dependencies.fileSystem, workspaceRoot);
    const threadStates = loadMigrationThreadStates({
      fileSystem: dependencies.fileSystem,
      migrationsDir,
      archivedThreadsDir: archivePaths.migrationThreads,
      threads: discoveredThreads,
    });
    const orderedMigrations = [
      ...rootState.migrations.map((migration) => ({
        migration,
        lane: { kind: "root" as const },
      })),
      ...threadStates.flatMap((threadState) => threadState.state.migrations.map((migration) => ({
        migration,
        lane: {
          kind: "thread" as const,
          threadSlug: threadState.thread.threadSlug,
        },
      }))),
    ];

    if (orderedMigrations.length === 0) {
      emit({ kind: "info", message: "No migrations found to predict." });
      return EXIT_CODE_SUCCESS;
    }

    const migrationInputs = orderedMigrations.map((migration) => {
      const migrationSource = dependencies.fileSystem.readText(migration.migration.filePath);
      return {
        migration: migration.migration,
        lane: migration.lane,
        migrationSource,
        migrationIdentifier: toMigrationIdentifier(workspaceRoot, migration.migration.filePath),
        migrationNumber: migration.migration.number,
        migrationFileName: path.basename(migration.migration.filePath),
        migrationContentHash: toMigrationContentHash(migrationSource),
      };
    });

    const expectedWorkspaceRoutingFingerprint = toWorkspaceRoutingFingerprint(workspacePaths);
    const progressRead = readPredictionProgress(dependencies.fileSystem, workspaceRoot);
    const predictionProgress = progressRead.progress;
    if (progressRead.status === "missing") {
      emit({
        kind: "info",
        message: "Prediction progress state not found; starting from first migration.",
      });
    } else if (progressRead.status === "unreadable") {
      emit({
        kind: "warn",
        message: "Prediction progress state is unreadable at "
          + progressRead.filePath
          + ". "
          + (progressRead.reason ?? "Unable to parse state file.")
          + " Rebuilding progress from migration files.",
      });
    } else if (progressRead.status === "incompatible") {
      emit({
        kind: "warn",
        message: "Prediction progress state is incompatible at "
          + progressRead.filePath
          + ". "
          + (progressRead.reason ?? "Unsupported prediction progress schema.")
          + " Rebuilding progress from migration files.",
      });
    }

    const appliedRecordsByIdentifier = new Map<string, PredictionProgressRecord>();
    for (const record of predictionProgress.migrations) {
      appliedRecordsByIdentifier.set(record.migrationIdentifier, record);
    }

    const knownIdentifiers = new Set(migrationInputs.map((input) => input.migrationIdentifier));
    const replayDecision = resolvePredictionReplayDecision({
      migrationInputs,
      knownIdentifiers,
      predictionProgressRecords: predictionProgress.migrations,
      appliedRecordsByIdentifier,
      expectedPredictionRootPath: predictionWorkspacePaths.latest,
      expectedWorkspaceRoutingFingerprint,
      observedPredictionRootPath: predictionProgress.predictionRootPath,
      observedWorkspaceRoutingFingerprint: predictionProgress.workspaceRoutingFingerprint,
    });
    const replayFromIndex = replayDecision.replayFromIndex;
    if (replayDecision.diagnostic) {
      emit({ kind: "info", message: replayDecision.diagnostic });
    }

    const retainedAppliedRecords = new Map<string, PredictionProgressRecord>();
    for (let index = 0; index < migrationInputs.length; index += 1) {
      const input = migrationInputs[index]!;
      if (replayFromIndex !== null && index >= replayFromIndex) {
        break;
      }
      const existingRecord = appliedRecordsByIdentifier.get(input.migrationIdentifier);
      if (!existingRecord) {
        continue;
      }
      if (existingRecord.migrationContentHash !== input.migrationContentHash) {
        continue;
      }
      retainedAppliedRecords.set(input.migrationIdentifier, existingRecord);
    }

    const unappliedMigrations = migrationInputs.filter((input, index) => {
      if (replayFromIndex !== null && index >= replayFromIndex) {
        return true;
      }
      return !retainedAppliedRecords.has(input.migrationIdentifier);
    });

    if (unappliedMigrations.length === 0) {
      if (legacyPredictionState.hasLegacyEntries) {
        removeLegacyPredictionRootEntries({
          fileSystem: dependencies.fileSystem,
          predictionRootPath: workspacePaths.prediction,
        });
      }
      emit({ kind: "info", message: "Prediction is already up to date." });
      return EXIT_CODE_SUCCESS;
    }

    const predictExecutionDir = path.join(workspaceRoot, ".rundown", "prediction-execution");
    dependencies.fileSystem.mkdir(predictExecutionDir, { recursive: true });

    for (const migrationInput of unappliedMigrations) {
      emit({
        kind: "info",
        message: "Predicting migration " + migrationInput.migrationFileName + "...",
      });

      const executionSourcePath = path.join(
        predictExecutionDir,
        toPredictExecutionFileName(migrationInput.migration.filePath),
      );
      dependencies.fileSystem.writeText(
        executionSourcePath,
        buildPredictExecutionSource({
          migrationPath: migrationInput.migration.filePath,
          migrationSource: migrationInput.migrationSource,
          predictionHeadPath: predictionWorkspacePaths.latest,
        }),
      );

      const exitCode = await dependencies.runTask({
        source: executionSourcePath,
        cwd: workspaceRoot,
        invocationDir: executionContext.invocationDir,
        workspaceDir: executionContext.workspaceDir,
        workspaceLinkPath: executionContext.workspaceLinkPath,
        isLinkedWorkspace: executionContext.isLinkedWorkspace,
        mode: "wait",
        workerPattern: options.workerPattern,
        sortMode: "name-sort",
        verify: true,
        onlyVerify: false,
        forceExecute: false,
        forceAttempts: 2,
        noRepair: false,
        repairAttempts: 1,
        dryRun: false,
        printPrompt: false,
        keepArtifacts: Boolean(options.keepArtifacts),
        varsFileOption: undefined,
        cliTemplateVarArgs: [],
        commitAfterComplete: false,
        commitMode: "per-task",
        runAll: true,
        redo: false,
        resetAfter: false,
        clean: false,
        rounds: 1,
        showAgentOutput: Boolean(options.showAgentOutput),
        trace: false,
        traceOnly: false,
        forceUnlock: false,
        ignoreCliBlock: false,
        verbose: false,
      });
      if (exitCode !== EXIT_CODE_SUCCESS) {
        return exitCode;
      }

      const laneSnapshotDirectory = migrationInput.lane.kind === "root"
        ? predictionWorkspacePaths.snapshotsRoot
        : path.join(predictionWorkspacePaths.snapshotsThreads, migrationInput.lane.threadSlug);
      refreshPredictionLaneSnapshot({
        fileSystem: dependencies.fileSystem,
        latestPath: predictionWorkspacePaths.latest,
        snapshotPath: path.join(laneSnapshotDirectory, String(migrationInput.migration.number)),
      });

      retainedAppliedRecords.set(
        migrationInput.migrationIdentifier,
        toPredictionProgressRecord({
          migrationIdentifier: migrationInput.migrationIdentifier,
          migrationNumber: migrationInput.migration.number,
          migrationFileName: migrationInput.migrationFileName,
          migrationContentHash: migrationInput.migrationContentHash,
        }),
      );
      writePredictionProgress(dependencies.fileSystem, workspaceRoot, {
        predictionRootPath: predictionWorkspacePaths.latest,
        workspaceRoutingFingerprint: expectedWorkspaceRoutingFingerprint,
        migrations: [...retainedAppliedRecords.values()],
      });
    }

    if (legacyPredictionState.hasLegacyEntries) {
      removeLegacyPredictionRootEntries({
        fileSystem: dependencies.fileSystem,
        predictionRootPath: workspacePaths.prediction,
      });
    }

    emit({ kind: "success", message: "Prediction run completed." });
    return EXIT_CODE_SUCCESS;
  };
}

function inspectLegacyPredictionRoot(input: {
  fileSystem: FileSystem;
  predictionRootPath: string;
}): {
  hasLegacyEntries: boolean;
} {
  const { fileSystem, predictionRootPath } = input;
  if (!fileSystem.exists(predictionRootPath)) {
    return { hasLegacyEntries: false };
  }

  const predictionRootStat = fileSystem.stat(predictionRootPath);
  if (!predictionRootStat?.isDirectory) {
    return { hasLegacyEntries: false };
  }

  const hasLegacyEntries = fileSystem.readdir(predictionRootPath)
    .some((entry) => !isPredictionContainerEntry(entry.name));
  return { hasLegacyEntries };
}

function seedPredictionLatestFromLegacyRoot(input: {
  fileSystem: FileSystem;
  predictionRootPath: string;
  latestPath: string;
}): void {
  const { fileSystem, predictionRootPath, latestPath } = input;
  fileSystem.mkdir(latestPath, { recursive: true });

  const rootEntries = fileSystem.readdir(predictionRootPath)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of rootEntries) {
    if (isPredictionContainerEntry(entry.name)) {
      continue;
    }
    copyPathRecursively({
      fileSystem,
      sourcePath: path.join(predictionRootPath, entry.name),
      destinationPath: path.join(latestPath, entry.name),
    });
  }
}

function removeLegacyPredictionRootEntries(input: {
  fileSystem: FileSystem;
  predictionRootPath: string;
}): void {
  const { fileSystem, predictionRootPath } = input;
  if (!fileSystem.exists(predictionRootPath)) {
    return;
  }

  const predictionRootStat = fileSystem.stat(predictionRootPath);
  if (!predictionRootStat?.isDirectory) {
    return;
  }

  const rootEntries = fileSystem.readdir(predictionRootPath)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of rootEntries) {
    if (isPredictionContainerEntry(entry.name)) {
      continue;
    }
    fileSystem.rm(path.join(predictionRootPath, entry.name), { recursive: true, force: true });
  }
}

function isPredictionContainerEntry(name: string): boolean {
  return name === "latest" || name === "snapshots";
}

function resolvePredictionReplayDecision(input: {
  migrationInputs: Array<{
    migrationIdentifier: string;
    migrationNumber: number;
    migrationFileName: string;
    migrationContentHash: string;
  }>;
  knownIdentifiers: ReadonlySet<string>;
  predictionProgressRecords: readonly PredictionProgressRecord[];
  appliedRecordsByIdentifier: ReadonlyMap<string, PredictionProgressRecord>;
  expectedPredictionRootPath: string;
  expectedWorkspaceRoutingFingerprint: string;
  observedPredictionRootPath: string;
  observedWorkspaceRoutingFingerprint: string;
}): {
  replayFromIndex: number | null;
  diagnostic: string | null;
} {
  const {
    migrationInputs,
    knownIdentifiers,
    predictionProgressRecords,
    appliedRecordsByIdentifier,
    expectedPredictionRootPath,
    expectedWorkspaceRoutingFingerprint,
    observedPredictionRootPath,
    observedWorkspaceRoutingFingerprint,
  } = input;

  if (!equivalentPathToken(observedPredictionRootPath, expectedPredictionRootPath)) {
    return {
      replayFromIndex: 0,
      diagnostic: "Prediction progress invalidated: prediction root path changed since the previous prediction run. Replaying all migrations.",
    };
  }
  if (observedWorkspaceRoutingFingerprint !== expectedWorkspaceRoutingFingerprint) {
    return {
      replayFromIndex: 0,
      diagnostic: "Prediction progress invalidated: workspace routing changed since the previous prediction run. Replaying all migrations.",
    };
  }

  for (let index = 0; index < migrationInputs.length; index += 1) {
    const migrationInput = migrationInputs[index]!;
    const existingRecord = appliedRecordsByIdentifier.get(migrationInput.migrationIdentifier);
    if (!existingRecord) {
      continue;
    }

    if (existingRecord.migrationContentHash === migrationInput.migrationContentHash) {
      continue;
    }

    return {
      replayFromIndex: index,
      diagnostic: "Prediction progress invalidated: migration content changed for "
        + migrationInput.migrationFileName
        + " ("
        + compactHash(existingRecord.migrationContentHash)
        + " -> "
        + compactHash(migrationInput.migrationContentHash)
        + "). Replaying from this migration.",
    };
  }

  for (const record of predictionProgressRecords) {
    if (knownIdentifiers.has(record.migrationIdentifier)) {
      continue;
    }

    const renamedOrRenumbered = migrationInputs.find((migrationInput) => {
      return migrationInput.migrationNumber === record.migrationNumber;
    });
    if (renamedOrRenumbered) {
      return {
        replayFromIndex: 0,
        diagnostic: "Prediction progress invalidated: previously predicted migration "
          + record.migrationFileName
          + " is now "
          + renamedOrRenumbered.migrationFileName
          + " (possible rename or renumber). Replaying all migrations.",
      };
    }

    return {
      replayFromIndex: 0,
      diagnostic: "Prediction progress invalidated: previously predicted migration "
        + record.migrationFileName
        + " is missing from current migration discovery (possible deletion). Replaying all migrations.",
    };
  }

  return {
    replayFromIndex: null,
    diagnostic: null,
  };
}

function equivalentPathToken(left: string, right: string): boolean {
  return normalizePathToken(left) === normalizePathToken(right);
}

function normalizePathToken(value: string): string {
  return value.trim().replace(/[\\/]+/g, "/").toLowerCase();
}

function compactHash(hash: string): string {
  if (hash.length <= 12) {
    return hash;
  }
  return hash.slice(0, 12);
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

function listMigrationLaneFiles(input: {
  fileSystem: FileSystem;
  migrationsDir: string;
  archivedMigrationsDir?: string;
}): string[] {
  const { fileSystem, migrationsDir, archivedMigrationsDir } = input;
  const archivedFiles = listMigrationFilesInDirectory(fileSystem, archivedMigrationsDir);
  const hotFiles = listMigrationFilesInDirectory(fileSystem, migrationsDir);
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

function toPredictExecutionFileName(migrationPath: string): string {
  const parsed = path.parse(path.basename(migrationPath));
  const safeName = parsed.name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const baseName = safeName.length > 0 ? safeName : "migration";
  return `${baseName}-${stablePathHash(migrationPath)}.predict.md`;
}

function toMigrationIdentifier(workspaceRoot: string, migrationPath: string): string {
  return path.relative(workspaceRoot, migrationPath).split(path.sep).join("/");
}

function toWorkspaceRoutingFingerprint(paths: {
  design: string;
  implementation: string;
  specs: string;
  migrations: string;
  prediction: string;
}): string {
  return toMigrationContentHash([
    paths.design,
    paths.implementation,
    paths.specs,
    paths.migrations,
    paths.prediction,
  ].join("\n"));
}

function buildPredictExecutionSource(input: {
  migrationPath: string;
  migrationSource: string;
  predictionHeadPath: string;
}): string {
  const { migrationPath, migrationSource, predictionHeadPath } = input;
  const fence = "```";

  return [
    "# Prediction Migration Pass",
    "",
    "Execute this migration as one prediction-file pass.",
    "",
    "## Migration file",
    "",
    migrationPath,
    "",
    "## Migration content",
    "",
    `${fence}markdown`,
    migrationSource,
    fence,
    "",
    "## Task",
    "",
    "- [ ] Apply the migration file to " + predictionHeadPath + " as a single pass. Update prediction state only, then verify and repair this migration pass as needed before completion.",
    "",
  ].join("\n");
}

function stablePathHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}

function refreshPredictionLaneSnapshot(input: {
  fileSystem: FileSystem;
  latestPath: string;
  snapshotPath: string;
}): void {
  const { fileSystem, latestPath, snapshotPath } = input;
  fileSystem.rm(snapshotPath, { recursive: true, force: true });
  fileSystem.mkdir(snapshotPath, { recursive: true });

  if (!fileSystem.exists(latestPath)) {
    return;
  }

  const latestStat = fileSystem.stat(latestPath);
  if (!latestStat?.isDirectory) {
    throw new Error("Prediction latest path is not a directory: " + latestPath);
  }

  copyDirectoryContents({
    fileSystem,
    sourceDir: latestPath,
    destinationDir: snapshotPath,
  });
}

function copyDirectoryContents(input: {
  fileSystem: FileSystem;
  sourceDir: string;
  destinationDir: string;
}): void {
  const { fileSystem, sourceDir, destinationDir } = input;
  const entries = fileSystem.readdir(sourceDir)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory) {
      fileSystem.mkdir(destinationPath, { recursive: true });
      copyDirectoryContents({
        fileSystem,
        sourceDir: sourcePath,
        destinationDir: destinationPath,
      });
      continue;
    }
    if (!entry.isFile) {
      continue;
    }
    fileSystem.writeText(destinationPath, fileSystem.readText(sourcePath));
  }
}

function copyPathRecursively(input: {
  fileSystem: FileSystem;
  sourcePath: string;
  destinationPath: string;
}): void {
  const { fileSystem, sourcePath, destinationPath } = input;
  const sourceStat = fileSystem.stat(sourcePath);
  if (!sourceStat) {
    return;
  }

  if (sourceStat.isDirectory) {
    fileSystem.mkdir(destinationPath, { recursive: true });
    copyDirectoryContents({
      fileSystem,
      sourceDir: sourcePath,
      destinationDir: destinationPath,
    });
    return;
  }

  if (!sourceStat.isFile) {
    return;
  }
  fileSystem.writeText(destinationPath, fileSystem.readText(sourcePath));
}
