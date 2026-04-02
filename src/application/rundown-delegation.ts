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

/**
 * Parses raw delegated rundown arguments and applies compatibility normalization.
 */
export function parseRundownTaskArgs(rundownArgs: string | undefined): string[] {
  if (!rundownArgs) {
    return [];
  }

  // Split on whitespace to preserve CLI-style token parsing.
  return normalizeLegacyRetryArgs(rundownArgs
    .trim()
    .split(/\s+/)
    .filter((value) => value.length > 0));
}

/**
 * Merges explicit delegated arguments with inherited parent run defaults.
 */
export function buildDelegatedRundownArgs(
  args: string[],
  options: DelegatedRundownArgsOptions,
): string[] {
  const delegated: string[] = [...args];

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

  if (!hasLongOptionVariant(delegated, ["--verify", "--no-verify"])) {
    delegated.push(options.parentVerify ? "--verify" : "--no-verify");
  }

  // Preserve explicit child repair settings before inheriting the parent value.
  if (!hasLongOption(delegated, "--no-repair") && !hasLongOptionVariant(delegated, ["--repair-attempts", "--retries"]) && options.parentNoRepair) {
    delegated.push("--no-repair");
  }

  if (
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
