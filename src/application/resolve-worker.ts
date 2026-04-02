import { extractFrontmatter, type Task } from "../domain/parser.js";
import {
  extractProfileFromSubItems,
  resolveWorkerConfig,
  type WorkerConfig,
  type WorkerProfile,
} from "../domain/worker-config.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

/**
 * Input contract used to resolve the effective worker command for one invocation.
 */
interface ResolveWorkerForInvocationInput {
  commandName: string;
  workerConfig: WorkerConfig | undefined;
  source: string;
  task?: Pick<Task, "directiveProfile" | "subItems">;
  cliWorkerCommand: string[];
  fallbackWorkerCommand?: string[];
  emit?: ApplicationOutputPort["emit"];
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
  if (ignoredProfileSubItem && input.emit) {
    input.emit({
      kind: "warn",
      message: buildIgnoredProfileSubItemWarning(ignoredProfileSubItem),
    });
  }

  // Resolve worker/profile configuration with CLI override precedence.
  const resolvedWorker = resolveWorkerConfig(
    input.workerConfig,
    input.commandName,
    frontmatterProfile,
    input.task?.directiveProfile,
    hasCliWorkerCommand ? input.cliWorkerCommand : undefined,
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
