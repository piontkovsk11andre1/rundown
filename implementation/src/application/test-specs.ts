import path from "node:path";
import { DEFAULT_TEST_MATERIALIZED_TEMPLATE } from "../domain/defaults.js";
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
import { resolveEffectiveWorkspaceRoot } from "../domain/workspace-link.js";
import {
  resolveWorkspaceDirectories,
  resolveWorkspacePath,
  resolveWorkspacePlacement,
} from "./workspace-paths.js";

interface TestRunResult {
  ok: boolean;
  reason?: string;
}

interface TestContext {
  mode: "materialized";
  includedDirectories: string;
  includedDirectoriesJson: string;
  excludedDirectories: string;
  excludedDirectoriesJson: string;
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
    const workspaceDirectories = resolveWorkspaceDirectories({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const workspacePlacement = resolveWorkspacePlacement({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
    });
    const specsDir = resolveWorkspacePath({
      fileSystem: dependencies.fileSystem,
      workspaceRoot,
      invocationRoot: invocationDir,
      bucket: "specs",
      overrideDir: options.dir,
      directories: workspaceDirectories,
      placement: workspacePlacement,
    });
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
        fileSystem: dependencies.fileSystem,
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
      fileSystem: dependencies.fileSystem,
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
      fileSystem: FileSystem;
      workerPattern: ParsedWorkerPattern;
      workerTimeoutMs?: number;
      showAgentOutput?: boolean;
    },
  ): Promise<number> {
    const {
      cwd,
      invocationRoot,
      fileSystem,
      workerPattern,
      workerTimeoutMs,
      showAgentOutput,
    } = options;

    const verifyTemplate = loadTestVerifyTemplate(dependencies.templateLoader, cwd);
    const testContext = buildTestContext(
      fileSystem,
      cwd,
      invocationRoot,
    );
    const executionCwd = invocationRoot;

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
        includedDirectories: testContext.includedDirectories,
        includedDirectoriesJson: testContext.includedDirectoriesJson,
        excludedDirectories: testContext.excludedDirectories,
        excludedDirectoriesJson: testContext.excludedDirectoriesJson,
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
): TestContext {
  const workspaceDirectories = resolveWorkspaceDirectories({
    fileSystem,
    workspaceRoot: projectRoot,
  });
  const workspacePlacement = resolveWorkspacePlacement({
    fileSystem,
    workspaceRoot: projectRoot,
  });
  const includeExclude = buildIncludedAndExcludedDirectories(
    fileSystem,
    projectRoot,
    invocationRoot,
    workspaceDirectories,
    workspacePlacement,
  );

  return {
    mode: "materialized",
    includedDirectories: includeExclude.included,
    includedDirectoriesJson: JSON.stringify(includeExclude.includedList),
    excludedDirectories: includeExclude.excluded,
    excludedDirectoriesJson: JSON.stringify(includeExclude.excludedList),
  };
}

function loadTestVerifyTemplate(
  templateLoader: TemplateLoader,
  projectRoot: string,
): string {
  const configDir = path.join(projectRoot, ".rundown");
  return templateLoader.load(path.join(configDir, "test-materialized.md"))
    ?? templateLoader.load(path.join(configDir, "test-verify.md"))
    ?? DEFAULT_TEST_MATERIALIZED_TEMPLATE;
}

function buildIncludedAndExcludedDirectories(
  fileSystem: FileSystem,
  workspaceRoot: string,
  invocationRoot: string,
  workspaceDirectories: ReturnType<typeof resolveWorkspaceDirectories>,
  workspacePlacement: ReturnType<typeof resolveWorkspacePlacement>,
): {
  included: string;
  includedList: string[];
  excluded: string;
  excludedList: string[];
} {
  const excludedList = [
    resolveWorkspacePath({
      fileSystem,
      workspaceRoot,
      invocationRoot,
      bucket: "design",
      directories: workspaceDirectories,
      placement: workspacePlacement,
    }),
    resolveWorkspacePath({
      fileSystem,
      workspaceRoot,
      invocationRoot,
      bucket: "specs",
      directories: workspaceDirectories,
      placement: workspacePlacement,
    }),
    resolveWorkspacePath({
      fileSystem,
      workspaceRoot,
      invocationRoot,
      bucket: "migrations",
      directories: workspaceDirectories,
      placement: workspacePlacement,
    }),
  ];

  return {
    included: invocationRoot,
    includedList: [invocationRoot],
    excluded: excludedList.join("\n"),
    excludedList,
  };
}
