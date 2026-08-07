import type { ProcessRunMode } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type { PlanTaskOptions } from "./plan-task.js";

export interface ExploreTaskDependencies {
  output: ApplicationOutputPort;
  planTask: (options: PlanTaskOptions) => Promise<number>;
}

export interface ExploreTaskOptions {
  source: string;
  cwd?: string;
  invocationDir?: string;
  workspaceDir?: string;
  workspaceLinkPath?: string;
  isLinkedWorkspace?: boolean;
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
  configDirOption?: string;
  scanCount?: number;
  deep?: number;
  maxItems?: number;
  verbose?: boolean;
  emitPhaseMessages?: boolean;
}

export function createExploreTask(
  dependencies: ExploreTaskDependencies,
): (options: ExploreTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function exploreTask(options: ExploreTaskOptions): Promise<number> {
    const {
      source,
      cwd,
      invocationDir,
      workspaceDir,
      workspaceLinkPath,
      isLinkedWorkspace,
      mode,
      workerPattern,
      showAgentOutput,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      trace,
      forceUnlock,
      ignoreCliBlock,
      cliBlockTimeoutMs,
      configDirOption,
      scanCount,
      deep = 0,
      maxItems,
      verbose = false,
      emitPhaseMessages = false,
    } = options;

    if (emitPhaseMessages) {
      emit({ kind: "info", message: "Explore phase 1/1: plan" });
    }

    return normalizeExplorePhaseExitCode(await dependencies.planTask({
      source,
      cwd,
      invocationDir,
      workspaceDir,
      workspaceLinkPath,
      isLinkedWorkspace,
      scanCount,
      maxItems,
      deep,
      mode,
      workerPattern,
      showAgentOutput,
      dryRun,
      printPrompt,
      keepArtifacts,
      varsFileOption,
      cliTemplateVarArgs,
      trace,
      forceUnlock,
      ignoreCliBlock,
      cliBlockTimeoutMs,
      verbose,
    }));
  };
}

function normalizeExplorePhaseExitCode(exitCode: number): number {
  if (Number.isSafeInteger(exitCode) && exitCode >= 0) {
    return exitCode;
  }

  return 1;
}
