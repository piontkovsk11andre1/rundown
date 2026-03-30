import { extractFrontmatter, type Task } from "../domain/parser.js";
import {
  extractProfileFromSubItems,
  resolveWorkerConfig,
  type WorkerConfig,
  type WorkerProfile,
} from "../domain/worker-config.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

interface ResolveWorkerForInvocationInput {
  commandName: string;
  workerConfig: WorkerConfig | undefined;
  source: string;
  task?: Pick<Task, "directiveProfile" | "subItems">;
  cliWorkerCommand: string[];
  fallbackWorkerCommand?: string[];
  emit?: ApplicationOutputPort["emit"];
}

function buildIgnoredProfileSubItemWarning(profileName: string): string {
  return `"profile: ${profileName}" as a task sub-item is not supported — use it as a parent list item or in file frontmatter.`;
}

function normalizeProfileName(profileName: string | undefined): string | undefined {
  if (typeof profileName !== "string") {
    return undefined;
  }

  const trimmed = profileName.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function hasWorkerProfileValues(profile: WorkerProfile | undefined): boolean {
  if (!profile) {
    return false;
  }

  return (profile.worker?.length ?? 0) > 0 || (profile.workerArgs?.length ?? 0) > 0;
}

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

export function resolveWorkerForInvocation(input: ResolveWorkerForInvocationInput): string[] {
  const frontmatterProfile = extractFrontmatter(input.source).profile;
  const hasCliWorkerCommand = input.cliWorkerCommand.length > 0;
  const ignoredProfileSubItem = input.task
    ? extractProfileFromSubItems(input.task.subItems)
    : undefined;
  if (ignoredProfileSubItem && input.emit) {
    input.emit({
      kind: "warn",
      message: buildIgnoredProfileSubItemWarning(ignoredProfileSubItem),
    });
  }

  const resolvedWorker = resolveWorkerConfig(
    input.workerConfig,
    input.commandName,
    frontmatterProfile,
    input.task?.directiveProfile,
    hasCliWorkerCommand ? input.cliWorkerCommand : undefined,
  );
  const resolvedWorkerCommand = [...resolvedWorker.worker, ...resolvedWorker.workerArgs];
  if (resolvedWorkerCommand.length > 0) {
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

  if (input.fallbackWorkerCommand && input.fallbackWorkerCommand.length > 0) {
    return [...input.fallbackWorkerCommand];
  }

  return [];
}
