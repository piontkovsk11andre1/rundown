import { createInitProject } from "./init-project.js";
import { initGitRepo } from "./git-operations.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import {
  parseWorkspaceLinkSchema,
  serializeWorkspaceLinkSchema,
} from "../domain/workspace-link.js";
import { DEFAULT_PREDICTION_WORKSPACE_DIRECTORIES } from "./prediction-workspace-paths.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type {
  FileSystem,
  GitClient,
  PathOperationsPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";

export interface StartProjectOptions {
  description?: string;
  dir?: string;
  designDir?: string;
  specsDir?: string;
  migrationsDir?: string;
}

interface ValidatedWorkspaceDirectories {
  designDir: string;
  specsDir: string;
  migrationsDir: string;
}

interface RundownConfigDocument {
  workspace?: {
    directories?: {
      design: string;
      specs: string;
      migrations: string;
    };
  };
  [key: string]: unknown;
}

export interface StartProjectDependencies {
  fileSystem: FileSystem;
  gitClient: GitClient;
  output: ApplicationOutputPort;
  pathOperations: PathOperationsPort;
  runExplore?: (source: string, cwd: string) => Promise<number>;
  workingDirectory: WorkingDirectoryPort;
}

/**
 * Creates the start-project use case.
 *
 * This flow ensures the target directory is inside a Git repository by
 * initializing one when needed.
 */
export function createStartProject(
  dependencies: StartProjectDependencies,
): (options?: StartProjectOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function startProject(options: StartProjectOptions = {}): Promise<number> {
    const invocationDirectory = dependencies.workingDirectory.cwd();
    const description = normalizeDescription(options.description);
    const dirOption = options.dir?.trim();
    const targetDirectory = dirOption
      ? dependencies.pathOperations.resolve(dirOption)
      : invocationDirectory;

    if (!dependencies.fileSystem.exists(targetDirectory)) {
      dependencies.fileSystem.mkdir(targetDirectory, { recursive: true });
      emit({ kind: "success", message: "Created project directory: " + targetDirectory });
    }

    let workspaceDirectories: ValidatedWorkspaceDirectories;
    try {
      workspaceDirectories = resolveAndValidateWorkspaceDirectories({
        targetDirectory,
        designDirOption: options.designDir,
        specsDirOption: options.specsDir,
        migrationsDirOption: options.migrationsDir,
        pathOperations: dependencies.pathOperations,
      });
    } catch (error) {
      emit({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return EXIT_CODE_FAILURE;
    }

    const designCurrentDir = dependencies.pathOperations.join(
      targetDirectory,
      workspaceDirectories.designDir,
      "current",
    );
    const designPath = dependencies.pathOperations.join(designCurrentDir, "Target.md");
    const agentsPath = dependencies.pathOperations.join(targetDirectory, "AGENTS.md");
    const rundownConfigDir = dependencies.pathOperations.join(targetDirectory, ".rundown");
    const rundownConfigPath = dependencies.pathOperations.join(rundownConfigDir, "config.json");
    const migrationsDir = dependencies.pathOperations.join(
      targetDirectory,
      workspaceDirectories.migrationsDir,
    );
    const specsDir = dependencies.pathOperations.join(
      targetDirectory,
      workspaceDirectories.specsDir,
    );
    const initialMigrationPath = dependencies.pathOperations.join(
      migrationsDir,
      "0001-initialize.md",
    );

    await initGitRepo(dependencies.gitClient, targetDirectory);

    const initProject = createInitProject({
      fileSystem: dependencies.fileSystem,
      configDir: {
        configDir: rundownConfigDir,
        isExplicit: true,
      },
      pathOperations: dependencies.pathOperations,
      output: dependencies.output,
    });
    const initCode = await initProject();
    if (initCode !== EXIT_CODE_SUCCESS) {
      return initCode;
    }

    try {
      persistWorkspaceDirectoryMapping({
        fileSystem: dependencies.fileSystem,
        configPath: rundownConfigPath,
        directories: workspaceDirectories,
      });
      emit({ kind: "success", message: "Persisted workspace directories in " + rundownConfigPath });
    } catch (error) {
      emit({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return EXIT_CODE_FAILURE;
    }

    persistWorkspaceLinkMetadata({
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
      invocationDirectory,
      targetDirectory,
      emit,
    });

    if (!dependencies.fileSystem.exists(designCurrentDir)) {
      dependencies.fileSystem.mkdir(designCurrentDir, { recursive: true });
      emit({ kind: "success", message: "Created " + designCurrentDir + "/" });
    }

    writeFileIfMissing(dependencies.fileSystem, designPath, buildDesignMarkdown(description), emit);
    writeFileIfMissing(dependencies.fileSystem, agentsPath, DEFAULT_AGENTS_TEMPLATE, emit);

    if (!dependencies.fileSystem.exists(migrationsDir)) {
      dependencies.fileSystem.mkdir(migrationsDir, { recursive: true });
      emit({ kind: "success", message: "Created " + migrationsDir + "/" });
    }

    if (!dependencies.fileSystem.exists(specsDir)) {
      dependencies.fileSystem.mkdir(specsDir, { recursive: true });
      emit({ kind: "success", message: "Created " + specsDir + "/" });
    }

    writeFileIfMissing(
      dependencies.fileSystem,
      initialMigrationPath,
      buildInitialMigrationMarkdown(description),
      emit,
    );

    const exploreExitCode = await runExploreSteps(
      dependencies.runExplore,
      targetDirectory,
      [designPath, initialMigrationPath],
      emit,
    );
    if (exploreExitCode !== EXIT_CODE_SUCCESS) {
      return exploreExitCode;
    }

    try {
      await dependencies.gitClient.run(["add", "-A", "--", "."], targetDirectory);
      await dependencies.gitClient.run(["commit", "-m", "rundown: start project"], targetDirectory);
      emit({ kind: "success", message: "Committed scaffold: rundown: start project" });
    } catch (error) {
      emit({
        kind: "error",
        message: "Failed to create scaffold commit: " + String(error),
      });
      return EXIT_CODE_FAILURE;
    }

    return EXIT_CODE_SUCCESS;
  };
}

const DEFAULT_AGENTS_TEMPLATE = [
  "# AGENTS",
  "",
  "Define project-specific agent roles and responsibilities.",
  "",
  "## Planner",
  "- Owns migration sequencing and trade-off analysis.",
  "",
  "## Builder",
  "- Implements migration tasks and keeps changes cohesive.",
  "",
  "## Verifier",
  "- Validates outcomes against specs and migration intent.",
  "",
].join("\n");

function normalizeDescription(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0
    ? normalized
    : "New prediction project";
}

function buildDesignMarkdown(description: string): string {
  return "# " + description + "\n\n" + description + "\n";
}

function buildInitialMigrationMarkdown(description: string): string {
  return [
    "# 0001 initialize",
    "",
    "Seed migration generated from project description:",
    "",
    "> " + description,
    "",
    "- [ ] Document initial architecture assumptions",
    "- [ ] Establish baseline project structure",
    "- [ ] Capture first validation checkpoints",
    "",
  ].join("\n");
}

function buildWorkspaceLinkTarget(
  pathOperations: PathOperationsPort,
  fromDirectory: string,
  toDirectory: string,
): string {
  const relativeTarget = pathOperations.relative(fromDirectory, toDirectory);
  const normalizedTarget = relativeTarget.length > 0
    ? relativeTarget
    : ".";
  return normalizedTarget.replace(/\\/g, "/");
}

function persistWorkspaceLinkMetadata(input: {
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  invocationDirectory: string;
  targetDirectory: string;
  emit: ApplicationOutputPort["emit"];
}): void {
  const {
    fileSystem,
    pathOperations,
    invocationDirectory,
    targetDirectory,
    emit,
  } = input;

  const normalizedInvocationDirectory = pathOperations.resolve(invocationDirectory);
  const normalizedTargetDirectory = pathOperations.resolve(targetDirectory);
  const targetWorkspaceLinkPath = pathOperations.join(normalizedTargetDirectory, ".rundown", "workspace.link");

  writeFileIfChanged(
    fileSystem,
    targetWorkspaceLinkPath,
    serializeWorkspaceLinkSchema({
      sourceFormat: "legacy-single-path",
      records: [{
        id: "source",
        workspacePath: buildWorkspaceLinkTarget(
          pathOperations,
          normalizedTargetDirectory,
          normalizedInvocationDirectory,
        ),
        isDefault: true,
      }],
    }),
    emit,
  );

  if (normalizedInvocationDirectory === normalizedTargetDirectory) {
    return;
  }

  const sourceWorkspaceLinkPath = pathOperations.join(normalizedInvocationDirectory, ".rundown", "workspace.link");
  const targetPathFromSource = buildWorkspaceLinkTarget(
    pathOperations,
    normalizedInvocationDirectory,
    normalizedTargetDirectory,
  );
  const sourceWorkspaceLinkContent = buildUpdatedSourceWorkspaceLinkContent({
    fileSystem,
    sourceWorkspaceLinkPath,
    targetPathFromSource,
  });

  writeFileIfChanged(fileSystem, sourceWorkspaceLinkPath, sourceWorkspaceLinkContent, emit);
}

function buildUpdatedSourceWorkspaceLinkContent(input: {
  fileSystem: FileSystem;
  sourceWorkspaceLinkPath: string;
  targetPathFromSource: string;
}): string {
  const { fileSystem, sourceWorkspaceLinkPath, targetPathFromSource } = input;
  const existingContent = fileSystem.exists(sourceWorkspaceLinkPath)
    ? fileSystem.readText(sourceWorkspaceLinkPath)
    : undefined;

  const records: Array<{ id: string; workspacePath: string; isDefault?: boolean }> = [];
  let defaultRecordId: string | undefined;
  const usedRecordIds = new Set<string>();

  if (existingContent !== undefined) {
    const parsed = parseWorkspaceLinkSchema(existingContent);
    if (parsed.status === "ok") {
      for (const record of parsed.schema.records) {
        records.push({
          id: record.id,
          workspacePath: record.workspacePath,
          isDefault: record.isDefault,
        });
        usedRecordIds.add(record.id);
      }
      defaultRecordId = parsed.schema.defaultRecordId;
    }
  }

  const existingRecord = records.find((record) => record.workspacePath === targetPathFromSource);
  if (!existingRecord) {
    const proposedId = toWorkspaceRecordId(targetPathFromSource);
    const recordId = makeUniqueRecordId(proposedId, usedRecordIds);
    usedRecordIds.add(recordId);
    records.push({
      id: recordId,
      workspacePath: targetPathFromSource,
      isDefault: false,
    });
  }

  return serializeWorkspaceLinkSchema({
    records,
    ...(defaultRecordId !== undefined ? { defaultRecordId } : {}),
  });
}

function toWorkspaceRecordId(workspacePath: string): string {
  const segments = workspacePath.split("/").filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
  const raw = (segments[segments.length - 1] ?? "workspace").toLowerCase();
  const sanitized = raw
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");

  if (sanitized.length > 0 && /^[a-z0-9]/.test(sanitized)) {
    return sanitized;
  }

  return "workspace";
}

function makeUniqueRecordId(baseId: string, usedIds: Set<string>): string {
  if (!usedIds.has(baseId)) {
    return baseId;
  }

  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${baseId}-${String(suffix)}`;
    if (!usedIds.has(candidate)) {
      return candidate;
    }
  }

  throw new Error(`Failed to allocate workspace record id for "${baseId}".`);
}

function writeFileIfChanged(
  fileSystem: FileSystem,
  filePath: string,
  content: string,
  emit: ApplicationOutputPort["emit"],
): void {
  if (fileSystem.exists(filePath)) {
    const existingContent = fileSystem.readText(filePath);
    if (existingContent === content) {
      emit({ kind: "info", message: filePath + " already up to date." });
      return;
    }

    fileSystem.writeText(filePath, content);
    emit({ kind: "success", message: "Updated " + filePath });
    return;
  }

  fileSystem.writeText(filePath, content);
  emit({ kind: "success", message: "Created " + filePath });
}

function writeFileIfMissing(
  fileSystem: FileSystem,
  filePath: string,
  content: string,
  emit: ApplicationOutputPort["emit"],
): void {
  if (fileSystem.exists(filePath)) {
    emit({ kind: "warn", message: filePath + " already exists, skipping." });
    return;
  }

  fileSystem.writeText(filePath, content);
  emit({ kind: "success", message: "Created " + filePath });
}

async function runExploreSteps(
  runExplore: StartProjectDependencies["runExplore"],
  cwd: string,
  files: string[],
  emit: ApplicationOutputPort["emit"],
): Promise<number> {
  for (const filePath of files) {
    if (!runExplore) {
      emit({
        kind: "warn",
        message: "Explore integration is not configured; skipping enrichment for " + filePath,
      });
      continue;
    }

    const exploreExitCode = await runExplore(filePath, cwd);
    if (exploreExitCode !== EXIT_CODE_SUCCESS) {
      emit({ kind: "error", message: "Explore failed for " + filePath });
      return exploreExitCode;
    }
  }

  return EXIT_CODE_SUCCESS;
}

function resolveAndValidateWorkspaceDirectories(input: {
  targetDirectory: string;
  designDirOption: string | undefined;
  specsDirOption: string | undefined;
  migrationsDirOption: string | undefined;
  pathOperations: PathOperationsPort;
}): ValidatedWorkspaceDirectories {
  const { targetDirectory, designDirOption, specsDirOption, migrationsDirOption, pathOperations } = input;
  const defaults = {
    designDir: DEFAULT_PREDICTION_WORKSPACE_DIRECTORIES.design,
    specsDir: DEFAULT_PREDICTION_WORKSPACE_DIRECTORIES.specs,
    migrationsDir: DEFAULT_PREDICTION_WORKSPACE_DIRECTORIES.migrations,
  };

  const designDir = normalizeWorkspaceDirectoryOverride(
    targetDirectory,
    designDirOption ?? defaults.designDir,
    "--design-dir",
    pathOperations,
  );
  const specsDir = normalizeWorkspaceDirectoryOverride(
    targetDirectory,
    specsDirOption ?? defaults.specsDir,
    "--specs-dir",
    pathOperations,
  );
  const migrationsDir = normalizeWorkspaceDirectoryOverride(
    targetDirectory,
    migrationsDirOption ?? defaults.migrationsDir,
    "--migrations-dir",
    pathOperations,
  );

  const buckets: Array<{ optionName: string; relativeDir: string }> = [
    { optionName: "--design-dir", relativeDir: designDir },
    { optionName: "--specs-dir", relativeDir: specsDir },
    { optionName: "--migrations-dir", relativeDir: migrationsDir },
  ];

  validateWorkspaceDirectoryConflicts(buckets);

  return {
    designDir,
    specsDir,
    migrationsDir,
  };
}

function normalizeWorkspaceDirectoryOverride(
  targetDirectory: string,
  rawValue: string,
  optionName: string,
  pathOperations: PathOperationsPort,
): string {
  const trimmedValue = rawValue.trim();
  if (trimmedValue.length === 0) {
    throw new Error(`Invalid ${optionName} value: path cannot be empty.`);
  }

  if (pathOperations.isAbsolute(trimmedValue)) {
    throw new Error(
      `Invalid ${optionName} value: "${trimmedValue}". Use a path relative to the project root, not an absolute path.`,
    );
  }

  const resolvedPath = pathOperations.resolve(targetDirectory, trimmedValue);
  const relativeFromProjectRoot = pathOperations
    .relative(targetDirectory, resolvedPath)
    .replace(/\\/g, "/");

  if (relativeFromProjectRoot.length === 0 || relativeFromProjectRoot === ".") {
    throw new Error(`Invalid ${optionName} value: "${trimmedValue}" resolves to the project root.`);
  }

  if (relativeFromProjectRoot === ".." || relativeFromProjectRoot.startsWith("../")) {
    throw new Error(
      `Invalid ${optionName} value: "${trimmedValue}" escapes the project root. Use a subdirectory path.`,
    );
  }

  return relativeFromProjectRoot;
}

function validateWorkspaceDirectoryConflicts(
  directories: Array<{ optionName: string; relativeDir: string }>,
): void {
  for (let index = 0; index < directories.length; index += 1) {
    const current = directories[index];
    if (!current) {
      continue;
    }

    for (let otherIndex = index + 1; otherIndex < directories.length; otherIndex += 1) {
      const other = directories[otherIndex];
      if (!other) {
        continue;
      }

      if (current.relativeDir === other.relativeDir) {
        throw new Error(
          `Invalid workspace directory overrides: ${current.optionName} and ${other.optionName} both resolve to "${current.relativeDir}". Use distinct directories.`,
        );
      }

      if (isAncestorOrDescendantPath(current.relativeDir, other.relativeDir)) {
        throw new Error(
          `Invalid workspace directory overrides: ${current.optionName} ("${current.relativeDir}") and ${other.optionName} ("${other.relativeDir}") overlap. Use separate non-nested directories.`,
        );
      }
    }
  }
}

function isAncestorOrDescendantPath(left: string, right: string): boolean {
  return left.startsWith(right + "/") || right.startsWith(left + "/");
}

function persistWorkspaceDirectoryMapping(input: {
  fileSystem: FileSystem;
  configPath: string;
  directories: ValidatedWorkspaceDirectories;
}): void {
  const { fileSystem, configPath, directories } = input;
  const existingSource = fileSystem.exists(configPath)
    ? fileSystem.readText(configPath)
    : "{}\n";

  let parsed: unknown;
  try {
    parsed = JSON.parse(existingSource);
  } catch (error) {
    throw new Error(
      `Failed to persist workspace directories: cannot parse ${configPath} as JSON (${String(error)}).`,
    );
  }

  if (!isPlainObject(parsed)) {
    throw new Error(
      `Failed to persist workspace directories: expected ${configPath} to contain a top-level JSON object.`,
    );
  }

  const config: RundownConfigDocument = {
    ...parsed,
    workspace: {
      ...(isPlainObject(parsed.workspace) ? parsed.workspace : {}),
      directories: {
        design: directories.designDir,
        specs: directories.specsDir,
        migrations: directories.migrationsDir,
      },
    },
  };

  fileSystem.writeText(configPath, JSON.stringify(config, null, 2) + "\n");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
