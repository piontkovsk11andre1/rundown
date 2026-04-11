import fs from "node:fs";
import { randomBytes } from "node:crypto";

// Environment flag used by tests to intercept process termination.
const EXIT_TEST_MODE_ENV = "RUNDOWN_TEST_MODE";

/**
 * Error thrown when CLI termination is intercepted in test mode.
 */
export class CliExitSignal extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`CLI exited with code ${code}`);
    this.code = code;
  }
}

/**
 * Reads the CLI version from package metadata.
 *
 * Returns a safe fallback when package metadata cannot be read or parsed.
 */
export function readCliVersion(): string {
  try {
    // Read the package manifest colocated with the compiled presentation module.
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
    ) as { version?: string };

    return packageJson.version ?? "0.0.0";
  } catch {
    // Fall back to a deterministic placeholder version for resilience.
    return "0.0.0";
  }
}

/**
 * Creates a short unique session identifier for invocation tracking.
 */
export function createSessionId(): string {
  return `sess-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * Splits CLI arguments into rundown-owned args and worker args.
 *
 * The `--` separator marks where downstream worker arguments begin.
 */
export function splitWorkerFromSeparator(argv: string[]): { rundownArgs: string[]; workerFromSeparator: string[] | undefined } {
  const sepIndex = argv.indexOf("--");

  const afterSep = sepIndex !== -1 ? argv.slice(sepIndex + 1) : undefined;
  const workerFromSeparator = afterSep && afterSep.length > 0 ? afterSep : undefined;

  return {
    rundownArgs: sepIndex !== -1 ? argv.slice(0, sepIndex) : argv,
    workerFromSeparator,
  };
}

/**
 * Rewrites supported command aliases before option parsing.
 *
 * - `all` -> `run --all`
 * - `migrate down [n]` -> `undo [--last n]`
 *
 * Rewriting applies only to the first positional command token before `--`.
 */
export function rewriteAllAlias(argv: string[]): string[] {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    // Stop rewriting once argument parsing is delegated.
    if (token === "--") {
      break;
    }

    // Skip option flags while searching for the command token.
    if (token.startsWith("-")) {
      continue;
    }

    // Replace only the command token and preserve all surrounding arguments.
    if (token === "all") {
      return [...argv.slice(0, i), "run", "--all", ...argv.slice(i + 1)];
    }

    if (token === "migrate" && argv[i + 1] === "down") {
      const maybeCount = argv[i + 2];
      if (typeof maybeCount === "string" && /^\d+$/.test(maybeCount)) {
        return [...argv.slice(0, i), "undo", "--last", maybeCount, ...argv.slice(i + 3)];
      }

      return [...argv.slice(0, i), "undo", ...argv.slice(i + 2)];
    }

    // Stop after the first positional token once a non-alias command is found.
    break;
  }

  return argv;
}

/**
 * Resolves the effective invocation command from raw CLI arguments.
 *
 * Global `--config-dir` options are ignored so the returned value reflects the
 * command being executed rather than option values.
 */
export function resolveInvocationCommand(argv: string[]): string {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    // Stop scanning once option parsing should end.
    if (token === "--") {
      break;
    }

    // Skip the next token because it is consumed as the config-dir value.
    if (token === "--config-dir") {
      index += 1;
      continue;
    }

    // Ignore inline config-dir assignments.
    if (token.startsWith("--config-dir=")) {
      continue;
    }

    // The first positional token is treated as the command.
    if (!token.startsWith("-")) {
      return token;
    }
  }

  // Default command name used when no explicit command token is provided.
  return "rundown";
}

/**
 * Terminates CLI execution with the provided exit code.
 *
 * In test mode, throws a typed signal instead of exiting the process.
 */
export function terminate(code: number): never {
  // Allow tests to assert termination behavior without ending the process.
  if (process.env[EXIT_TEST_MODE_ENV] === "1") {
    throw new CliExitSignal(code);
  }

  process.exit(code);
}

/**
 * Determines whether an unknown error value represents a CLI exit signal.
 */
export function isCliExitSignal(error: unknown): error is CliExitSignal {
  // Preserve fast-path support for real class instances.
  if (error instanceof CliExitSignal) {
    return true;
  }

  // Reject non-object values before property probing.
  if (typeof error !== "object" || error === null) {
    return false;
  }

  // Support structural checks across process and module boundaries.
  const maybeCode = (error as { code?: unknown }).code;
  const maybeMessage = (error as { message?: unknown }).message;

  return typeof maybeCode === "number"
    && Number.isInteger(maybeCode)
    && typeof maybeMessage === "string"
    && maybeMessage.startsWith("CLI exited with code ");
}
