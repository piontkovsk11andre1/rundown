import path from "node:path";
import { DEFAULT_TEST_VERIFY_TEMPLATE } from "../domain/defaults.js";
import {
  parseMigrationFilename,
  parseMigrationDirectory,
} from "../domain/migration-parser.js";
import type { MigrationState, SatelliteType } from "../domain/migration-types.js";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_SUCCESS,
} from "../domain/exit-codes.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import type {
  FileSystem,
  TemplateLoader,
  WorkerExecutorPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import { resolveDesignContext } from "./design-context.js";

interface TestRunResult {
  ok: boolean;
  reason?: string;
}

interface TestContext {
  design: string;
  latestContext: string;
  latestSnapshot: string;
  migrationHistory: string;
}

export interface TestSpecsDependencies {
  workerExecutor: WorkerExecutorPort;
  fileSystem: FileSystem;
  templateLoader: TemplateLoader;
  output: ApplicationOutputPort;
}

export interface TestSpecsOptions {
  action?: "new";
  prompt?: string;
  run?: boolean;
  dir?: string;
  workerPattern: ParsedWorkerPattern;
  showAgentOutput?: boolean;
}

export function createTestSpecs(
  dependencies: TestSpecsDependencies,
): (options: TestSpecsOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function testSpecs(options: TestSpecsOptions): Promise<number> {
    const cwd = process.cwd();
    const specsDir = path.resolve(cwd, options.dir ?? "specs");

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
        cwd,
        workerPattern: options.workerPattern,
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
      cwd,
      workerPattern: options.workerPattern,
      showAgentOutput: options.showAgentOutput,
    });
  };

  async function runSpecFiles(
    specFiles: readonly string[],
    options: {
      cwd: string;
      workerPattern: ParsedWorkerPattern;
      showAgentOutput?: boolean;
    },
  ): Promise<number> {
    const { cwd, workerPattern, showAgentOutput } = options;

    const templatePath = path.join(cwd, ".rundown", "test-verify.md");
    const verifyTemplate = dependencies.templateLoader.load(templatePath) ?? DEFAULT_TEST_VERIFY_TEMPLATE;
    const testContext = buildTestContext(dependencies.fileSystem, cwd);

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
        design: testContext.design,
        latestContext: testContext.latestContext,
        latestSnapshot: testContext.latestSnapshot,
        migrationHistory: testContext.migrationHistory,
      };
      const prompt = renderTemplate(verifyTemplate, vars);

      const workerResult = await dependencies.workerExecutor.runWorker({
        workerPattern,
        prompt,
        mode: "wait",
        cwd,
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

function buildTestContext(fileSystem: FileSystem, projectRoot: string): TestContext {
  const migrationsDir = path.join(projectRoot, "migrations");

  const state = readMigrationState(fileSystem, migrationsDir);
  const latestSnapshot = getLatestSatellitePath(state, "snapshot");

  return {
    design: resolveDesignContext(fileSystem, projectRoot).design,
    latestContext: state.latestContext ? fileSystem.readText(state.latestContext.filePath) : "",
    latestSnapshot: latestSnapshot ? fileSystem.readText(latestSnapshot) : "",
    migrationHistory: state.migrations.map((migration) => "- " + path.basename(migration.filePath)).join("\n"),
  };
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

function getLatestSatellitePath(
  state: MigrationState,
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
