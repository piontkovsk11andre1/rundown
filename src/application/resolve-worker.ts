import { extractFrontmatter, type Task } from "../domain/parser.js";
import type { ParsedWorkerPattern } from "../domain/worker-pattern.js";
import {
  extractProfileFromSubItems,
  type RunAttemptScopedWorkerRoutingConfig,
  type RunWorkerRouteConfig,
  type RunWorkerRoutingPhase,
  resolveWorkerConfig,
  type WorkerConfig,
  type WorkerConfigCommandName,
  type WorkerCommand,
} from "../domain/worker-config.js";
import type { TaskIntent } from "../domain/task-intent.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ProcessRunMode } from "../domain/ports/process-runner.js";
import type {
  WorkerHealthEntry,
  WorkerProfileEligibilityEvaluation,
} from "../domain/worker-health.js";
import {
  buildWorkerHealthProfileKey,
  buildWorkerHealthWorkerKey,
  evaluateWorkerProfileEligibility,
  normalizeWorkerHealthKey,
} from "../domain/worker-health.js";

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
  workerHealthEntries?: readonly WorkerHealthEntry[];
  evaluateWorkerHealthAtMs?: number;
  runWorkerPhase?: RunWorkerRoutingPhase;
  runWorkerAttempt?: number;
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
  workerHealthEntries?: readonly WorkerHealthEntry[];
  evaluateWorkerHealthAtMs?: number;
  runWorkerPhase?: RunWorkerRoutingPhase;
  runWorkerAttempt?: number;
}

interface ResolvedPhaseRoute {
  route: RunWorkerRouteConfig;
  sourceDescription: string;
}

interface ResolvedWorkerCandidate {
  workerCommand: string[];
  source: "primary" | "configured-fallback" | "runtime-fallback";
  fallbackIndex?: number;
  eligibility: WorkerProfileEligibilityEvaluation;
}

interface ResolveWorkerSelection {
  workerCommand: string[];
  candidates: ResolvedWorkerCandidate[];
  selectedCandidateIndex: number;
  effectiveProfileName?: string;
}

export interface WorkerResolutionCandidateSnapshot {
  workerCommand: string[];
  source: ResolvedWorkerCandidate["source"];
  fallbackIndex?: number;
  eligibility: WorkerProfileEligibilityEvaluation;
}

export interface WorkerResolutionSnapshot {
  workerCommand: string[];
  candidates: WorkerResolutionCandidateSnapshot[];
  selectedCandidateIndex: number;
  effectiveProfileName?: string;
}

interface ResolvedWorkerInvocation {
  workerCommand: string[];
  workerPattern: ParsedWorkerPattern;
  selectedProfileName?: string;
}

/**
 * Builds the warning shown when `profile=` appears in unsupported sub-item context.
 */
function buildIgnoredProfileSubItemWarning(profileName: string): string {
  return `"profile=${profileName}" as a task sub-item is not supported — use it as a parent list item or in file frontmatter.`;
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

function buildWorkerHealthIndex(entries: readonly WorkerHealthEntry[] | undefined): Map<string, WorkerHealthEntry> {
  const index = new Map<string, WorkerHealthEntry>();
  for (const entry of entries ?? []) {
    const key = normalizeWorkerHealthKey(entry.source, entry.key);
    if (key.length > 0) {
      index.set(key, entry);
    }
  }
  return index;
}

function areCommandsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

function resolveEffectiveProfileName(
  input: ResolveWorkerForInvocationInput,
  frontmatterProfile: string | undefined,
  supportsInlineTaskProfile: boolean,
): string | undefined {
  return normalizeProfileName(input.modifierProfile)
    ?? (supportsInlineTaskProfile ? normalizeProfileName(input.task?.taskProfile) : undefined)
    ?? normalizeProfileName(input.task?.directiveProfile)
    ?? normalizeProfileName(frontmatterProfile);
}

function buildWorkerCandidates(
  primaryWorkerCommand: string[],
  input: ResolveWorkerForInvocationInput,
  options?: {
    includeConfiguredFallbacks?: boolean;
    includeRuntimeFallback?: boolean;
  },
): Array<Pick<ResolvedWorkerCandidate, "workerCommand" | "source" | "fallbackIndex">> {
  const candidates: Array<Pick<ResolvedWorkerCandidate, "workerCommand" | "source" | "fallbackIndex">> = [];
  const seenKeys = new Set<string>();
  const includeConfiguredFallbacks = options?.includeConfiguredFallbacks ?? true;
  const includeRuntimeFallback = options?.includeRuntimeFallback ?? true;

  const pushCandidate = (
    workerCommand: string[] | undefined,
    source: ResolvedWorkerCandidate["source"],
    fallbackIndex?: number,
  ): void => {
    if (!workerCommand || workerCommand.length === 0) {
      return;
    }

    const key = buildWorkerHealthWorkerKey(workerCommand);
    if (seenKeys.has(key)) {
      return;
    }

    seenKeys.add(key);
    candidates.push({
      workerCommand: [...workerCommand],
      source,
      fallbackIndex,
    });
  };

  pushCandidate(primaryWorkerCommand, "primary");
  if (includeConfiguredFallbacks) {
    input.workerConfig?.workers?.fallbacks?.forEach((fallbackCommand, index) => {
      pushCandidate(fallbackCommand, "configured-fallback", index + 1);
    });
  }

  if (includeRuntimeFallback && primaryWorkerCommand.length === 0) {
    pushCandidate(input.fallbackWorkerCommand, "runtime-fallback");
  }

  return candidates;
}

/**
 * Describes which configuration source selected the resolved worker command.
 */
function describeConfigResolutionSource(input: ResolveWorkerForInvocationInput, frontmatterProfile: string | undefined): string | undefined {
  const modifierProfile = normalizeProfileName(input.modifierProfile);
  if (modifierProfile) {
    return `profile=${modifierProfile} via prefix modifier`;
  }

  const directiveProfile = normalizeProfileName(input.task?.directiveProfile);
  if (directiveProfile) {
    return `profile=${directiveProfile} via directive`;
  }

  const normalizedFrontmatterProfile = normalizeProfileName(frontmatterProfile);
  if (normalizedFrontmatterProfile) {
    return `profile=${normalizedFrontmatterProfile} via frontmatter`;
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

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return undefined;
  }

  return value;
}

function selectAttemptScopedRoute(
  routeConfig: RunAttemptScopedWorkerRoutingConfig | undefined,
  attempt: number | undefined,
  sourcePrefix: string,
): ResolvedPhaseRoute | undefined {
  if (!routeConfig) {
    return undefined;
  }

  const normalizedAttempt = normalizePositiveInteger(attempt);
  for (let index = 0; index < (routeConfig.attempts?.length ?? 0); index += 1) {
    const attemptRoute = routeConfig.attempts?.[index];
    if (!attemptRoute) {
      continue;
    }

    const selector = attemptRoute.selector;
    const match = selector.attempt !== undefined
      ? normalizedAttempt !== undefined && selector.attempt === normalizedAttempt
      : normalizedAttempt !== undefined
      && (selector.fromAttempt === undefined || normalizedAttempt >= selector.fromAttempt)
      && (selector.toAttempt === undefined || normalizedAttempt <= selector.toAttempt);

    if (match) {
      return {
        route: attemptRoute,
        sourceDescription: `${sourcePrefix}.attempts[${index}]`,
      };
    }
  }

  if (routeConfig.default) {
    return {
      route: routeConfig.default,
      sourceDescription: `${sourcePrefix}.default`,
    };
  }

  return undefined;
}

function resolveRunWorkerPhaseRoute(input: ResolveWorkerForInvocationInput): ResolvedPhaseRoute | undefined {
  const phase = input.runWorkerPhase;
  if (!phase) {
    return undefined;
  }

  const workerRouting = input.workerConfig?.run?.workerRouting;
  if (!workerRouting) {
    return undefined;
  }

  if (phase === "repair") {
    return selectAttemptScopedRoute(workerRouting.repair, input.runWorkerAttempt, "run.workerRouting.repair");
  }

  if (phase === "resolveRepair") {
    return selectAttemptScopedRoute(workerRouting.resolveRepair, input.runWorkerAttempt, "run.workerRouting.resolveRepair");
  }

  const route = phase === "execute"
    ? workerRouting.execute
    : phase === "verify"
    ? workerRouting.verify
    : phase === "resolve"
    ? workerRouting.resolve
    : workerRouting.reset;

  if (!route) {
    return undefined;
  }

  return {
    route,
    sourceDescription: `run.workerRouting.${phase}`,
  };
}

/**
 * Resolves the worker command used for command execution.
 *
 * Resolution priority is CLI worker override, then configured profile/defaults,
 * then optional fallback command from previously saved runtime metadata.
 */
export function resolveWorkerForInvocation(input: ResolveWorkerForInvocationInput): string[] {
  const selection = resolveWorkerSelectionForInvocation(input);
  return selection.workerCommand;
}

function resolveWorkerSelectionForInvocation(input: ResolveWorkerForInvocationInput): ResolveWorkerSelection {
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

  const resolvedPhaseRoute = resolveRunWorkerPhaseRoute(input);
  const hasExplicitPhaseWorker = (resolvedPhaseRoute?.route.worker?.length ?? 0) > 0;
  const usesExplicitPhaseWorker = hasExplicitPhaseWorker && !hasCliWorkerCommand;
  const includeConfiguredFallbacks = usesExplicitPhaseWorker
    ? resolvedPhaseRoute?.route.useFallbacks === true
    : true;

  // Resolve worker/profile configuration with CLI override precedence.
  const resolvedWorkerCommand = hasCliWorkerCommand
    ? resolveWorkerConfig(
      input.workerConfig,
      input.commandName,
      frontmatterProfile,
      input.task?.directiveProfile,
      normalizeProfileName(input.modifierProfile)
        ?? (supportsInlineTaskProfile ? input.task?.taskProfile : undefined),
      input.cliWorkerCommand,
      intentCommandName,
      input.mode,
    )
    : hasExplicitPhaseWorker
    ? [...(resolvedPhaseRoute?.route.worker ?? [])]
    : resolveWorkerConfig(
      input.workerConfig,
      input.commandName,
      frontmatterProfile,
      input.task?.directiveProfile,
      normalizeProfileName(input.modifierProfile)
        ?? (supportsInlineTaskProfile ? input.task?.taskProfile : undefined),
      undefined,
      intentCommandName,
      input.mode,
    );

  const candidates = buildWorkerCandidates(resolvedWorkerCommand, input, {
    includeConfiguredFallbacks,
    includeRuntimeFallback: !usesExplicitPhaseWorker,
  });
  const healthIndex = buildWorkerHealthIndex(input.workerHealthEntries);
  const effectiveProfileName = usesExplicitPhaseWorker
    ? undefined
    : resolveEffectiveProfileName(input, frontmatterProfile, supportsInlineTaskProfile);
  const profileHealthEntry = effectiveProfileName
    ? healthIndex.get(buildWorkerHealthProfileKey(effectiveProfileName))
    : undefined;
  const nowMs = input.evaluateWorkerHealthAtMs;
  const evaluatedCandidates: ResolvedWorkerCandidate[] = candidates.map((candidate) => {
    const workerHealthEntry = healthIndex.get(buildWorkerHealthWorkerKey(candidate.workerCommand));
    const eligibility = evaluateWorkerProfileEligibility(workerHealthEntry, profileHealthEntry, nowMs);
    return {
      workerCommand: candidate.workerCommand,
      source: candidate.source,
      fallbackIndex: candidate.fallbackIndex,
      eligibility,
    };
  });

  const forcePrimarySelection = usesExplicitPhaseWorker && !includeConfiguredFallbacks;
  const selectedCandidateIndex = forcePrimarySelection && evaluatedCandidates.length > 0
    ? 0
    : evaluatedCandidates.findIndex((candidate) => candidate.eligibility.eligible);
  const selectedCandidate = selectedCandidateIndex >= 0
    ? evaluatedCandidates[selectedCandidateIndex]
    : undefined;
  const selectedWorkerCommand = selectedCandidate
    ? [...selectedCandidate.workerCommand]
    : [];

  if (input.verbose && input.emit && selectedCandidate) {
    const sourceDescription = describeConfigResolutionSource(input, frontmatterProfile);
    const resolvedSourceDescription = usesExplicitPhaseWorker
      ? `from ${resolvedPhaseRoute?.sourceDescription}`
      : sourceDescription;
    const selectedCommandLabel = selectedCandidate.workerCommand.join(" ");
    if (selectedCommandLabel.length > 0) {
      if (selectedCandidate.source === "primary" && !hasCliWorkerCommand) {
        const verboseSourceDescription = resolvedSourceDescription
          ? ` (${resolvedSourceDescription})`
          : "";
        input.emit({
          kind: "info",
          message: `${selectedCommandLabel}${verboseSourceDescription}`,
        });
      } else if (selectedCandidate.source === "configured-fallback") {
        input.emit({
          kind: "info",
          message: `${selectedCommandLabel} (fallback #${selectedCandidate.fallbackIndex ?? 1} from config workers.fallbacks)`,
        });
      }
    }

    for (const candidate of evaluatedCandidates) {
      if (candidate.eligibility.eligible || areCommandsEqual(candidate.workerCommand, selectedWorkerCommand)) {
        continue;
      }

      const blockedBy = candidate.eligibility.blockedBy.join("+");
      const nextEligibleSuffix = candidate.eligibility.nextEligibleAt
        ? `, next eligible at ${candidate.eligibility.nextEligibleAt}`
        : "";
      input.emit({
        kind: "info",
        message: `Skipping ineligible worker candidate: ${candidate.workerCommand.join(" ")} (blocked by ${blockedBy}${nextEligibleSuffix})`,
      });
    }
  }

  return {
    workerCommand: selectedWorkerCommand,
    candidates: evaluatedCandidates,
    selectedCandidateIndex,
    effectiveProfileName,
  };
}

/**
 * Resolves worker selection details, including fallback candidate eligibility.
 */
export function resolveWorkerSelectionSnapshotForInvocation(
  input: ResolveWorkerForInvocationInput,
): WorkerResolutionSnapshot {
  const selection = resolveWorkerSelectionForInvocation(input);
  return {
    workerCommand: [...selection.workerCommand],
    selectedCandidateIndex: selection.selectedCandidateIndex,
    candidates: selection.candidates.map((candidate) => ({
      workerCommand: [...candidate.workerCommand],
      source: candidate.source,
      fallbackIndex: candidate.fallbackIndex,
      eligibility: candidate.eligibility,
    })),
    ...(selection.effectiveProfileName ? { effectiveProfileName: selection.effectiveProfileName } : {}),
  };
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
  const selection = resolveWorkerSelectionForInvocation({
    commandName: input.commandName,
    workerConfig: input.workerConfig,
    source: input.source,
    task: input.task,
    modifierProfile: input.modifierProfile,
    cliWorkerCommand: input.cliWorkerPattern?.command ?? [],
    fallbackWorkerCommand: input.fallbackWorkerCommand,
    emit: input.emit,
    verbose: input.verbose,
    taskIntent: input.taskIntent,
    toolName: input.toolName,
    mode: input.mode,
    workerHealthEntries: input.workerHealthEntries,
    evaluateWorkerHealthAtMs: input.evaluateWorkerHealthAtMs,
    runWorkerPhase: input.runWorkerPhase,
    runWorkerAttempt: input.runWorkerAttempt,
  });
  const resolvedWorkerCommand = selection.workerCommand;
  const selectedProfileName = selection.effectiveProfileName;

  if (resolvedWorkerCommand.length === 0) {
    return {
      workerCommand: [],
      workerPattern: {
        command: [],
        usesBootstrap: false,
        usesFile: false,
        appendFile: true,
      },
      ...(selectedProfileName ? { selectedProfileName } : {}),
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
    ...(selectedProfileName ? { selectedProfileName } : {}),
  };
}
