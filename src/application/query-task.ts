import { EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type { ProcessRunMode } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

export type QueryOutputFormat = "markdown" | "json" | "yn" | "success-error";

export interface QueryTaskDependencies {
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
}

export function createQueryTask(
  dependencies: QueryTaskDependencies,
): (options: QueryTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function queryTask(options: QueryTaskOptions): Promise<number> {
    if (options.dryRun || options.printPrompt) {
      emit({ kind: "info", message: "Query task plumbing is wired; orchestration implementation is pending." });
    }
    return EXIT_CODE_SUCCESS;
  };
}
