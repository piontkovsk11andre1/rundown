import type {
  ConfigDirResult,
  ProcessRunMode,
} from "../domain/ports/index.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import type {
  GlobalOutputEntryWriter,
  LoggedOutputContext,
} from "./logged-output-port.js";

/**
 * Declares collaborators used to build invocation-scoped CLI metadata.
 */
export interface CliInvocationMetadataDependencies {
  // Version string injected into invocation log metadata.
  cliVersion: string;
  // Factory that creates a stable correlation id for one CLI run.
  createSessionId: () => string;
  // Mapper that derives a normalized command label from raw argv.
  resolveInvocationCommand: (argv: string[]) => string;
}

/**
 * Resolves the configuration directory to use for a specific CLI invocation.
 *
 * Returning `undefined` signals that the caller should use its fallback directory.
 */
export type ResolveConfigDirForInvocation = (
  argv: string[],
  cwd: string,
) => ConfigDirResult | undefined;

/**
 * Represents initialized logging infrastructure for a single CLI invocation.
 */
export interface CliInvocationLogState {
  // Structured log writer bound to the resolved invocation config directory.
  writer: GlobalOutputEntryWriter;
  // Immutable metadata attached to all records emitted for this invocation.
  context: LoggedOutputContext;
}

/**
 * Normalized shared options for worker-backed CLI command invocations.
 */
export interface WorkerCommandInvocationOptions {
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
  cliBlockTimeoutMs: number;
  configDirOption?: string;
}

/**
 * Normalized invocation payload for the `research` command.
 */
export interface ResearchCommandInvocationOptions extends WorkerCommandInvocationOptions {
  source: string;
  verbose?: boolean;
}

/**
 * Normalized invocation payload for the `query` command.
 */
export interface QueryCommandInvocationOptions extends WorkerCommandInvocationOptions {
  queryText: string;
  dir: string;
  format: "markdown" | "json" | "yn" | "success-error";
  output?: string;
  skipResearch: boolean;
  scanCount?: number;
  maxItems?: number;
  deep?: number;
  verbose?: boolean;
}
