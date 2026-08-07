import type { ProcessRunMode } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type { PlanTaskOptions } from "./plan-task.js";
import type { ResearchTaskOptions } from "./research-task.js";

export interface ExploreTaskDependencies {
  output: ApplicationOutputPort;
  researchTask: (options: ResearchTaskOptions) => Promise<number>;
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
      emit({ kind: "info", message: "Explore phase 1/2: research" });
    }

    const researchCode = normalizeExplorePhaseExitCode(await dependencies.researchTask({
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
      verbose,
    }));
    if (researchCode !== 0) {
      return researchCode;
    }

    if (emitPhaseMessages) {
      emit({ kind: "info", message: "Explore transition: research -> plan" });
      emit({ kind: "info", message: "Explore phase 2/2: plan" });
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
