import path from "node:path";
import {
  DEFAULT_MIGRATE_TEMPLATE,
} from "../domain/defaults.js";
import {
  formatMigrationFilename,
  parseMigrationDirectory,
  parseMigrationFilename,
} from "../domain/migration-parser.js";
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
  discoverDesignRevisionDirectories,
  findLowestUnplannedRevision,
  formatDesignRevisionUnifiedDiff,
  formatRevisionDesignContext,
  markRevisionPlanned,
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

export interface MigrateTaskOptions {
  action?: string;
  dir?: string;
  workspace?: string;
  confirm?: boolean;
  workerPattern: ParsedWorkerPattern;
  slugWorkerPattern?: ParsedWorkerPattern;
  keepArtifacts?: boolean;
  showAgentOutput?: boolean;
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

    try {
      const exitCode = await runMigrateLoop({
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

function isDirectory(fileSystem: FileSystem, absolutePath: string): boolean {
  const stat = fileSystem.stat(absolutePath);
  return stat?.isDirectory === true;
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
    const createdMigrationFileNames: string[] = [];
    for (const [index, migrationName] of plannedNames.entries()) {
      const number = stateBeforeCreate.currentPosition + index + 1;
      const migrationFileName = formatMigrationFilename(number, migrationName);
      const migrationPath = path.join(migrationsDir, migrationFileName);
      const migrationContent = createMigrationDocument(number, migrationName);
      dependencies.fileSystem.writeText(migrationPath, migrationContent);
      createdMigrationFileNames.push(migrationFileName);

      await runExploreForMigration({
        runExplore: dependencies.runExplore,
        migrationPath,
        projectRoot,
        emit,
      });
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
        return EXIT_CODE_SUCCESS;
      }
    }

    markRevisionPlanned(
      dependencies.fileSystem,
      workspaceRoot,
      targetRevision.name,
      createdMigrationFileNames,
    );
  }
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

export function isMigrationLikeFileName(fileName: string): boolean {
  return parseMigrationFilename(fileName) !== null;
}
