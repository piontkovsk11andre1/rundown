import path from "node:path";
import {
  DEFAULT_MIGRATE_BACKLOG_TEMPLATE,
  DEFAULT_MIGRATE_CONTEXT_TEMPLATE,
  DEFAULT_MIGRATE_REVIEW_TEMPLATE,
  DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE,
  DEFAULT_MIGRATE_TEMPLATE,
  DEFAULT_MIGRATE_USER_EXPERIENCE_TEMPLATE,
} from "../domain/defaults.js";
import {
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
import { resolveWorkspaceLink } from "../domain/workspace-link.js";
import {
  prepareDesignRevisionDiffContext,
  resolveDesignContext,
  saveDesignRevisionSnapshot,
} from "./design-context.js";

type MigrateAction =
  | "up"
  | "down"
  | "save"
  | "snapshot"
  | "backlog"
  | "context"
  | "review"
  | "user-experience"
  | "user-session";

interface MigrationProposal {
  name: string;
  label: string;
}

export interface MigrateTaskOptions {
  action?: MigrateAction;
  downCount?: number;
  dir?: string;
  confirm?: boolean;
  workerPattern: ParsedWorkerPattern;
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
    const workspaceRoot = resolveWorkspaceRootFromCurrentDir(dependencies.fileSystem, invocationDir);
    const migrationsDir = path.resolve(workspaceRoot, options.dir ?? "migrations");

    if (!dependencies.fileSystem.exists(migrationsDir)) {
      emit({ kind: "error", message: "Migrations directory does not exist: " + migrationsDir });
      return EXIT_CODE_FAILURE;
    }

    const action = options.action;
    const projectRoot = path.dirname(migrationsDir);
    const configDir = path.join(projectRoot, ".rundown");
    const loadedWorkerConfig = dependencies.fileSystem.exists(configDir)
      ? dependencies.workerConfigPort.load(configDir)
      : undefined;
    const resolvedWorker = resolveWorkerPatternForInvocation({
      commandName: "migrate",
      workerConfig: loadedWorkerConfig,
      cliWorkerPattern: options.workerPattern,
      emit,
      mode: "wait",
    });

    if (resolvedWorker.workerCommand.length === 0) {
      emit({
        kind: "error",
        message:
          "No worker command available: .rundown/config.json has no configured worker, and no CLI worker was provided. Use --worker <pattern> or -- <command>.",
      });
      return EXIT_CODE_FAILURE;
    }

    if (action === "up") {
      if (!dependencies.runTask) {
        throw new Error("migrate up requires runTask dependency.");
      }

      await reconcilePendingMigrationPredictions({
        dependencies,
        migrationsDir,
        workspaceRoot,
        workerPattern: resolvedWorker.workerPattern,
        artifactContext: undefined,
        showAgentOutput: Boolean(options.showAgentOutput),
      });

      const runExitCode = await dependencies.runTask({
        source: migrationsDir,
        mode: "wait",
        workerPattern: resolvedWorker.workerPattern,
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
        commitAfterComplete: true,
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

      persistPredictionBaselineSnapshot(dependencies.fileSystem, migrationsDir);
      return runExitCode;
    }

    if (action === "down") {
      if (!dependencies.undoTask) {
        throw new Error("migrate down is not wired yet: undoTask dependency is missing.");
      }

      return dependencies.undoTask({
        runId: options.runId ?? "latest",
        last: options.downCount,
        workerPattern: resolvedWorker.workerPattern,
        keepArtifacts: options.keepArtifacts,
        showAgentOutput: options.showAgentOutput,
      });
    }

    if (action === "save") {
      const saveResult = saveDesignRevisionSnapshot(dependencies.fileSystem, projectRoot);
      if (saveResult.kind === "unchanged") {
        emit({
          kind: "info",
          message:
            "No design changes detected in docs/current/ since "
            + saveResult.latestRevision.name
            + "; skipped creating a new revision snapshot.",
        });
      } else {
        const savedRevision = saveResult.revision;
        emit({
          kind: "success",
          message:
            "Saved design revision "
            + savedRevision.name
            + " from docs/current/ to "
            + savedRevision.absolutePath
            + " ("
            + String(savedRevision.copiedFileCount)
            + " file"
            + (savedRevision.copiedFileCount === 1 ? "" : "s")
            + ").",
        });
      }
      return EXIT_CODE_SUCCESS;
    }

    const state = readMigrationState(dependencies.fileSystem, migrationsDir);

    const artifactContext = dependencies.artifactStore.createContext({
      cwd: workspaceRoot,
      configDir,
      commandName: "migrate",
      workerCommand: resolvedWorker.workerCommand,
      mode: "wait",
      source: migrationsDir,
      keepArtifacts: Boolean(options.keepArtifacts),
    });

    try {
      if (!action) {
        await generateNextMigration({
          dependencies,
          state,
          projectRoot,
          workspaceRoot,
          workerPattern: resolvedWorker.workerPattern,
          artifactContext,
          confirm: Boolean(options.confirm),
          showAgentOutput: Boolean(options.showAgentOutput),
        });
      } else if (action === "snapshot") {
        await generateSatellite({
          dependencies,
          state,
          projectRoot,
          workspaceRoot,
          templateFile: "migrate-snapshot.md",
          defaultTemplate: DEFAULT_MIGRATE_SNAPSHOT_TEMPLATE,
          satelliteType: "snapshot",
          workerPattern: resolvedWorker.workerPattern,
          artifactContext,
          confirm: Boolean(options.confirm),
          showAgentOutput: Boolean(options.showAgentOutput),
        });
      } else if (action === "backlog") {
        await generateSatellite({
          dependencies,
          state,
          projectRoot,
          workspaceRoot,
          templateFile: "migrate-backlog.md",
          defaultTemplate: DEFAULT_MIGRATE_BACKLOG_TEMPLATE,
          satelliteType: "backlog",
          workerPattern: resolvedWorker.workerPattern,
          artifactContext,
          confirm: Boolean(options.confirm),
          showAgentOutput: Boolean(options.showAgentOutput),
        });
      } else if (action === "context") {
        await generateSatellite({
          dependencies,
          state,
          projectRoot,
          workspaceRoot,
          templateFile: "migrate-context.md",
          defaultTemplate: DEFAULT_MIGRATE_CONTEXT_TEMPLATE,
          satelliteType: "context",
          workerPattern: resolvedWorker.workerPattern,
          artifactContext,
          confirm: Boolean(options.confirm),
          showAgentOutput: Boolean(options.showAgentOutput),
        });
      } else if (action === "review") {
        await generateSatellite({
          dependencies,
          state,
          projectRoot,
          workspaceRoot,
          templateFile: "migrate-review.md",
          defaultTemplate: DEFAULT_MIGRATE_REVIEW_TEMPLATE,
          satelliteType: "review",
          workerPattern: resolvedWorker.workerPattern,
          artifactContext,
          confirm: Boolean(options.confirm),
          showAgentOutput: Boolean(options.showAgentOutput),
        });
      } else if (action === "user-experience") {
        await generateSatellite({
          dependencies,
          state,
          projectRoot,
          workspaceRoot,
          templateFile: "migrate-ux.md",
          defaultTemplate: DEFAULT_MIGRATE_USER_EXPERIENCE_TEMPLATE,
          satelliteType: "user-experience",
          workerPattern: resolvedWorker.workerPattern,
          artifactContext,
          confirm: Boolean(options.confirm),
          showAgentOutput: Boolean(options.showAgentOutput),
        });
      } else if (action === "user-session") {
        await runUserSession({
          dependencies,
          state,
          projectRoot,
          workspaceRoot,
          workerPattern: resolvedWorker.workerPattern,
          artifactContext,
          confirm: Boolean(options.confirm),
          showAgentOutput: Boolean(options.showAgentOutput),
        });
      }

      dependencies.artifactStore.finalize(artifactContext, {
        status: "completed",
        preserve: Boolean(options.keepArtifacts),
      });
      return EXIT_CODE_SUCCESS;
    } catch (error) {
      dependencies.artifactStore.finalize(artifactContext, {
        status: "failed",
        preserve: Boolean(options.keepArtifacts),
        extra: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
      emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      return EXIT_CODE_FAILURE;
    }
  };
}

function persistPredictionBaselineSnapshot(fileSystem: FileSystem, migrationsDir: string): void {
  const predictionInputs = readPredictionInputs(fileSystem, migrationsDir);
  const baseline = createPredictionBaseline(predictionInputs);
  savePredictionBaseline(fileSystem, migrationsDir, baseline);
}

async function reconcilePendingMigrationPredictions(input: {
  dependencies: MigrateTaskDependencies;
  migrationsDir: string;
  workspaceRoot: string;
  workerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]> | undefined;
  showAgentOutput: boolean;
}): Promise<void> {
  const { dependencies, migrationsDir, workspaceRoot, workerPattern, artifactContext, showAgentOutput } = input;
  const emit = dependencies.output.emit.bind(dependencies.output);
  const predictionInputs = readPredictionInputs(dependencies.fileSystem, migrationsDir);
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
          workerPattern,
          prompt,
          mode: "wait",
          cwd: workspaceRoot,
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
      path.dirname(migrationsDir),
      reconciled.patch.removeRelativePaths,
      reconciled.patch.writeFiles,
    );
    persistPredictionBaselineSnapshot(dependencies.fileSystem, migrationsDir);
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

function readPredictionInputs(fileSystem: FileSystem, migrationsDir: string): PredictionInputs {
  const migrationFiles = fileSystem.readdir(migrationsDir)
    .filter((entry) => entry.isFile)
    .map((entry) => path.join(migrationsDir, entry.name))
    .filter((filePath) => parseMigrationFilename(path.basename(filePath)) !== null);
  const state = parseMigrationDirectory(migrationFiles, migrationsDir);
  const projectRoot = path.dirname(migrationsDir);

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
  if (type === "context") {
    return "context";
  }
  if (type === "snapshot") {
    return "snapshot";
  }
  if (type === "backlog") {
    return "backlog";
  }
  if (type === "review") {
    return "review";
  }
  if (type === "user-experience") {
    return "user-experience";
  }
  return null;
}

function toProjectRelativePath(projectRoot: string, absolutePath: string): string {
  return path.relative(projectRoot, absolutePath).replace(/\\/g, "/");
}

function resolveWorkspaceRootFromCurrentDir(fileSystem: FileSystem, currentDir: string): string {
  const resolution = resolveWorkspaceLink({
    currentDir,
    fileSystem,
    pathOperations: path,
  });

  return resolution.status === "resolved"
    ? resolution.workspaceRoot
    : path.resolve(currentDir);
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

async function runUserSession(input: {
  dependencies: MigrateTaskDependencies;
  state: ReturnType<typeof readMigrationState>;
  projectRoot: string;
  workspaceRoot: string;
  workerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  confirm: boolean;
  showAgentOutput: boolean;
}): Promise<void> {
  const {
    dependencies,
    state,
    projectRoot,
    workspaceRoot,
    workerPattern,
    artifactContext,
    confirm,
    showAgentOutput,
  } = input;
  const emit = dependencies.output.emit.bind(dependencies.output);
  const latestMigration = state.migrations[state.migrations.length - 1];
  if (!latestMigration) {
    throw new Error("No migration exists for user-session.");
  }

  const migrationSource = dependencies.fileSystem.readText(latestMigration.filePath);
  const discussionResult = await dependencies.workerExecutor.runWorker({
    workerPattern,
    prompt: buildUserSessionDiscussPrompt(latestMigration.filePath, migrationSource),
    mode: "tui",
    captureOutput: true,
    cwd: workspaceRoot,
    artifactContext,
    artifactPhase: "worker",
    artifactPhaseLabel: "migrate-user-session-discuss",
  });
  if ((discussionResult.exitCode ?? 1) !== 0) {
    throw new Error("Worker failed during migrate user-session discussion.");
  }

  const summaryResult = await dependencies.workerExecutor.runWorker({
    workerPattern,
    prompt: buildUserSessionSummaryPrompt({
      migrationFilePath: latestMigration.filePath,
      migrationSource,
      discussionStdout: discussionResult.stdout,
      discussionStderr: discussionResult.stderr,
    }),
    mode: "wait",
    cwd: workspaceRoot,
    artifactContext,
    artifactPhase: "worker",
    artifactPhaseLabel: "migrate-user-session-summary",
  });
  if ((summaryResult.exitCode ?? 1) !== 0) {
    throw new Error("Worker failed to summarize migrate user-session discussion.");
  }
  if (showAgentOutput && summaryResult.stderr.length > 0) {
    emit({ kind: "stderr", text: summaryResult.stderr });
  }

  const currentMigrationSource = dependencies.fileSystem.readText(latestMigration.filePath);
  const updatedMigration = mergeUserSessionSummary(currentMigrationSource, summaryResult.stdout.trim());

  if (confirm) {
    const approved = await confirmBeforeWrite(
      dependencies.output,
      dependencies.interactiveInput,
      path.basename(latestMigration.filePath),
      updatedMigration,
    );
    if (!approved) {
      return;
    }
  }

  dependencies.fileSystem.writeText(latestMigration.filePath, updatedMigration);

  await generateSatellite({
    dependencies,
    state: readMigrationState(dependencies.fileSystem, state.migrationsDir),
    projectRoot,
    workspaceRoot,
    templateFile: "migrate-backlog.md",
    defaultTemplate: DEFAULT_MIGRATE_BACKLOG_TEMPLATE,
    satelliteType: "backlog",
    workerPattern,
    artifactContext,
    confirm,
    showAgentOutput,
  });
}

function buildUserSessionDiscussPrompt(migrationFilePath: string, migrationSource: string): string {
  return [
    "Run an interactive migration user-session in TUI mode.",
    "",
    "Goals:",
    "- Discuss the latest migration with the user.",
    "- Ask clarifying questions about scope, constraints, and acceptance criteria.",
    "- Gather decisions and unresolved questions.",
    "",
    "When the user exits the TUI session, the CLI will ask for a separate summary.",
    "Do not rewrite files in this step.",
    "",
    "Migration file:",
    migrationFilePath,
    "",
    "Migration source:",
    migrationSource,
  ].join("\n");
}

function buildUserSessionSummaryPrompt(input: {
  migrationFilePath: string;
  migrationSource: string;
  discussionStdout: string;
  discussionStderr: string;
}): string {
  return [
    "Summarize the completed migration user-session discussion.",
    "",
    "Return Markdown only. Keep it concise and actionable.",
    "Include:",
    "- decisions made",
    "- open questions",
    "- concrete follow-up tasks",
    "",
    "Use this heading exactly:",
    "## User session summary",
    "",
    "Migration file:",
    input.migrationFilePath,
    "",
    "Migration source before summary append:",
    input.migrationSource,
    "",
    "Discussion stdout transcript:",
    input.discussionStdout || "(empty)",
    "",
    "Discussion stderr transcript:",
    input.discussionStderr || "(empty)",
  ].join("\n");
}

function mergeUserSessionSummary(currentMigrationSource: string, summary: string): string {
  const normalizedSummary = summary.endsWith("\n") ? summary : summary + "\n";
  const summaryHeading = "## User session summary";
  const sectionPattern = /^## User session summary\s*[\s\S]*?(?=^##\s+|\s*$)/m;

  if (sectionPattern.test(currentMigrationSource)) {
    const replaced = currentMigrationSource.replace(sectionPattern, normalizedSummary.trimEnd());
    return replaced.endsWith("\n") ? replaced : replaced + "\n";
  }

  const base = currentMigrationSource.endsWith("\n")
    ? currentMigrationSource
    : currentMigrationSource + "\n";
  const summaryBlock = normalizedSummary.startsWith(summaryHeading)
    ? normalizedSummary
    : `${summaryHeading}\n\n${normalizedSummary}`;

  return `${base}\n${summaryBlock}`;
}

async function generateNextMigration(input: {
  dependencies: MigrateTaskDependencies;
  state: ReturnType<typeof readMigrationState>;
  projectRoot: string;
  workspaceRoot: string;
  workerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  confirm: boolean;
  showAgentOutput: boolean;
}): Promise<void> {
  const { dependencies, state, projectRoot, workspaceRoot, workerPattern, artifactContext, confirm, showAgentOutput } = input;
  const emit = dependencies.output.emit.bind(dependencies.output);
  const template = readTemplate(
    dependencies.templateLoader,
    projectRoot,
    "migrate.md",
    DEFAULT_MIGRATE_TEMPLATE,
  );
  const vars = buildTemplateVars(dependencies.fileSystem, state, projectRoot);
  const prompt = renderTemplate(template, vars);

  const result = await dependencies.workerExecutor.runWorker({
    workerPattern,
    prompt,
    mode: "wait",
    cwd: workspaceRoot,
    artifactContext,
    artifactPhase: "worker",
    artifactPhaseLabel: "migrate-next",
  });
  if ((result.exitCode ?? 1) !== 0) {
    throw new Error("Worker failed to generate migration proposals.");
  }
  if (showAgentOutput && result.stderr.length > 0) {
    emit({ kind: "stderr", text: result.stderr });
  }

  const proposals = parseProposals(result.stdout);
  if (proposals.length === 0) {
    throw new Error("Worker returned no migration proposals.");
  }

  emit({ kind: "info", message: "Proposed migrations:" });
  for (const [index, proposal] of proposals.entries()) {
    emit({ kind: "text", text: `${index + 1}. ${proposal.label}\n` });
  }

  const selected = await selectProposal(dependencies.interactiveInput, proposals);
  const nextNumber = String(state.currentPosition + 1).padStart(4, "0");
  const migrationFilename = `${nextNumber}-${toKebabCase(selected.name)}.md`;
  const migrationPath = path.join(state.migrationsDir, migrationFilename);
  const migrationContent = createMigrationDocument(nextNumber, selected, result.stdout);

  if (confirm) {
    const approved = await confirmBeforeWrite(
      dependencies.output,
      dependencies.interactiveInput,
      migrationFilename,
      migrationContent,
    );
    if (!approved) {
      return;
    }
  }

  dependencies.fileSystem.writeText(migrationPath, migrationContent);

  await runExploreForMigration({
    runExplore: dependencies.runExplore,
    migrationPath,
    projectRoot,
    emit,
  });

  await generateSatellite({
    dependencies,
    state: readMigrationState(dependencies.fileSystem, state.migrationsDir),
    projectRoot,
    workspaceRoot,
    templateFile: "migrate-context.md",
    defaultTemplate: DEFAULT_MIGRATE_CONTEXT_TEMPLATE,
    satelliteType: "context",
    workerPattern,
    artifactContext,
    confirm,
    showAgentOutput,
  });
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
  workspaceRoot: string;
  templateFile: string;
  defaultTemplate: string;
  satelliteType: SatelliteType;
  workerPattern: ParsedWorkerPattern;
  artifactContext: ReturnType<ArtifactStore["createContext"]>;
  confirm: boolean;
  showAgentOutput: boolean;
}): Promise<void> {
  const {
    dependencies,
    state,
    projectRoot,
    workspaceRoot,
    templateFile,
    defaultTemplate,
    satelliteType,
    workerPattern,
    artifactContext,
    confirm,
    showAgentOutput,
  } = input;
  const emit = dependencies.output.emit.bind(dependencies.output);

  const template = readTemplate(
    dependencies.templateLoader,
    projectRoot,
    templateFile,
    defaultTemplate,
  );
  const vars = buildTemplateVars(dependencies.fileSystem, state, projectRoot);
  const prompt = renderTemplate(template, vars);

  const result = await dependencies.workerExecutor.runWorker({
    workerPattern,
    prompt,
    mode: "wait",
    cwd: workspaceRoot,
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
  const filename = `${String(position).padStart(4, "0")}--${satelliteType}.md`;
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

  if (satelliteType === "context" && state.latestContext && state.latestContext.filePath !== filePath) {
    if (dependencies.fileSystem.exists(state.latestContext.filePath)) {
      dependencies.fileSystem.unlink(state.latestContext.filePath);
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

function buildTemplateVars(
  fileSystem: FileSystem,
  state: ReturnType<typeof readMigrationState>,
  projectRoot: string,
): TemplateVars {
  const latestMigration = state.migrations[state.migrations.length - 1] ?? null;
  const latestContext = state.latestContext;
  const latestBacklog = state.latestBacklog;
  const latestSnapshot = getLatestSatellitePath(state, "snapshot");

  const design = resolveDesignContext(fileSystem, projectRoot).design;
  const revisionDiff = prepareDesignRevisionDiffContext(fileSystem, projectRoot, { target: "current" });
  const previousRevisionId = revisionDiff.fromRevision?.name ?? "";
  const currentRevisionId = revisionDiff.toTarget.name;
  const revisionDiffFiles = revisionDiff.changes.map((change) => {
    return "- " + change.kind + ": " + change.relativePath;
  }).join("\n");
  const revisionDiffSourceRefs = revisionDiff.sourceReferences.map((sourcePath) => "- " + sourcePath).join("\n");

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
    latestContext: latestContext ? fileSystem.readText(latestContext.filePath) : "",
    latestMigration: latestMigration ? fileSystem.readText(latestMigration.filePath) : "",
    latestBacklog: latestBacklog ? fileSystem.readText(latestBacklog.filePath) : "",
    latestSnapshot: latestSnapshot ? fileSystem.readText(latestSnapshot) : "",
    migrationHistory: historyLines.join("\n"),
    currentRevisionId,
    previousRevisionId,
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
    position: state.currentPosition,
  };
}

function getLatestSatellitePath(
  state: ReturnType<typeof readMigrationState>,
  type: SatelliteType,
): string | null {
  for (let index = state.migrations.length - 1; index >= 0; index -= 1) {
    const migration = state.migrations[index];
    if (!migration) {
      continue;
    }

    for (const satellite of migration.satellites) {
      if (satellite.type === type) {
        return satellite.filePath;
      }
    }
  }

  return null;
}

function createMigrationDocument(
  number: string,
  selected: MigrationProposal,
  proposalsOutput: string,
): string {
  return [
    `# ${number} ${selected.name}`,
    "",
    selected.label,
    "",
    "- [ ] Implement this migration",
    "",
    "## Proposal output",
    "",
    proposalsOutput.trim(),
    "",
  ].join("\n");
}

function parseProposals(stdout: string): MigrationProposal[] {
  const lines = stdout.split(/\r?\n/);
  const proposals: MigrationProposal[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*\d+\.\s*`?([a-z0-9][a-z0-9-]*)`?(?:\s*-\s*(.+))?\s*$/i);
    if (!match) {
      continue;
    }

    proposals.push({
      name: toKebabCase(match[1] ?? "migration"),
      label: line.trim(),
    });
  }

  if (proposals.length > 0) {
    return proposals;
  }

  const fallbackName = toKebabCase(stdout.split(/\r?\n/)[0] ?? "migration");
  return [{ name: fallbackName, label: fallbackName }];
}

async function selectProposal(
  interactiveInput: InteractiveInputPort,
  proposals: MigrationProposal[],
): Promise<MigrationProposal> {
  if (!interactiveInput.isTTY()) {
    return proposals[0]!;
  }

  const promptResult = await interactiveInput.prompt({
    kind: "select",
    message: "Choose the next migration",
    choices: proposals.map((proposal, index) => ({
      value: String(index),
      label: proposal.label,
      isDefault: index === 0,
    })),
    defaultValue: "0",
  });

  const index = Number.parseInt(promptResult.value, 10);
  if (!Number.isInteger(index) || index < 0 || index >= proposals.length) {
    return proposals[0]!;
  }

  return proposals[index]!;
}

function readMigrationState(fileSystem: FileSystem, migrationsDir: string) {
  const files = fileSystem.readdir(migrationsDir)
    .filter((entry) => entry.isFile)
    .map((entry) => path.join(migrationsDir, entry.name));
  return parseMigrationDirectory(files, migrationsDir);
}

function toKebabCase(value: string): string {
  const trimmed = value.trim().toLowerCase();
  const kebab = trimmed
    .replace(/[`'".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return kebab.length > 0 ? kebab : "migration";
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
    || value === "down"
    || value === "save"
    || value === "snapshot"
    || value === "backlog"
    || value === "context"
    || value === "review"
    || value === "user-experience"
    || value === "user-session";
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
