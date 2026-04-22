import path from "node:path";
import {
  DEFAULT_TEST_FUTURE_TEMPLATE,
  DEFAULT_TEST_MATERIALIZED_TEMPLATE,
} from "../domain/defaults.js";
import {
  parseMigrationFilename,
  parseMigrationDirectory,
} from "../domain/migration-parser.js";
import type { MigrationState } from "../domain/migration-types.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import type {
  ConfigDirResult,
  FileSystem,
  TemplateLoader,
  WorkerConfigPort,
  WorkerExecutorPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { resolveDesignContext, resolveDesignContextSourceReferences } from "./design-context.js";
import { resolveEffectiveWorkspaceRoot } from "../domain/workspace-link.js";
import {
  resolvePredictionWorkspaceDirectories,
  resolvePredictionWorkspacePath,
  resolvePredictionWorkspacePlacement,
} from "./prediction-workspace-paths.js";

interface TestRunResult {
  ok: boolean;
  reason?: string;
}

interface TestContext {
  mode: "materialized" | "future";
  includedDirectories: string;
  includedDirectoriesJson: string;
  excludedDirectories: string;
  excludedDirectoriesJson: string;
  futureTarget: string;
  design: string;
  designContextSourceReferences: string;
  designContextSourceReferencesJson: string;
  designContextHasManagedDocs: string;
  latestContext: string;
  latestSnapshot: string;
  migrationHistory: string;
  lowContextGuidance: string;
}

interface PredictionDirectoryContext {
  designPath: string;
  specsPath: string;
  migrationsPath: string;
}

export interface TestSpecsDependencies {
  workerExecutor: WorkerExecutorPort;
  workerConfigPort: WorkerConfigPort;
  configDir: ConfigDirResult | undefined;
  fileSystem: FileSystem;
  templateLoader: TemplateLoader;
  output: ApplicationOutputPort;
}

export interface TestSpecsOptions {
  action?: "new";
  prompt?: string;
  run?: boolean;
  dir?: string;
  future?: true | number;
  workerPattern: ParsedWorkerPattern;
  showAgentOutput?: boolean;
}

export function createTestSpecs(
  dependencies: TestSpecsDependencies,
): (options: TestSpecsOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function testSpecs(options: TestSpecsOptions): Promise<number> {
    const invocationDir = process.cwd();
    const workerTimeoutMs = dependencies.configDir?.configDir
      ? dependencies.workerConfigPort.load(dependencies.configDir.configDir)?.workerTimeoutMs
      : undefined;
    const workspaceRoot = resolveWorkspaceRootFromCurrentDir(dependencies.fileSystem, invocationDir);
    const workspaceDirectories = resolvePredictionWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const workspacePlacement = resolvePredictionWorkspacePlacement({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const specsDir = resolvePredictionWorkspacePath({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: invocationDir,
      bucket: "specs",
      overrideDir: options.dir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });
    const predictionDirectoryContext = resolvePredictionDirectoryContext(
      dependencies.fileSystem,
      workspaceRoot,
      invocationDir,
      workspaceDirectories,
      workspacePlacement,
    );

    if (options.action === "new") {
      const assertion = (options.prompt ?? "").trim();
      if (assertion.length === 0) {
        emit({ kind: "error", message: "Missing assertion text for `test new`." });
        return EXIT_CODE_FAILURE;
      }

      if (!dependencies.fileSystem.exists(specsDir)) {
        dependencies.fileSystem.mkdir(specsDir, { recursive: true });
      }

      const slug = slugifySpecName(assertion);
      const createdSpecPath = path.join(specsDir, `${slug}.md`);
      const assertionContent = assertion.endsWith("\n") ? assertion : `${assertion}\n`;
      dependencies.fileSystem.writeText(createdSpecPath, assertionContent);
      emit({ kind: "success", message: "Created spec " + path.basename(createdSpecPath) });

      if (!options.run) {
        return EXIT_CODE_SUCCESS;
      }

      return runSpecFiles([createdSpecPath], {
        cwd: workspaceRoot,
        invocationRoot: invocationDir,
        future: options.future,
        predictionDirectoryContext,
        workerPattern: options.workerPattern,
        workerTimeoutMs,
        showAgentOutput: options.showAgentOutput,
      });
    }

    if (!dependencies.fileSystem.exists(specsDir)) {
      emit({ kind: "error", message: "Specs directory does not exist: " + specsDir });
      return EXIT_CODE_FAILURE;
    }

    const specFiles = dependencies.fileSystem
      .readdir(specsDir)
      .filter((entry) => entry.isFile && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => path.join(specsDir, entry.name))
      .sort((left, right) => path.basename(left).localeCompare(path.basename(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }));

    if (specFiles.length === 0) {
      emit({ kind: "info", message: "No spec files found in " + specsDir });
      return EXIT_CODE_SUCCESS;
    }

    return runSpecFiles(specFiles, {
      cwd: workspaceRoot,
      invocationRoot: invocationDir,
      future: options.future,
      predictionDirectoryContext,
      workerPattern: options.workerPattern,
      workerTimeoutMs,
      showAgentOutput: options.showAgentOutput,
    });
  };

  async function runSpecFiles(
    specFiles: readonly string[],
    options: {
      cwd: string;
      invocationRoot: string;
      future: true | number | undefined;
      predictionDirectoryContext: PredictionDirectoryContext;
      workerPattern: ParsedWorkerPattern;
      workerTimeoutMs?: number;
      showAgentOutput?: boolean;
    },
  ): Promise<number> {
    const {
      cwd,
      invocationRoot,
      future,
      predictionDirectoryContext,
      workerPattern,
      workerTimeoutMs,
      showAgentOutput,
    } = options;

    const verifyTemplate = loadTestVerifyTemplate(dependencies.templateLoader, cwd, future !== undefined);
    const testContext = buildTestContext(
      dependencies.fileSystem,
      cwd,
      invocationRoot,
      predictionDirectoryContext,
      future,
    );
    const executionCwd = testContext.mode === "materialized"
      ? invocationRoot
      : cwd;
    if (testContext.lowContextGuidance.length > 0) {
      emit({ kind: "warn", message: testContext.lowContextGuidance });
    }

    let passed = 0;
    let failed = 0;

    for (const specFilePath of specFiles) {
      const assertion = dependencies.fileSystem.readText(specFilePath);
      const vars: TemplateVars = {
        task: assertion,
        file: specFilePath,
        context: "",
        taskIndex: 0,
        taskLine: 1,
        source: assertion,
        assertion,
        testMode: testContext.mode,
        futureTarget: testContext.futureTarget,
        includedDirectories: testContext.includedDirectories,
        includedDirectoriesJson: testContext.includedDirectoriesJson,
        excludedDirectories: testContext.excludedDirectories,
        excludedDirectoriesJson: testContext.excludedDirectoriesJson,
        design: testContext.design,
        designContextSourceReferences: testContext.designContextSourceReferences,
        designContextSourceReferencesJson: testContext.designContextSourceReferencesJson,
        designContextHasManagedDocs: testContext.designContextHasManagedDocs,
        latestContext: testContext.latestContext,
        latestSnapshot: testContext.latestSnapshot,
        migrationHistory: testContext.migrationHistory,
      };
      const prompt = renderTemplate(verifyTemplate, vars);

      const workerResult = await dependencies.workerExecutor.runWorker({
        workerPattern,
        prompt,
        mode: "wait",
        cwd: executionCwd,
        timeoutMs: workerTimeoutMs,
        env: {
          RUNDOWN_TEST_MODE: testContext.mode,
          RUNDOWN_TEST_FUTURE_TARGET: testContext.futureTarget,
          RUNDOWN_TEST_INCLUDED_DIRECTORIES: testContext.includedDirectoriesJson,
          RUNDOWN_TEST_EXCLUDED_DIRECTORIES: testContext.excludedDirectoriesJson,
        },
      });

      if (showAgentOutput) {
        if (workerResult.stdout.length > 0) {
          emit({ kind: "text", text: workerResult.stdout });
        }
        if (workerResult.stderr.length > 0) {
          emit({ kind: "stderr", text: workerResult.stderr });
        }
      }

      const result = parseTestResult(workerResult);
      const specName = path.basename(specFilePath);
      if (result.ok) {
        passed += 1;
        emit({ kind: "success", message: "PASS " + specName });
      } else {
        failed += 1;
        emit({ kind: "error", message: "FAIL " + specName + ": " + (result.reason ?? "Assertion does not hold.") });
      }
    }

    emit({
      kind: failed > 0 ? "warn" : "success",
      message: `Test summary: passed ${passed}, failed ${failed}.`,
    });

    return failed > 0 ? EXIT_CODE_FAILURE : EXIT_CODE_SUCCESS;
  }
}

function resolveWorkspaceRootFromCurrentDir(fileSystem: FileSystem, currentDir: string): string {
  return resolveEffectiveWorkspaceRoot({
    currentDir,
    fileSystem,
    pathOperations: path,
  });
}

function slugifySpecName(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[`'".]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug.length > 0 ? slug : "spec";
}

function parseTestResult(output: { exitCode: number | null; stdout: string; stderr: string }): TestRunResult {
  if (output.exitCode !== 0) {
    const reason = output.stderr.trim() || output.stdout.trim() || `Worker exited with code ${String(output.exitCode)}.`;
    return { ok: false, reason };
  }

  const verdictLine = extractVerdictLine(output.stdout);
  if (verdictLine.toUpperCase() === "OK") {
    return { ok: true };
  }

  const notOkMatch = verdictLine.match(/^NOT_OK\s*:\s*(.*)$/i);
  if (notOkMatch) {
    const reason = notOkMatch[1]?.trim();
    return {
      ok: false,
      reason: reason && reason.length > 0 ? reason : "Assertion does not hold.",
    };
  }

  if (verdictLine.length > 0) {
    return { ok: false, reason: verdictLine };
  }

  const fallback = output.stderr.trim();
  return {
    ok: false,
    reason: fallback.length > 0 ? fallback : "Verification worker returned empty output. Expected OK or NOT_OK: <reason>.",
  };
}

function extractVerdictLine(stdout: string): string {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return "";
  }

  const lastLine = lines[lines.length - 1]!;
  return stripBackticks(lastLine);
}

function stripBackticks(value: string): string {
  return value.startsWith("`") && value.endsWith("`")
    ? value.slice(1, -1)
    : value;
}

function buildTestContext(
  fileSystem: FileSystem,
  projectRoot: string,
  invocationRoot: string,
  predictionDirectoryContext: PredictionDirectoryContext,
  future: true | number | undefined,
): TestContext {
  const includeExclude = buildIncludedAndExcludedDirectories(
    projectRoot,
    invocationRoot,
    predictionDirectoryContext,
    future,
  );

  if (future === undefined) {
    return {
      mode: "materialized",
      includedDirectories: includeExclude.included,
      includedDirectoriesJson: JSON.stringify(includeExclude.includedList),
      excludedDirectories: includeExclude.excluded,
      excludedDirectoriesJson: JSON.stringify(includeExclude.excludedList),
      futureTarget: "",
      design: "",
      designContextSourceReferences: "",
      designContextSourceReferencesJson: "[]",
      designContextHasManagedDocs: "false",
      latestContext: "",
      latestSnapshot: "",
      migrationHistory: "",
      lowContextGuidance: "",
    };
  }

  const workspaceDirectories = resolvePredictionWorkspaceDirectories({
    fileSystem,
    workspaceRoot: projectRoot,
  });
  const workspacePlacement = resolvePredictionWorkspacePlacement({
    fileSystem,
    workspaceRoot: projectRoot,
  });
  const migrationsDir = resolvePredictionWorkspacePath({
    fileSystem,
    workspaceRoot: projectRoot,
    invocationRoot,
    bucket: "migrations",
    directories: workspaceDirectories,
    placement: workspacePlacement,
  });

  const state = readMigrationState(fileSystem, migrationsDir);
  const futureScope = selectFutureScope(state, future);
  const designContext = resolveDesignContext(fileSystem, projectRoot, { invocationRoot });
  const designContextSources = resolveDesignContextSourceReferences(fileSystem, projectRoot, { invocationRoot });
  const designContextSourceReferences = designContextSources.sourceReferences
    .map((sourcePath) => "- " + sourcePath)
    .join("\n");

  return {
    mode: "future",
    includedDirectories: includeExclude.included,
    includedDirectoriesJson: JSON.stringify(includeExclude.includedList),
    excludedDirectories: includeExclude.excluded,
    excludedDirectoriesJson: JSON.stringify(includeExclude.excludedList),
    futureTarget: futureScope.targetLabel,
    design: designContext.design,
    designContextSourceReferences,
    designContextSourceReferencesJson: JSON.stringify(designContextSources.sourceReferences),
    designContextHasManagedDocs: designContextSources.hasManagedDocs ? "true" : "false",
    latestContext: futureScope.latestContextPath ? fileSystem.readText(futureScope.latestContextPath) : "",
    latestSnapshot: futureScope.snapshotPath ? fileSystem.readText(futureScope.snapshotPath) : "",
    migrationHistory: futureScope.migrationPaths.map((migrationPath) => "- " + path.basename(migrationPath)).join("\n"),
    lowContextGuidance: designContext.isLowContext ? designContext.lowContextGuidance : "",
  };
}

function loadTestVerifyTemplate(
  templateLoader: TemplateLoader,
  projectRoot: string,
  useFutureTemplate: boolean,
): string {
  const configDir = path.join(projectRoot, ".rundown");
  if (useFutureTemplate) {
    return templateLoader.load(path.join(configDir, "test-future.md"))
      ?? templateLoader.load(path.join(configDir, "test-verify.md"))
      ?? DEFAULT_TEST_FUTURE_TEMPLATE;
  }

  return templateLoader.load(path.join(configDir, "test-materialized.md"))
    ?? templateLoader.load(path.join(configDir, "test-verify.md"))
    ?? DEFAULT_TEST_MATERIALIZED_TEMPLATE;
}

function resolvePredictionDirectoryContext(
  fileSystem: FileSystem,
  workspaceRoot: string,
  invocationRoot: string,
  workspaceDirectories: ReturnType<typeof resolvePredictionWorkspaceDirectories>,
  workspacePlacement: ReturnType<typeof resolvePredictionWorkspacePlacement>,
): PredictionDirectoryContext {
  return {
    designPath: resolvePredictionWorkspacePath({
      fileSystem,
      workspaceRoot,
      invocationRoot,
      bucket: "design",
      directories: workspaceDirectories,
      placement: workspacePlacement,
    }),
    specsPath: resolvePredictionWorkspacePath({
      fileSystem,
      workspaceRoot,
      invocationRoot,
      bucket: "specs",
      directories: workspaceDirectories,
      placement: workspacePlacement,
    }),
    migrationsPath: resolvePredictionWorkspacePath({
      fileSystem,
      workspaceRoot,
      invocationRoot,
      bucket: "migrations",
      directories: workspaceDirectories,
      placement: workspacePlacement,
    }),
  };
}

function buildIncludedAndExcludedDirectories(
  projectRoot: string,
  invocationRoot: string,
  predictionDirectoryContext: PredictionDirectoryContext,
  future: true | number | undefined,
): {
  included: string;
  includedList: string[];
  excluded: string;
  excludedList: string[];
} {
  if (future === undefined) {
    const excludedList = [
      predictionDirectoryContext.designPath,
      predictionDirectoryContext.specsPath,
      predictionDirectoryContext.migrationsPath,
    ];
    return {
      included: invocationRoot,
      includedList: [invocationRoot],
      excluded: excludedList.join("\n"),
      excludedList,
    };
  }

  const includedList = [
    predictionDirectoryContext.designPath,
    predictionDirectoryContext.migrationsPath,
  ];
  return {
    included: includedList.join("\n"),
    includedList,
    excluded: predictionDirectoryContext.specsPath,
    excludedList: [predictionDirectoryContext.specsPath],
  };
}

function selectFutureScope(
  state: MigrationState,
  future: true | number,
): {
  targetLabel: string;
  snapshotPath: string | null;
  latestContextPath: string | null;
  migrationPaths: string[];
} {
  const maxMigrationNumber = state.migrations.length > 0
    ? state.migrations[state.migrations.length - 1]!.number
    : 0;
  const requestedTarget = typeof future === "number" ? future : maxMigrationNumber;
  const targetNumber = Math.max(0, Math.min(requestedTarget, maxMigrationNumber));

  const targetLabel = typeof future === "number"
    ? String(targetNumber)
    : (targetNumber > 0 ? String(targetNumber) : "latest");

  const snapshotLookupCeiling = typeof future === "number"
    ? Math.max(0, targetNumber - 1)
    : targetNumber;
  const snapshot = selectSnapshotForFutureScope(state, snapshotLookupCeiling);
  const snapshotPath = snapshot?.filePath ?? null;
  const snapshotMigrationNumber = snapshot?.migrationNumber ?? 0;

  const migrationPaths = state.migrations
    .filter((migration) => migration.number > snapshotMigrationNumber && migration.number <= targetNumber)
    .map((migration) => migration.filePath);

  const latestContextPath = null;

  return {
    targetLabel,
    snapshotPath,
    latestContextPath,
    migrationPaths,
  };
}

function selectSnapshotForFutureScope(
  state: MigrationState,
  maxMigrationNumber: number,
): { migrationNumber: number; filePath: string } | null {
  const latestSnapshot = state.latestSnapshot;
  if (latestSnapshot && latestSnapshot.migrationNumber <= maxMigrationNumber) {
    return {
      migrationNumber: latestSnapshot.migrationNumber,
      filePath: latestSnapshot.filePath,
    };
  }

  for (let index = state.migrations.length - 1; index >= 0; index -= 1) {
    const migration = state.migrations[index];
    if (!migration || migration.number > maxMigrationNumber) {
      continue;
    }

    const snapshot = migration.satellites.find((satellite) => satellite.type === "snapshot");
    if (snapshot) {
      return {
        migrationNumber: migration.number,
        filePath: snapshot.filePath,
      };
    }
  }

  return null;
}

function readMigrationState(fileSystem: FileSystem, migrationsDir: string): MigrationState {
  if (!fileSystem.exists(migrationsDir)) {
    return parseMigrationDirectory([], migrationsDir);
  }

  const migrationFiles = fileSystem.readdir(migrationsDir)
    .filter((entry) => entry.isFile && isMigrationLikeMarkdown(entry.name))
    .map((entry) => path.join(migrationsDir, entry.name));

  return parseMigrationDirectory(migrationFiles, migrationsDir);
}

function isMigrationLikeMarkdown(fileName: string): boolean {
  if (!fileName.toLowerCase().endsWith(".md")) {
    return false;
  }

  return parseMigrationFilename(fileName) !== null;
}
