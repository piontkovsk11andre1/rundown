import { extractFrontmatter, type Task } from "../domain/parser.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import {
  extractProfileFromSubItems,
  resolveWorkerConfig,
  type WorkerConfig,
  type WorkerConfigCommandName,
  type WorkerCommand,
} from "../domain/worker-config.js";
import type { TaskIntent } from "../domain/task-intent.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ProcessRunMode } from "../domain/ports/process-runner.js";

/**
 * Input contract used to resolve the effective worker command for one invocation.
 */
interface ResolveWorkerForInvocationInput {
  commandName: WorkerConfigCommandName;
  workerConfig: WorkerConfig | undefined;
  source?: string;
  task?: Pick<Task, "directiveProfile" | "taskProfile" | "subItems">;
  modifierProfile?: string;
  cliWorkerCommand: string[];
  fallbackWorkerCommand?: string[];
  emit?: ApplicationOutputPort["emit"];
  verbose?: boolean;
  taskIntent?: TaskIntent;
  toolName?: string;
  mode?: ProcessRunMode;
}

interface ResolveWorkerPatternForInvocationInput {
  commandName: WorkerConfigCommandName;
  workerConfig: WorkerConfig | undefined;
  source?: string;
  task?: Pick<Task, "directiveProfile" | "taskProfile" | "subItems">;
  modifierProfile?: string;
  cliWorkerPattern?: ParsedWorkerPattern;
  fallbackWorkerCommand?: string[];
  emit?: ApplicationOutputPort["emit"];
  verbose?: boolean;
  taskIntent?: TaskIntent;
  toolName?: string;
  mode?: ProcessRunMode;
}

interface ResolvedWorkerInvocation {
  workerCommand: string[];
  workerPattern: ParsedWorkerPattern;
}

/**
 * Builds the warning shown when `profile:` appears in unsupported sub-item context.
 */
function buildIgnoredProfileSubItemWarning(profileName: string): string {
  return `"profile: ${profileName}" as a task sub-item is not supported — use it as a parent list item or in file frontmatter.`;
}

/**
 * Trims profile names and treats empty/non-string values as missing.
 */
function normalizeProfileName(profileName: string | undefined): string | undefined {
  if (typeof profileName !== "string") {
    return undefined;
  }

  const trimmed = profileName.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Indicates whether a worker command has any tokens.
 */
function hasWorkerCommandValues(command: WorkerCommand | undefined): boolean {
  return (command?.length ?? 0) > 0;
}

/**
 * Describes which configuration source selected the resolved worker command.
 */
function describeConfigResolutionSource(input: ResolveWorkerForInvocationInput, frontmatterProfile: string | undefined): string | undefined {
  const modifierProfile = normalizeProfileName(input.modifierProfile);
  if (modifierProfile) {
    return `profile "${modifierProfile}" via prefix modifier`;
  }

  const directiveProfile = normalizeProfileName(input.task?.directiveProfile);
  if (directiveProfile) {
    return `profile "${directiveProfile}" via directive`;
  }

  const normalizedFrontmatterProfile = normalizeProfileName(frontmatterProfile);
  if (normalizedFrontmatterProfile) {
    return `profile "${normalizedFrontmatterProfile}" via frontmatter`;
  }

  if (hasWorkerCommandValues(input.workerConfig?.commands?.[input.commandName])) {
    return `from config commands.${input.commandName}`;
  }

  if (input.mode === "tui" && hasWorkerCommandValues(input.workerConfig?.workers?.tui)) {
    return "from config workers.tui";
  }

  if (hasWorkerCommandValues(input.workerConfig?.workers?.default)) {
    return "from config workers.default";
  }

  return undefined;
}

/**
 * Resolves the worker command used for command execution.
 *
 * Resolution priority is CLI worker override, then configured profile/defaults,
 * then optional fallback command from previously saved runtime metadata.
 */
export function resolveWorkerForInvocation(input: ResolveWorkerForInvocationInput): string[] {
  const source = typeof input.source === "string" ? input.source : "";
  const frontmatterProfile = extractFrontmatter(source).profile;
  const hasCliWorkerCommand = input.cliWorkerCommand.length > 0;
  // Detect unsupported profile declarations inside task sub-items and warn once.
  const ignoredProfileSubItem = input.task
    ? extractProfileFromSubItems(input.task.subItems)
    : undefined;
  const supportsInlineTaskProfile = input.taskIntent === "verify-only"
    || input.taskIntent === "memory-capture"
    || input.taskIntent === "tool-expansion";
  if (ignoredProfileSubItem && input.emit && !supportsInlineTaskProfile) {
    input.emit({
      kind: "warn",
      message: buildIgnoredProfileSubItemWarning(ignoredProfileSubItem),
    });
  }

  // Map task intent to the corresponding commands.{intent} config key, when applicable.
  const intentCommandName: WorkerConfigCommandName | undefined = input.taskIntent === "verify-only"
    ? "verify"
    : input.taskIntent === "memory-capture"
    ? "memory"
    : input.taskIntent === "tool-expansion" && input.toolName
    ? `tools.${input.toolName}`
    : undefined;

  // Resolve worker/profile configuration with CLI override precedence.
  const resolvedWorkerCommand = resolveWorkerConfig(
    input.workerConfig,
    input.commandName,
    frontmatterProfile,
    input.task?.directiveProfile,
    normalizeProfileName(input.modifierProfile)
      ?? (supportsInlineTaskProfile ? input.task?.taskProfile : undefined),
    hasCliWorkerCommand ? input.cliWorkerCommand : undefined,
    intentCommandName,
    input.mode,
  );
  if (resolvedWorkerCommand.length > 0) {
    // Emit source diagnostics only in verbose mode when CLI did not explicitly set the worker.
    if (input.verbose && !hasCliWorkerCommand && input.emit) {
      const sourceDescription = describeConfigResolutionSource(input, frontmatterProfile);
      const workerCommandLabel = resolvedWorkerCommand.join(" ");
      if (workerCommandLabel.length > 0) {
        const verboseSourceDescription = input.verbose && sourceDescription
          ? ` (${sourceDescription})`
          : "";
        input.emit({
          kind: "info",
          message: `${workerCommandLabel}${verboseSourceDescription}`,
        });
      }
    }
    return resolvedWorkerCommand;
  }

  // Fall back to previously captured worker command when available.
  if (input.fallbackWorkerCommand && input.fallbackWorkerCommand.length > 0) {
    return [...input.fallbackWorkerCommand];
  }

  // Return an empty command so callers can handle missing-worker errors consistently.
  return [];
}

function buildParsedWorkerPattern(command: string[]): ParsedWorkerPattern {
  const usesBootstrap = command.some((token) => token.includes("$bootstrap"));
  const usesFile = command.some((token) => token.includes("$file"));

  return {
    command: [...command],
    usesBootstrap,
    usesFile,
    appendFile: !usesBootstrap && !usesFile,
  };
}

/**
 * Resolves the worker command and parsed pattern used for command execution.
 */
export function resolveWorkerPatternForInvocation(
  input: ResolveWorkerPatternForInvocationInput,
): ResolvedWorkerInvocation {
  const cliWorkerCommand = input.cliWorkerPattern?.command ?? [];
  const resolvedWorkerCommand = resolveWorkerForInvocation({
    commandName: input.commandName,
    workerConfig: input.workerConfig,
    source: input.source,
    task: input.task,
    modifierProfile: input.modifierProfile,
    cliWorkerCommand,
    fallbackWorkerCommand: input.fallbackWorkerCommand,
    emit: input.emit,
    verbose: input.verbose,
    taskIntent: input.taskIntent,
    toolName: input.toolName,
    mode: input.mode,
  });

  if (resolvedWorkerCommand.length === 0) {
    return {
      workerCommand: [],
      workerPattern: {
        command: [],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
    };
  }

  const cliWorkerPattern = input.cliWorkerPattern;
  const resolvedFromCliPattern = cliWorkerPattern
    && resolvedWorkerCommand.length === cliWorkerPattern.command.length
    && resolvedWorkerCommand.every((token, index) => token === cliWorkerPattern.command[index]);

  const workerPattern = resolvedFromCliPattern && cliWorkerPattern
    ? {
      command: [...cliWorkerPattern.command],
      usesBootstrap: cliWorkerPattern.usesBootstrap,
      usesFile: cliWorkerPattern.usesFile,
      appendFile: cliWorkerPattern.appendFile,
    }
    : buildParsedWorkerPattern(resolvedWorkerCommand);

  return {
    workerCommand: resolvedWorkerCommand,
    workerPattern,
  };
}
