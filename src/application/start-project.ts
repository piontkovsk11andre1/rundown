import path from "node:path";
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
import {
  DEFAULT_WORKSPACE_DIRECTORIES,
  DEFAULT_WORKSPACE_PLACEMENT,
  WORKSPACE_PLACEMENTS,
  normalizeWorkspaceLogicalPath,
  resolveWorkspaceMountPath,
  resolveWorkspaceMounts,
  type WorkspacePlacement,
} from "./workspace-paths.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type {
  FileSystem,
  GitClient,
  PathOperationsPort,
  WorkingDirectoryPort,
} from "../domain/ports/index.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type { AutoCompactCommandOptions } from "./post-command-auto-compact.js";

export interface StartProjectOptions {
  description?: string;
  dir?: string;
  mounts?: string[];
  designDir?: string;
  specsDir?: string;
  migrationsDir?: string;
  designPlacement?: string;
  specsPlacement?: string;
  migrationsPlacement?: string;
  fromDesign?: string;
  migrateSourceMode?: "design" | "implementation" | "prediction";
  migrateWorkerPattern?: ParsedWorkerPattern;
  migrateKeepArtifacts?: boolean;
  migrateShowAgentOutput?: boolean;
  migrateConfirm?: boolean;
  migrateAutoCompact?: AutoCompactCommandOptions;
}

interface ValidatedWorkspaceDirectories {
  designDir: string;
  implementationDir: string;
  specsDir: string;
  migrationsDir: string;
  predictionDir: string;
}

interface ValidatedWorkspacePlacement {
  designPlacement: WorkspacePlacement;
  implementationPlacement: WorkspacePlacement;
  specsPlacement: WorkspacePlacement;
  migrationsPlacement: WorkspacePlacement;
  predictionPlacement: WorkspacePlacement;
}

interface RundownConfigDocument {
  workspace?: {
    directories?: {
      design: string;
      implementation: string;
      specs: string;
      migrations: string;
      prediction: string;
    };
    placement?: {
      design: WorkspacePlacement;
      implementation: WorkspacePlacement;
      specs: WorkspacePlacement;
      migrations: WorkspacePlacement;
      prediction: WorkspacePlacement;
    };
    design?: {
      currentPath?: string;
    };
    mounts?: Record<string, string>;
  };
  [key: string]: unknown;
}

export interface StartProjectDependencies {
  fileSystem: FileSystem;
  gitClient: GitClient;
  output: ApplicationOutputPort;
  pathOperations: PathOperationsPort;
  runExplore: (source: string, cwd: string) => Promise<number>;
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
    const dirOption = options.dir?.trim();
    const hasExplicitWorkspaceDir = typeof dirOption === "string" && dirOption.length > 0;
    const targetDirectory = dirOption
      ? dependencies.pathOperations.resolve(dirOption)
      : invocationDirectory;
    const targetDirectoryStat = dependencies.fileSystem.stat(targetDirectory);
    if (targetDirectoryStat && targetDirectoryStat.isDirectory !== true) {
      emit({
        kind: "error",
        message: `Invalid start directory: expected a directory path, but found a file: ${targetDirectory}.`,
      });
      return EXIT_CODE_FAILURE;
    }
    if (!dependencies.fileSystem.exists(targetDirectory)) {
      dependencies.fileSystem.mkdir(targetDirectory, { recursive: true });
      emit({ kind: "success", message: "Created project directory: " + targetDirectory });
    }

    let workspaceDirectories: ValidatedWorkspaceDirectories;
    let workspacePlacement: ValidatedWorkspacePlacement;
    let externalDesignCurrentPath: string | undefined;
    let normalizedMounts: Record<string, string> | undefined;
    try {
      validateUnsupportedStartFlagCombinations({
        mounts: options.mounts,
        designDirOption: options.designDir,
        specsDirOption: options.specsDir,
        migrationsDirOption: options.migrationsDir,
        designPlacementOption: options.designPlacement,
        specsPlacementOption: options.specsPlacement,
        migrationsPlacementOption: options.migrationsPlacement,
        fromDesignOption: options.fromDesign,
      });
      workspaceDirectories = resolveAndValidateWorkspaceDirectories({
        targetDirectory,
        designDirOption: options.designDir,
        specsDirOption: options.specsDir,
        migrationsDirOption: options.migrationsDir,
        pathOperations: dependencies.pathOperations,
      });
      workspacePlacement = resolveAndValidateWorkspacePlacement({
        designPlacementOption: options.designPlacement,
        specsPlacementOption: options.specsPlacement,
        migrationsPlacementOption: options.migrationsPlacement,
      });
      externalDesignCurrentPath = resolveAndValidateFromDesign({
        fromDesignOption: options.fromDesign,
        invocationDirectory,
        fileSystem: dependencies.fileSystem,
        pathOperations: dependencies.pathOperations,
      });
      normalizedMounts = resolveAndNormalizeCliMounts({
        mounts: options.mounts,
        invocationDirectory,
        pathOperations: dependencies.pathOperations,
      });
    } catch (error) {
      emit({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      return EXIT_CODE_FAILURE;
    }

    if (!hasExplicitWorkspaceDir && isDirectoryNonEmpty(dependencies.fileSystem, targetDirectory)) {
      emit({
        kind: "error",
        message: [
          `Cannot bootstrap rundown in-place inside non-empty directory: ${targetDirectory}.`,
          "Use an explicit outer workdir to keep existing files in place.",
          "Example: rundown start . ..\\myproject-rundown",
        ].join(" "),
      });
      return EXIT_CODE_FAILURE;
    }

    const rundownConfigDir = dependencies.pathOperations.join(targetDirectory, ".rundown");
    const rundownConfigPath = dependencies.pathOperations.join(rundownConfigDir, "config.json");
    await initGitRepo(dependencies.gitClient, targetDirectory);

    const initProject = createInitProject({
      fileSystem: dependencies.fileSystem,
      configDir: {
        configDir: rundownConfigDir,
        isExplicit: true,
      },
      pathOperations: dependencies.pathOperations,
      output: dependencies.output,
      localeMessages: {},
    });
    const initCode = await initProject();
    if (initCode !== EXIT_CODE_SUCCESS) {
      return initCode;
    }

    try {
      persistWorkspaceConfiguration({
        fileSystem: dependencies.fileSystem,
        configPath: rundownConfigPath,
        directories: workspaceDirectories,
        placement: workspacePlacement,
        designCurrentPath: externalDesignCurrentPath,
        mounts: normalizedMounts,
      });
      emit({
        kind: "success",
        message: "Persisted workspace directories and placement in " + rundownConfigPath,
      });
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

    const workspaceMounts = resolveWorkspaceMounts({
      fileSystem: dependencies.fileSystem,
      workspaceRoot: targetDirectory,
      invocationRoot: invocationDirectory,
    });
    const configuredExternalDesignCurrentPath = resolveConfiguredExternalDesignCurrentPath({
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
      configPath: rundownConfigPath,
      localDesignCurrentDir: dependencies.pathOperations.join(
        targetDirectory,
        workspaceDirectories.designDir,
        "current",
      ),
    });
    const activeExternalDesignCurrentPath = externalDesignCurrentPath
      ?? configuredExternalDesignCurrentPath;
    const designCurrentDir = resolveWorkspaceMountPath({
      mounts: workspaceMounts,
      logicalPath: "design/current",
    }).absolutePath;
    const designPath = dependencies.pathOperations.join(designCurrentDir, "Target.md");
    const designCurrentIsLocal = isTargetWorkspaceLocalPath({
      pathOperations: dependencies.pathOperations,
      targetDirectory,
      absolutePath: designCurrentDir,
    });

    if (activeExternalDesignCurrentPath) {
      emit({
        kind: "success",
        message: "Using external directory as design/current: " + activeExternalDesignCurrentPath,
      });
    } else if (!designCurrentIsLocal) {
      emit({
        kind: "info",
        message: "Skipping local design/current scaffold for external path: " + designCurrentDir,
      });
    } else {
      if (!dependencies.fileSystem.exists(designCurrentDir)) {
        dependencies.fileSystem.mkdir(designCurrentDir, { recursive: true });
        emit({ kind: "success", message: "Created " + designCurrentDir + "/" });
      }

      writeFileIfMissing(
        dependencies.fileSystem,
        designPath,
        "",
        emit,
      );
    }

    createLocalWorkspaceBucketDirectory({
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
      targetDirectory,
      mounts: workspaceMounts,
      logicalPath: "migrations",
      emit,
    });

    createLocalWorkspaceBucketDirectory({
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
      targetDirectory,
      mounts: workspaceMounts,
      logicalPath: "implementation",
      emit,
    });

    createLocalWorkspaceBucketDirectory({
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
      targetDirectory,
      mounts: workspaceMounts,
      logicalPath: "specs",
      emit,
    });

    createLocalWorkspaceBucketDirectory({
      fileSystem: dependencies.fileSystem,
      pathOperations: dependencies.pathOperations,
      targetDirectory,
      mounts: workspaceMounts,
      logicalPath: "prediction",
      emit,
    });

    try {
      await dependencies.gitClient.run(["add", "-A", "--", "."], targetDirectory);
      await dependencies.gitClient.run(["commit", "-m", "rundown: start project"], targetDirectory);
      emit({ kind: "success", message: "Committed scaffold: rundown: start project" });
    } catch (error) {
      if (isNoOpCommitError(error)) {
        emit({ kind: "info", message: "No scaffold changes detected; skipping commit." });
      } else {
        emit({
          kind: "error",
          message: "Failed to create scaffold commit: " + String(error),
        });
        return EXIT_CODE_FAILURE;
      }
    }

    return EXIT_CODE_SUCCESS;
  };
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
  const parentDirectory = path.dirname(filePath);
  if (!fileSystem.exists(parentDirectory)) {
    fileSystem.mkdir(parentDirectory, { recursive: true });
  }

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
): boolean {
  if (fileSystem.exists(filePath)) {
    emit({ kind: "warn", message: filePath + " already exists, skipping." });
    return false;
  }

  fileSystem.writeText(filePath, content);
  emit({ kind: "success", message: "Created " + filePath });
  return true;
}

function isNoOpCommitError(error: unknown): boolean {
  const message = String(error).toLowerCase();
  return message.includes("nothing to commit") || message.includes("nothing added to commit");
}

function isDirectoryNonEmpty(fileSystem: FileSystem, directoryPath: string): boolean {
  if (!fileSystem.exists(directoryPath)) {
    return false;
  }

  const stat = fileSystem.stat(directoryPath);
  if (stat?.isDirectory !== true) {
    return false;
  }

  const ignorableBootstrapEntries = new Set([".git", ".rundown"]);
  return fileSystem
    .readdir(directoryPath)
      .some((entry) => !ignorableBootstrapEntries.has(entry.name));
}

function resolveAndValidateWorkspaceDirectories(input: {
  targetDirectory: string;
  designDirOption: string | undefined;
  specsDirOption: string | undefined;
  migrationsDirOption: string | undefined;
  pathOperations: PathOperationsPort;
}): ValidatedWorkspaceDirectories {
  const {
    targetDirectory,
    designDirOption,
    specsDirOption,
    migrationsDirOption,
    pathOperations,
  } = input;
  const defaults = {
    designDir: DEFAULT_WORKSPACE_DIRECTORIES.design,
    implementationDir: DEFAULT_WORKSPACE_DIRECTORIES.implementation,
    specsDir: DEFAULT_WORKSPACE_DIRECTORIES.specs,
    migrationsDir: DEFAULT_WORKSPACE_DIRECTORIES.migrations,
    predictionDir: DEFAULT_WORKSPACE_DIRECTORIES.prediction,
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
  const implementationDir = normalizeWorkspaceDirectoryOverride(
    targetDirectory,
    defaults.implementationDir,
    "implementation directory default",
    pathOperations,
  );
  const migrationsDir = normalizeWorkspaceDirectoryOverride(
    targetDirectory,
    migrationsDirOption ?? defaults.migrationsDir,
    "--migrations-dir",
    pathOperations,
  );
  const predictionDir = normalizeWorkspaceDirectoryOverride(
    targetDirectory,
    defaults.predictionDir,
    "prediction directory default",
    pathOperations,
  );

  const buckets: Array<{ optionName: string; relativeDir: string }> = [
    { optionName: "--design-dir", relativeDir: designDir },
    { optionName: "implementation directory default", relativeDir: implementationDir },
    { optionName: "--specs-dir", relativeDir: specsDir },
    { optionName: "--migrations-dir", relativeDir: migrationsDir },
    { optionName: "prediction directory default", relativeDir: predictionDir },
  ];

  validateWorkspaceDirectoryConflicts(buckets);

  return {
    designDir,
    implementationDir,
    specsDir,
    migrationsDir,
    predictionDir,
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

function resolveAndValidateFromDesign(input: {
  fromDesignOption: string | undefined;
  invocationDirectory: string;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
}): string | undefined {
  const { fromDesignOption, invocationDirectory, fileSystem, pathOperations } = input;
  const trimmed = fromDesignOption?.trim();
  if (!trimmed || trimmed.length === 0) {
    return undefined;
  }

  const resolved = pathOperations.isAbsolute(trimmed)
    ? pathOperations.resolve(trimmed)
    : pathOperations.resolve(invocationDirectory, trimmed);

  if (!fileSystem.exists(resolved)) {
    fileSystem.mkdir(resolved, { recursive: true });
    return resolved;
  }
  const resolvedStat = fileSystem.stat(resolved);
  if (resolvedStat?.isDirectory !== true) {
    throw new Error(
      `Invalid --from-design value: expected a directory path, but found a file: ${resolved}.`,
    );
  }
  return resolved;
}

function resolveAndValidateWorkspacePlacement(input: {
  designPlacementOption: string | undefined;
  specsPlacementOption: string | undefined;
  migrationsPlacementOption: string | undefined;
}): ValidatedWorkspacePlacement {
  const designPlacement = normalizeWorkspacePlacementOverride(
    input.designPlacementOption ?? DEFAULT_WORKSPACE_PLACEMENT.design,
    "--design-placement",
  );
  const specsPlacement = normalizeWorkspacePlacementOverride(
    input.specsPlacementOption ?? DEFAULT_WORKSPACE_PLACEMENT.specs,
    "--specs-placement",
  );
  const implementationPlacement = normalizeWorkspacePlacementOverride(
    DEFAULT_WORKSPACE_PLACEMENT.implementation,
    "implementation placement default",
  );
  const migrationsPlacement = normalizeWorkspacePlacementOverride(
    input.migrationsPlacementOption ?? DEFAULT_WORKSPACE_PLACEMENT.migrations,
    "--migrations-placement",
  );
  const predictionPlacement = normalizeWorkspacePlacementOverride(
    DEFAULT_WORKSPACE_PLACEMENT.prediction,
    "prediction placement default",
  );

  return {
    designPlacement,
    implementationPlacement,
    specsPlacement,
    migrationsPlacement,
    predictionPlacement,
  };
}

function normalizeWorkspacePlacementOverride(
  rawValue: string,
  optionName: string,
): WorkspacePlacement {
  const trimmedValue = rawValue.trim();
  if (trimmedValue.length === 0) {
    throw new Error(`Invalid ${optionName} value: placement cannot be empty.`);
  }

  if (!WORKSPACE_PLACEMENTS.includes(trimmedValue as WorkspacePlacement)) {
    throw new Error(
      `Invalid ${optionName} value: "${trimmedValue}". Allowed values: ${WORKSPACE_PLACEMENTS.join(", ")}.`,
    );
  }

  return trimmedValue as WorkspacePlacement;
}

function persistWorkspaceConfiguration(input: {
  fileSystem: FileSystem;
  configPath: string;
  directories: ValidatedWorkspaceDirectories;
  placement: ValidatedWorkspacePlacement;
  designCurrentPath?: string;
  mounts?: Record<string, string>;
}): void {
  const { fileSystem, configPath, directories, placement, designCurrentPath, mounts } = input;
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

  const existingWorkspace = isPlainObject(parsed.workspace) ? parsed.workspace : {};
  const existingDesignSection = isPlainObject(existingWorkspace.design) ? existingWorkspace.design : {};

  const config: RundownConfigDocument = {
    ...parsed,
    workspace: {
      ...existingWorkspace,
      directories: {
        design: directories.designDir,
        implementation: directories.implementationDir,
        specs: directories.specsDir,
        migrations: directories.migrationsDir,
        prediction: directories.predictionDir,
      },
      placement: {
        design: placement.designPlacement,
        implementation: placement.implementationPlacement,
        specs: placement.specsPlacement,
        migrations: placement.migrationsPlacement,
        prediction: placement.predictionPlacement,
      },
      design: {
        ...existingDesignSection,
        ...(designCurrentPath ? { currentPath: designCurrentPath } : {}),
      },
      ...(mounts ? { mounts } : {}),
    },
  };

  // Drop empty design section to keep config tidy when no override is set.
  if (
    config.workspace?.design
    && Object.keys(config.workspace.design).length === 0
  ) {
    delete config.workspace.design;
  }

  fileSystem.writeText(configPath, JSON.stringify(config, null, 2) + "\n");
}

function resolveAndNormalizeCliMounts(input: {
  mounts: string[] | undefined;
  invocationDirectory: string;
  pathOperations: PathOperationsPort;
}): Record<string, string> | undefined {
  const { mounts, invocationDirectory, pathOperations } = input;
  if (!mounts || mounts.length === 0) {
    return undefined;
  }

  const normalized: Record<string, string> = {};
  for (const rawMount of mounts) {
    const parsed = parseCliMountDeclaration(rawMount);
    const logicalPath = normalizeCliMountLogicalPath(parsed.logicalPath);
    if (normalized[logicalPath]) {
      throw new Error(
        `Invalid --mount declarations: logical path "${logicalPath}" was provided more than once.`,
      );
    }

    const absoluteTargetPath = pathOperations.isAbsolute(parsed.targetPath)
      ? pathOperations.resolve(parsed.targetPath)
      : pathOperations.resolve(invocationDirectory, parsed.targetPath);
    normalized[logicalPath] = absoluteTargetPath;
  }

  return normalized;
}

function normalizeCliMountLogicalPath(rawLogicalPath: string): string {
  try {
    return normalizeWorkspaceLogicalPath(rawLogicalPath);
  } catch (error) {
    throw new Error(
      `Invalid --mount logical path: "${rawLogicalPath}". ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateUnsupportedStartFlagCombinations(input: {
  mounts: string[] | undefined;
  designDirOption: string | undefined;
  specsDirOption: string | undefined;
  migrationsDirOption: string | undefined;
  designPlacementOption: string | undefined;
  specsPlacementOption: string | undefined;
  migrationsPlacementOption: string | undefined;
  fromDesignOption: string | undefined;
}): void {
  const {
    mounts,
    designDirOption,
    specsDirOption,
    migrationsDirOption,
    designPlacementOption,
    specsPlacementOption,
    migrationsPlacementOption,
    fromDesignOption,
  } = input;
  if (!mounts || mounts.length === 0) {
    return;
  }

  const conflicts: string[] = [];
  if (designDirOption !== undefined) {
    conflicts.push("--design-dir");
  }
  if (specsDirOption !== undefined) {
    conflicts.push("--specs-dir");
  }
  if (migrationsDirOption !== undefined) {
    conflicts.push("--migrations-dir");
  }
  if (designPlacementOption !== undefined) {
    conflicts.push("--design-placement");
  }
  if (specsPlacementOption !== undefined) {
    conflicts.push("--specs-placement");
  }
  if (migrationsPlacementOption !== undefined) {
    conflicts.push("--migrations-placement");
  }
  if (fromDesignOption !== undefined) {
    conflicts.push("--from-design");
  }

  if (conflicts.length === 0) {
    return;
  }

  throw new Error(
    `Unsupported start option combination: --mount cannot be combined with ${conflicts.join(", ")}. Use --mount declarations only for mounted bootstrap, or remove --mount to use legacy directory/placement flags.`,
  );
}

function parseCliMountDeclaration(rawMount: string): { logicalPath: string; targetPath: string } {
  const trimmed = rawMount.trim();
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex <= 0 || separatorIndex === trimmed.length - 1) {
    throw new Error(
      `Invalid --mount value: "${rawMount}". Expected <logical-path=target-path>.`,
    );
  }

  const logicalPath = trimmed.slice(0, separatorIndex).trim();
  const targetPath = trimmed.slice(separatorIndex + 1).trim();
  if (logicalPath.length === 0 || targetPath.length === 0) {
    throw new Error(
      `Invalid --mount value: "${rawMount}". Expected <logical-path=target-path>.`,
    );
  }

  return { logicalPath, targetPath };
}

function resolveConfiguredExternalDesignCurrentPath(input: {
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  configPath: string;
  localDesignCurrentDir: string;
}): string | undefined {
  const {
    fileSystem,
    pathOperations,
    configPath,
    localDesignCurrentDir,
  } = input;
  if (!fileSystem.exists(configPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fileSystem.readText(configPath));
  } catch {
    return undefined;
  }

  if (!isPlainObject(parsed)) {
    return undefined;
  }

  const workspace = isPlainObject(parsed.workspace) ? parsed.workspace : undefined;
  const design = workspace && isPlainObject(workspace.design) ? workspace.design : undefined;
  const configuredPath = typeof design?.currentPath === "string"
    ? design.currentPath.trim()
    : "";
  if (configuredPath.length === 0) {
    return undefined;
  }

  const resolvedPath = pathOperations.isAbsolute(configuredPath)
    ? pathOperations.resolve(configuredPath)
    : pathOperations.resolve(pathOperations.dirname(configPath), configuredPath);
  const normalizedResolvedPath = pathOperations.resolve(resolvedPath);
  const normalizedLocalDesignCurrentDir = pathOperations.resolve(localDesignCurrentDir);
  if (normalizedResolvedPath === normalizedLocalDesignCurrentDir) {
    return undefined;
  }

  if (!fileSystem.exists(normalizedResolvedPath)) {
    return undefined;
  }

  if (fileSystem.stat(normalizedResolvedPath)?.isDirectory !== true) {
    return undefined;
  }

  return normalizedResolvedPath;
}

function createLocalWorkspaceBucketDirectory(input: {
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  targetDirectory: string;
  mounts: ReturnType<typeof resolveWorkspaceMounts>;
  logicalPath: "migrations" | "implementation" | "specs" | "prediction";
  emit: ApplicationOutputPort["emit"];
}): void {
  const { fileSystem, pathOperations, targetDirectory, mounts, logicalPath, emit } = input;
  const bucketDirectory = resolveWorkspaceMountPath({ mounts, logicalPath }).absolutePath;
  const isLocal = isTargetWorkspaceLocalPath({
    pathOperations,
    targetDirectory,
    absolutePath: bucketDirectory,
  });
  if (!isLocal) {
    emit({
      kind: "info",
      message: `Skipping local ${logicalPath}/ scaffold for external path: ${bucketDirectory}`,
    });
    return;
  }

  if (!fileSystem.exists(bucketDirectory)) {
    fileSystem.mkdir(bucketDirectory, { recursive: true });
    emit({ kind: "success", message: "Created " + bucketDirectory + "/" });
  }
}

function isTargetWorkspaceLocalPath(input: {
  pathOperations: PathOperationsPort;
  targetDirectory: string;
  absolutePath: string;
}): boolean {
  const { pathOperations, targetDirectory, absolutePath } = input;
  const normalizedTargetDirectory = pathOperations.resolve(targetDirectory);
  const normalizedAbsolutePath = pathOperations.resolve(absolutePath);
  const relativePath = pathOperations
    .relative(normalizedTargetDirectory, normalizedAbsolutePath)
    .replace(/\\/g, "/");

  if (relativePath.length === 0 || relativePath === ".") {
    return true;
  }
  if (relativePath === ".." || relativePath.startsWith("../")) {
    return false;
  }

  return !pathOperations.isAbsolute(relativePath);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
