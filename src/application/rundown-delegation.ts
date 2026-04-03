import type { FileSystem, PathOperationsPort } from "../domain/ports/index.js";
import { hasLongOption, hasLongOptionVariant } from "./run-task-utils.js";

/**
 * Parent-run options that can be inherited by a delegated rundown invocation.
 */
export interface DelegatedRundownArgsOptions {
  parentWorkerCommand: string[];
  parentTransport: string;
  parentKeepArtifacts: boolean;
  parentShowAgentOutput: boolean;
  parentIgnoreCliBlock: boolean;
  parentVerify: boolean;
  parentNoRepair: boolean;
  parentRepairAttempts: number;
}

export type DelegatedRundownSubcommand = "run" | "make";

export interface ParsedDelegatedRundownInvocation {
  subcommand: DelegatedRundownSubcommand;
  args: string[];
  isExplicitSubcommand: boolean;
  unsupportedSubcommand?: string;
}

export interface DelegatedRundownValidationResult {
  valid: boolean;
  errorMessage?: string;
}

const SUPPORTED_DELEGATED_RUNDOWN_SUBCOMMANDS = new Set<DelegatedRundownSubcommand>([
  "run",
  "make",
]);

const KNOWN_RUNDOWN_COMMANDS = new Set<string>([
  "run",
  "make",
  "init",
  "intro",
  "research",
  "plan",
  "discuss",
  "reverify",
  "revert",
  "next",
  "list",
  "unlock",
  "artifacts",
  "log",
]);

/**
 * Parses raw delegated rundown arguments and applies compatibility normalization.
 */
export function parseRundownTaskArgs(rundownArgs: string | undefined): string[] {
  if (!rundownArgs) {
    return [];
  }

  return normalizeLegacyRetryArgs(tokenizeRundownArgs(rundownArgs));
}

/**
 * Tokenizes delegated rundown args while preserving quoted operand groups.
 */
function tokenizeRundownArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  let hasCurrentToken = false;

  const pushCurrentToken = (): void => {
    if (!hasCurrentToken) {
      return;
    }

    tokens.push(current);
    current = "";
    hasCurrentToken = false;
  };

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
        hasCurrentToken = true;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      hasCurrentToken = true;
      continue;
    }

    if (/\s/.test(char)) {
      pushCurrentToken();
      continue;
    }

    current += char;
    hasCurrentToken = true;
  }

  pushCurrentToken();
  return tokens;
}

/**
 * Resolves the delegated inline rundown invocation command.
 *
 * Supported explicit subcommands are `run` and `make`. All other forms are
 * treated as the legacy implicit-`run` syntax.
 */
export function resolveDelegatedRundownInvocation(args: string[]): ParsedDelegatedRundownInvocation {
  const [firstArg, ...remainingArgs] = args;
  if (firstArg && SUPPORTED_DELEGATED_RUNDOWN_SUBCOMMANDS.has(firstArg as DelegatedRundownSubcommand)) {
    return {
      subcommand: firstArg as DelegatedRundownSubcommand,
      args: remainingArgs,
      isExplicitSubcommand: true,
    };
  }

  if (firstArg && KNOWN_RUNDOWN_COMMANDS.has(firstArg)) {
    return {
      subcommand: "run",
      args: remainingArgs,
      isExplicitSubcommand: true,
      unsupportedSubcommand: firstArg,
    };
  }

  return {
    subcommand: "run",
    args,
    isExplicitSubcommand: false,
  };
}

/**
 * Validates delegated rundown invocation operands using subcommand-specific rules.
 */
export function validateDelegatedRundownInvocation(
  invocation: ParsedDelegatedRundownInvocation,
): DelegatedRundownValidationResult {
  if (invocation.unsupportedSubcommand) {
    return {
      valid: false,
      errorMessage: "Unsupported delegated rundown subcommand `"
        + invocation.unsupportedSubcommand
        + "`. Supported inline subcommands: run, make.",
    };
  }

  if (invocation.subcommand === "run") {
    if (!resolveDelegatedRundownTargetArg(invocation.args)) {
      const example = invocation.isExplicitSubcommand
        ? "rundown: run Child.md --verify"
        : "rundown: Child.md --verify";
      return {
        valid: false,
        errorMessage: "Rundown task requires a source operand before any flags (example: " + example + ").",
      };
    }

    return { valid: true };
  }

  const [seedTextArg, markdownFileArg] = invocation.args;
  if (!seedTextArg || seedTextArg.startsWith("-") || !markdownFileArg || markdownFileArg.startsWith("-")) {
    return {
      valid: false,
      errorMessage: "Rundown task delegated `make` requires <seed-text> and <markdown-file> operands (example: rundown: make \"Feature text\" \"3. Feature.md\").",
    };
  }

  if (!/\.(md|markdown)$/i.test(markdownFileArg)) {
    return {
      valid: false,
      errorMessage: "Rundown task delegated `make` requires a Markdown <markdown-file> operand (.md or .markdown).",
    };
  }

  return { valid: true };
}

/**
 * Parses and validates delegated rundown arguments in one step.
 */
export function validateRundownTaskArgs(rundownArgs: string | undefined): DelegatedRundownValidationResult {
  const parsedArgs = parseRundownTaskArgs(rundownArgs);
  const invocation = resolveDelegatedRundownInvocation(parsedArgs);
  return validateDelegatedRundownInvocation(invocation);
}

/**
 * Merges explicit delegated arguments with inherited parent run defaults.
 */
export function buildDelegatedRundownArgs(
  subcommand: DelegatedRundownSubcommand,
  args: string[],
  options: DelegatedRundownArgsOptions,
): string[] {
  const delegated: string[] = [...args];
  const isRun = subcommand === "run";

  if (!hasLongOption(delegated, "--worker") && options.parentWorkerCommand.length > 0) {
    delegated.push("--worker", ...options.parentWorkerCommand);
  }

  if (!hasLongOption(delegated, "--transport") && options.parentTransport.length > 0) {
    delegated.push("--transport", options.parentTransport);
  }

  if (!hasLongOption(delegated, "--keep-artifacts") && options.parentKeepArtifacts) {
    delegated.push("--keep-artifacts");
  }

  if (!hasLongOptionVariant(delegated, ["--show-agent-output", "--no-show-agent-output"]) && options.parentShowAgentOutput) {
    delegated.push("--show-agent-output");
  }

  if (!hasLongOption(delegated, "--ignore-cli-block") && options.parentIgnoreCliBlock) {
    delegated.push("--ignore-cli-block");
  }

  if (isRun && !hasLongOptionVariant(delegated, ["--verify", "--no-verify"])) {
    delegated.push(options.parentVerify ? "--verify" : "--no-verify");
  }

  // Preserve explicit child repair settings before inheriting the parent value.
  if (isRun && !hasLongOption(delegated, "--no-repair") && !hasLongOptionVariant(delegated, ["--repair-attempts", "--retries"]) && options.parentNoRepair) {
    delegated.push("--no-repair");
  }

  if (
    isRun
    &&
    !hasLongOptionVariant(delegated, ["--repair-attempts", "--retries"])
    && !hasLongOption(delegated, "--no-repair")
    && !options.parentNoRepair
  ) {
    const normalizedAttempts = Math.max(0, Math.floor(options.parentRepairAttempts));
    delegated.push("--repair-attempts", String(normalizedAttempts));
  }

  return delegated;
}

/**
 * Resolves the delegated target from positional arguments when present.
 */
export function resolveDelegatedRundownTargetArg(args: string[]): string | null {
  const candidate = args[0];
  if (!candidate || candidate.startsWith("-")) {
    return null;
  }

  return candidate;
}

/**
 * Checks whether a delegated target exists using absolute and task-relative forms.
 */
export function delegatedTargetExists(
  delegatedTarget: string,
  delegatedTargetArg: string,
  taskFile: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): boolean {
  // Probe both slash styles to handle mixed platform path inputs.
  const candidates = new Set<string>([
    delegatedTarget,
    delegatedTarget.replace(/\\/g, "/"),
    delegatedTarget.replace(/\//g, "\\"),
  ]);

  if (pathOperations.isAbsolute(delegatedTargetArg)) {
    candidates.add(delegatedTargetArg);
  } else {
    const taskRelativeTarget = pathOperations.join(
      pathOperations.dirname(taskFile),
      delegatedTargetArg,
    );
    candidates.add(taskRelativeTarget);
    candidates.add(taskRelativeTarget.replace(/\\/g, "/"));
    candidates.add(taskRelativeTarget.replace(/\//g, "\\"));
  }

  for (const candidate of candidates) {
    if (fileSystem.exists(candidate)) {
      return true;
    }
  }

  return false;
}

/**
 * Converts legacy `--retries` flags into `--repair-attempts` equivalents.
 */
export function normalizeLegacyRetryArgs(args: string[]): string[] {
  const normalized: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--retries") {
      normalized.push("--repair-attempts");
      const nextArg = args[index + 1];
      if (typeof nextArg === "string") {
        normalized.push(nextArg);
        index += 1;
      }
      continue;
    }

    if (arg.startsWith("--retries=")) {
      normalized.push("--repair-attempts=" + arg.slice("--retries=".length));
      continue;
    }

    normalized.push(arg);
  }

  return normalized;
}
