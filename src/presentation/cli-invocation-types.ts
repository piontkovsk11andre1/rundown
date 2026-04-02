import type { ConfigDirResult } from "../domain/ports/index.js";
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
