import { createApp } from "../create-app.js";
import type { ConfigDirResult } from "../domain/ports/index.js";
import { createConfigDirAdapter } from "../infrastructure/adapters/config-dir-adapter.js";
import fs from "node:fs";
import path from "node:path";
import {
  createCliInvocationLogState,
} from "./cli-invocation-log.js";
import type {
  CliInvocationLogState,
  CliInvocationMetadataDependencies,
} from "./cli-invocation-types.js";
import { createLoggedOutputPort } from "./logged-output-port.js";
import { normalizeOptionalString } from "./cli-options.js";
import { cliOutputPort } from "./output-port.js";

export type CliApp = ReturnType<typeof createApp>;

interface CreateAppForInvocationDependencies extends CliInvocationMetadataDependencies {
  // Allows callers (mostly tests) to inject an existing log state.
  logState?: CliInvocationLogState;
}

interface CreateAppForInvocationResult {
  // Ready-to-run CLI application instance.
  app: CliApp;
  // Invocation log state used for output logging and lifecycle events.
  logState: CliInvocationLogState;
}

/**
 * Builds the CLI application for a single invocation.
 *
 * The app is wired with invocation-aware logging and a config-directory resolver
 * so command execution and emitted output are consistently tracked.
 */
export function createAppForInvocation(
  argv: string[],
  {
    cliVersion,
    createSessionId,
    resolveInvocationCommand,
    logState,
  }: CreateAppForInvocationDependencies,
): CreateAppForInvocationResult {
  // Reuse injected state when available; otherwise create a new invocation log context.
  const invocationLogState = logState ?? createCliInvocationLogState(argv, {
    cliVersion,
    createSessionId,
    resolveInvocationCommand,
    resolveConfigDirForInvocation: (invocationArgv, cwd) => resolveConfigDirForInvocation(invocationArgv, cwd),
  });
  // Resolve config directory once so both app behavior and logs use the same value.
  const configDirOverride = resolveConfigDirForInvocation(argv);
  // Wrap CLI output to ensure all user-facing messages are captured in invocation logs.
  const loggedOutputPort = createLoggedOutputPort({
    output: cliOutputPort,
    writer: invocationLogState.writer,
    context: invocationLogState.context,
  });

  return {
    app: createApp({
      ports: {
        output: loggedOutputPort,
        configDir: configDirOverride,
      },
    }),
    logState: invocationLogState,
  };
}

/**
 * Resolves the effective config directory for the current invocation.
 *
 * Explicit CLI arguments take precedence. When no explicit value is present,
 * repository/project defaults are resolved through the config-dir adapter.
 */
export function resolveConfigDirForInvocation(
  argv?: string[],
  cwd: string = process.cwd(),
): ConfigDirResult | undefined {
  // Prefer an explicitly provided config directory when present in argv.
  const explicitConfigDir = argv
    ? resolveExplicitConfigDirFromArgv(argv)
    : undefined;
  if (explicitConfigDir) {
    return {
      configDir: path.resolve(explicitConfigDir),
      isExplicit: true,
    };
  }

  return createConfigDirAdapter().resolve(cwd);
}

/**
 * Extracts a `--config-dir` value from raw CLI arguments.
 *
 * Supports both `--config-dir <value>` and `--config-dir=<value>` forms and
 * stops parsing at `--`, which marks the end of option processing.
 */
function resolveExplicitConfigDirFromArgv(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    // Ignore everything after the argument separator.
    if (token === "--") {
      break;
    }

    if (token === "--config-dir") {
      const nextToken = argv[index + 1];
      return typeof nextToken === "string"
        ? normalizeOptionalString(nextToken)
        : undefined;
    }

    if (token.startsWith("--config-dir=")) {
      return normalizeOptionalString(token.slice("--config-dir=".length));
    }
  }

  return undefined;
}

/**
 * Normalizes an explicit config-dir option value when it is a string.
 */
function resolveExplicitConfigDirOption(configDir: unknown): string | undefined {
  if (typeof configDir !== "string") {
    return undefined;
  }

  return normalizeOptionalString(configDir);
}

/**
 * Derives the effective command token while ignoring config-dir options.
 *
 * This helps apply command-specific validation rules for `--config-dir`.
 */
function resolveInvocationCommandForConfigDir(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      break;
    }

    if (token === "--config-dir") {
      index += 1;
      continue;
    }

    if (token.startsWith("--config-dir=")) {
      continue;
    }

    if (!token.startsWith("-")) {
      return token;
    }
  }

  return "rundown";
}

/**
 * Returns whether the active command can accept a non-existent explicit config directory.
 */
function allowsMissingExplicitConfigDir(argv: string[]): boolean {
  return resolveInvocationCommandForConfigDir(argv) === "init";
}

/**
 * Validates an explicitly provided `--config-dir` value.
 *
 * Missing paths are accepted only for commands that can initialize new config
 * directories (for example `init`). Existing paths must be directories.
 */
export function validateExplicitConfigDirOption(invocationArgv: string[], configDir: unknown): void {
  const normalizedConfigDir = resolveExplicitConfigDirOption(configDir);
  // Nothing to validate when the option was omitted or normalized to empty.
  if (!normalizedConfigDir) {
    return;
  }

  const resolvedConfigDir = path.resolve(normalizedConfigDir);
  let stats: fs.Stats;
  try {
    // Resolve filesystem metadata for the candidate config directory path.
    stats = fs.statSync(resolvedConfigDir);
  } catch {
    // Allow creation workflows to pass even if the target directory is not present yet.
    if (allowsMissingExplicitConfigDir(invocationArgv)) {
      return;
    }
    throw new Error(`Invalid --config-dir value: ${normalizedConfigDir}. Directory does not exist: ${resolvedConfigDir}.`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Invalid --config-dir value: ${normalizedConfigDir}. Path is not a directory: ${resolvedConfigDir}.`);
  }
}
