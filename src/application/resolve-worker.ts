import { extractFrontmatter, type Task } from "../domain/parser.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import {
  extractProfileFromSubItems,
  resolveWorkerConfig,
  type WorkerConfig,
  type WorkerConfigCommandName,
  type WorkerProfile,
} from "../domain/worker-config.js";
import type { TaskIntent } from "../domain/task-intent.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

/**
 * Input contract used to resolve the effective worker command for one invocation.
 */
interface ResolveWorkerForInvocationInput {
  commandName: WorkerConfigCommandName;
  workerConfig: WorkerConfig | undefined;
  source: string;
  task?: Pick<Task, "directiveProfile" | "taskProfile" | "subItems">;
  cliWorkerCommand: string[];
  fallbackWorkerCommand?: string[];
  emit?: ApplicationOutputPort["emit"];
  taskIntent?: TaskIntent;
  toolName?: string;
}

interface ResolveWorkerPatternForInvocationInput {
  commandName: WorkerConfigCommandName;
  workerConfig: WorkerConfig | undefined;
  source: string;
  task?: Pick<Task, "directiveProfile" | "taskProfile" | "subItems">;
  cliWorkerPattern?: ParsedWorkerPattern;
  fallbackWorkerCommand?: string[];
  emit?: ApplicationOutputPort["emit"];
  taskIntent?: TaskIntent;
  toolName?: string;
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
 * Indicates whether a profile contributes any worker executable or argument values.
 */
function hasWorkerProfileValues(profile: WorkerProfile | undefined): boolean {
  if (!profile) {
    return false;
  }

  return (profile.worker?.length ?? 0) > 0 || (profile.workerArgs?.length ?? 0) > 0;
}

/**
 * Describes which configuration source selected the resolved worker command.
 */
function describeConfigResolutionSource(input: ResolveWorkerForInvocationInput, frontmatterProfile: string | undefined): string | undefined {
  const directiveProfile = normalizeProfileName(input.task?.directiveProfile);
  if (directiveProfile) {
    return `profile "${directiveProfile}" via directive`;
  }

  const normalizedFrontmatterProfile = normalizeProfileName(frontmatterProfile);
  if (normalizedFrontmatterProfile) {
    return `profile "${normalizedFrontmatterProfile}" via frontmatter`;
  }

  if (hasWorkerProfileValues(input.workerConfig?.commands?.[input.commandName])) {
    return `from config commands.${input.commandName}`;
  }

  if (hasWorkerProfileValues(input.workerConfig?.defaults)) {
    return "from config defaults";
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
  const frontmatterProfile = extractFrontmatter(input.source).profile;
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
  const resolvedWorker = resolveWorkerConfig(
    input.workerConfig,
    input.commandName,
    frontmatterProfile,
    input.task?.directiveProfile,
    supportsInlineTaskProfile ? input.task?.taskProfile : undefined,
    hasCliWorkerCommand ? input.cliWorkerCommand : undefined,
    intentCommandName,
  );
  const resolvedWorkerCommand = [...resolvedWorker.worker, ...resolvedWorker.workerArgs];
  if (resolvedWorkerCommand.length > 0) {
    // Emit source diagnostics only when CLI did not explicitly set the worker.
    if (!hasCliWorkerCommand && input.emit) {
      const sourceDescription = describeConfigResolutionSource(input, frontmatterProfile);
      if (sourceDescription) {
        input.emit({
          kind: "info",
          message: `Worker: ${resolvedWorkerCommand.join(" ")} (${sourceDescription})`,
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
    cliWorkerCommand,
    fallbackWorkerCommand: input.fallbackWorkerCommand,
    emit: input.emit,
    taskIntent: input.taskIntent,
    toolName: input.toolName,
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
