import {
  DEFAULT_QUERY_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_SEED_TEMPLATE,
  DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
  DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE,
  DEFAULT_QUERY_YN_SEED_TEMPLATE,
} from "../domain/defaults.js";
import { EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { renderTemplate, type TemplateVars } from "../domain/template.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type { ProcessRunMode, ArtifactStore, FileSystem, PathOperationsPort, WorkingDirectoryPort } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import {
  aggregateQueryOutput,
  formatQueryOutput,
  resolveQueryExitCode,
  writeQueryOutput,
} from "./query-output.js";
import type { PlanTaskOptions } from "./plan-task.js";
import type { ResearchTaskOptions } from "./research-task.js";
import type { RunTaskOptions } from "./run-task.js";

export type QueryOutputFormat = "markdown" | "json" | "yn" | "success-error";

export interface QueryTaskDependencies {
  runTask: (options: RunTaskOptions) => Promise<number>;
  researchTask: (options: ResearchTaskOptions) => Promise<number>;
  planTask: (options: PlanTaskOptions) => Promise<number>;
  artifactStore: ArtifactStore;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  workingDirectory: WorkingDirectoryPort;
  output: ApplicationOutputPort;
}

export interface QueryTaskOptions {
  queryText: string;
  dir: string;
  format: QueryOutputFormat;
  output?: string;
  skipResearch: boolean;
  mode: ProcessRunMode;
  workerPattern: ParsedWorkerPattern;
  showAgentOutput: boolean;
  dryRun: boolean;
  printPrompt: boolean;
  keepArtifacts: boolean;
  varsFileOption: string | boolean | undefined;
  cliTemplateVarArgs: string[];
  trace: boolean;
  forceUnlock: boolean;
  ignoreCliBlock: boolean;
  cliBlockTimeoutMs?: number;
  scanCount?: number;
  maxItems?: number;
  deep?: number;
  verbose?: boolean;
  configDirOption?: string;
}

export function createQueryTask(
  dependencies: QueryTaskDependencies,
): (options: QueryTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function queryTask(options: QueryTaskOptions): Promise<number> {
    const resolvedDir = dependencies.pathOperations.resolve(
      options.dir && options.dir.trim().length > 0
        ? options.dir
        : dependencies.workingDirectory.cwd(),
    );
    const fileMode = shouldUseFileMode(options);
    const runContext = dependencies.artifactStore.createContext({
      commandName: "query",
      cwd: resolvedDir,
      mode: options.mode,
      keepArtifacts: options.keepArtifacts,
    });
    let finalized = false;

    const queryDocumentPath = dependencies.pathOperations.join(runContext.rootDir, "query.md");
    const workdirPath = dependencies.pathOperations.join(runContext.rootDir, "workdir");

    const finish = (status: "completed" | "failed"): void => {
      if (finalized) {
        return;
      }

      dependencies.artifactStore.finalize(runContext, {
        status,
        preserve: options.keepArtifacts || dependencies.artifactStore.isFailedStatus(status),
      });
      finalized = true;
    };

    let exitCode = EXIT_CODE_SUCCESS;

    try {
      dependencies.fileSystem.mkdir(runContext.rootDir, { recursive: true });
      if (fileMode) {
        dependencies.fileSystem.mkdir(workdirPath, { recursive: true });
      }

      const seedTemplate = selectQuerySeedTemplate(options.format);
      const seedVars: TemplateVars = {
        task: options.queryText,
        file: queryDocumentPath,
        context: options.queryText,
        taskIndex: 0,
        taskLine: 1,
        source: options.queryText,
        query: options.queryText,
        dir: resolvedDir,
        workdir: fileMode ? workdirPath : "",
      };
      const querySeedDocument = renderTemplate(seedTemplate, seedVars);
      dependencies.fileSystem.writeText(queryDocumentPath, querySeedDocument);

      const runtimeTemplateVars = mergeRuntimeTemplateVars(options.cliTemplateVarArgs, {
        query: options.queryText,
        dir: resolvedDir,
        workdir: fileMode ? workdirPath : "",
      });

      if (!options.skipResearch) {
        emit({ kind: "info", message: "Query phase 1/3: research" });
        const researchCode = await dependencies.researchTask({
          source: queryDocumentPath,
          cwd: resolvedDir,
          mode: options.mode,
          workerPattern: options.workerPattern,
          showAgentOutput: options.showAgentOutput,
          dryRun: options.dryRun,
          printPrompt: options.printPrompt,
          keepArtifacts: options.keepArtifacts,
          varsFileOption: options.varsFileOption,
          cliTemplateVarArgs: runtimeTemplateVars,
          trace: options.trace,
          forceUnlock: options.forceUnlock,
          ignoreCliBlock: options.ignoreCliBlock,
          cliBlockTimeoutMs: options.cliBlockTimeoutMs,
          configDirOption: options.configDirOption,
          verbose: options.verbose,
        });
        if (researchCode !== EXIT_CODE_SUCCESS) {
          finish("failed");
          return researchCode;
        }
      } else {
        emit({ kind: "info", message: "Query phase 1/3 skipped: research" });
      }

      emit({ kind: "info", message: "Query phase 2/3: plan" });
      const planCode = await dependencies.planTask({
        source: queryDocumentPath,
        cwd: resolvedDir,
        scanCount: options.scanCount,
        maxItems: options.maxItems,
        deep: options.deep,
        mode: options.mode,
        workerPattern: options.workerPattern,
        showAgentOutput: options.showAgentOutput,
        dryRun: options.dryRun,
        printPrompt: options.printPrompt,
        keepArtifacts: options.keepArtifacts,
        varsFileOption: options.varsFileOption,
        cliTemplateVarArgs: runtimeTemplateVars,
        trace: options.trace,
        forceUnlock: options.forceUnlock,
        ignoreCliBlock: options.ignoreCliBlock,
        cliBlockTimeoutMs: options.cliBlockTimeoutMs,
        verbose: options.verbose,
      });
      if (planCode !== EXIT_CODE_SUCCESS) {
        finish("failed");
        return planCode;
      }

      emit({ kind: "info", message: fileMode ? "Query phase 3/3: execute (file mode)" : "Query phase 3/3: execute (stream mode)" });
      const runCode = await dependencies.runTask({
        source: queryDocumentPath,
        cwd: resolvedDir,
        mode: options.mode,
        workerPattern: options.workerPattern,
        sortMode: "name-sort",
        verify: false,
        onlyVerify: false,
        forceExecute: false,
        forceAttempts: 1,
        noRepair: true,
        repairAttempts: 0,
        dryRun: options.dryRun,
        printPrompt: options.printPrompt,
        keepArtifacts: options.keepArtifacts,
        varsFileOption: options.varsFileOption,
        cliTemplateVarArgs: runtimeTemplateVars,
        commitAfterComplete: false,
        commitMode: "per-task",
        showAgentOutput: fileMode ? options.showAgentOutput : true,
        runAll: true,
        redo: false,
        resetAfter: false,
        clean: false,
        rounds: 1,
        trace: options.trace,
        traceOnly: false,
        forceUnlock: options.forceUnlock,
        cliBlockTimeoutMs: options.cliBlockTimeoutMs,
        ignoreCliBlock: options.ignoreCliBlock,
        verbose: options.verbose ?? false,
        taskTemplateOverride: fileMode
          ? DEFAULT_QUERY_EXECUTION_TEMPLATE
          : DEFAULT_QUERY_STREAM_EXECUTION_TEMPLATE,
      });
      if (runCode !== EXIT_CODE_SUCCESS) {
        finish("failed");
        return runCode;
      }

      if (fileMode) {
        const aggregatedOutput = await aggregateQueryOutput(workdirPath, {
          fileSystem: dependencies.fileSystem,
          pathOperations: dependencies.pathOperations,
        });
        const formattedOutput = formatQueryOutput(aggregatedOutput, options.format, options.queryText);
        await writeQueryOutput(formattedOutput, options.output, {
          fileSystem: dependencies.fileSystem,
          pathOperations: dependencies.pathOperations,
          output: dependencies.output,
        });
        exitCode = resolveQueryExitCode(options.format, formattedOutput);
      }

      finish("completed");
    } catch (error) {
      finish("failed");
      throw error;
    }

    return exitCode;
  };
}

function selectQuerySeedTemplate(format: QueryOutputFormat): string {
  if (format === "yn") {
    return DEFAULT_QUERY_YN_SEED_TEMPLATE;
  }

  if (format === "success-error") {
    return DEFAULT_QUERY_SUCCESS_ERROR_SEED_TEMPLATE;
  }

  return DEFAULT_QUERY_SEED_TEMPLATE;
}

function shouldUseFileMode(options: QueryTaskOptions): boolean {
  return options.output !== undefined
    || options.format === "json"
    || options.format === "yn"
    || options.format === "success-error";
}

function mergeRuntimeTemplateVars(
  existing: string[],
  runtimeVars: Record<string, string>,
): string[] {
  const result = [...existing];
  const existingKeys = new Set<string>();

  for (const entry of existing) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }
    existingKeys.add(entry.slice(0, equalsIndex).trim());
  }

  for (const [key, value] of Object.entries(runtimeVars)) {
    if (existingKeys.has(key)) {
      continue;
    }
    result.push(`${key}=${value}`);
  }

  return result;
}
