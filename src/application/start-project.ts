import { createInitProject } from "./init-project.js";
import { initGitRepo } from "./git-operations.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
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
    const description = normalizeDescription(options.description);
    const dirOption = options.dir?.trim();
    const targetDirectory = dirOption
      ? dependencies.pathOperations.resolve(dirOption)
      : dependencies.workingDirectory.cwd();

    if (!dependencies.fileSystem.exists(targetDirectory)) {
      dependencies.fileSystem.mkdir(targetDirectory, { recursive: true });
      emit({ kind: "success", message: "Created project directory: " + targetDirectory });
    }

    const designPath = dependencies.pathOperations.join(targetDirectory, "Design.md");
    const agentsPath = dependencies.pathOperations.join(targetDirectory, "AGENTS.md");
    const migrationsDir = dependencies.pathOperations.join(targetDirectory, "migrations");
    const specsDir = dependencies.pathOperations.join(targetDirectory, "specs");
    const initialMigrationPath = dependencies.pathOperations.join(
      migrationsDir,
      "0001-initialize.md",
    );

    await initGitRepo(dependencies.gitClient, targetDirectory);

    const initProject = createInitProject({
      fileSystem: dependencies.fileSystem,
      configDir: {
        configDir: dependencies.pathOperations.join(targetDirectory, ".rundown"),
        isExplicit: true,
      },
      pathOperations: dependencies.pathOperations,
      output: dependencies.output,
    });
    const initCode = await initProject();
    if (initCode !== EXIT_CODE_SUCCESS) {
      return initCode;
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
