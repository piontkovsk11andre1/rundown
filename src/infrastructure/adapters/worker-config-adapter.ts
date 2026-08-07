import fs from "node:fs";
import path from "node:path";
import {
  resolveGlobalConfigPath,
  type GlobalConfigPathResolution,
} from "./global-config-path-adapter.js";
import type { WorkerConfigPort } from "../../domain/ports/worker-config-port.js";
import {
  DEFAULT_TRACE_STATISTICS_FIELDS,
  RUN_COMMIT_MODES,
  TRACE_STATISTICS_FIELD_REGISTRY,
  WORKER_HEALTH_POLICY_FALLBACK_STRATEGY_PRIORITY,
  WORKER_HEALTH_POLICY_FALLBACK_STRATEGY_STRICT_ORDER,
  WORKER_HEALTH_POLICY_UNAVAILABLE_REEVALUATION_COOLDOWN,
  WORKER_HEALTH_POLICY_UNAVAILABLE_REEVALUATION_MANUAL,
  type WorkerHealthPolicyConfig,
  type AutoCompactDefaultsConfig,
  type RunDefaultsConfig,
  type TraceStatisticsConfig,
  type FallbacksConfig,
  type WorkerCommand,
  type WorkerConfig,
  type WorkerConfigLoadWithSourcesResult,
  type WorkerConfigMutationResult,
  type WorkerConfigPathsResult,
  type WorkerConfigReadableScope,
  type WorkerConfigSetValueInput,
  type WorkerConfigUnsetValueInput,
  type WorkerConfigValueSource,
  type WorkerConfigValueSourceMap,
  type WorkerConfigWritableScope,
  type WorkersConfig,
} from "../../domain/worker-config.js";

const WORKER_CONFIG_FILE_NAME = "config.json";

interface CreateWorkerConfigAdapterOptions {
  readonly resolveGlobalConfigPath?: () => {
    discoveredPath: string | undefined;
    canonicalPath?: string | undefined;
  };
}

const FALLBACKS_DEFAULT_KEY = "default";

function normalizeGlobalResolution(
  resolution: {
    discoveredPath: string | undefined;
    canonicalPath?: string | undefined;
  } | GlobalConfigPathResolution,
): GlobalConfigPathResolution {
  if ("candidates" in resolution && Array.isArray(resolution.candidates)) {
    return resolution;
  }

  const candidates: string[] = [];
  if (resolution.canonicalPath) {
    candidates.push(resolution.canonicalPath);
  }
  if (resolution.discoveredPath && !candidates.includes(resolution.discoveredPath)) {
    candidates.push(resolution.discoveredPath);
  }

  return {
    canonicalPath: resolution.canonicalPath,
    discoveredPath: resolution.discoveredPath,
    candidates,
  };
}

/**
 * Determines whether a value is a non-null, non-array object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Determines whether a value is an array composed entirely of strings.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Validates and normalizes a worker command (flat string array) from parsed JSON input.
 */
function validateWorkerCommand(value: unknown, keyPath: string): WorkerCommand {
  if (!isStringArray(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected string array.`);
  }

  return [...value];
}

/**
 * Validates the `workers` section: { default?, interactive? }.
 */
function validateWorkers(value: unknown, keyPath: string): WorkersConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: WorkersConfig = {};

  if (value.default !== undefined) {
    result.default = validateWorkerCommand(value.default, `${keyPath}.default`);
  }

  if (value.interactive !== undefined) {
    result.interactive = validateWorkerCommand(value.interactive, `${keyPath}.interactive`);
  } else if (value.tui !== undefined) {
    result.interactive = validateWorkerCommand(value.tui, `${keyPath}.tui`);
  }

  return result;
}

function validateWorkerCommandList(value: unknown, keyPath: string): WorkerCommand[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected array.`);
  }

  return value.map((entry, index) => validateWorkerCommand(entry, `${keyPath}[${index}]`));
}

function validateFallbacks(value: unknown, keyPath: string): FallbacksConfig {
  if (Array.isArray(value)) {
    return { default: validateWorkerCommandList(value, keyPath) };
  }

  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: FallbacksConfig = {};
  for (const [profileName, commands] of Object.entries(value)) {
    if (profileName === "profiles" && isPlainObject(commands)) {
      for (const [nestedProfileName, nestedCommands] of Object.entries(commands)) {
        result[nestedProfileName] = validateWorkerCommandList(nestedCommands, `${keyPath}.profiles.${nestedProfileName}`);
      }
      continue;
    }

    result[profileName] = validateWorkerCommandList(commands, `${keyPath}.${profileName}`);
  }

  return result;
}

function resolveRawFallbacks(value: Record<string, unknown>): unknown {
  if (value.fallbacks !== undefined) {
    return value.fallbacks;
  }

  const workers = value.workers;
  if (isPlainObject(workers) && workers.fallbacks !== undefined) {
    return workers.fallbacks;
  }

  return undefined;
}

/**
 * Validates a map of worker commands keyed by profile name.
 */
function validateProfileMap(value: unknown, keyPath: string): Record<string, WorkerCommand> {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: Record<string, WorkerCommand> = {};
  for (const [key, command] of Object.entries(value)) {
    result[key] = validateWorkerCommand(command, `${keyPath}.${key}`);
  }

  return result;
}

/**
 * Validates optional inline trace statistics configuration.
 */
function validateTraceStatisticsConfig(value: unknown, keyPath: string): TraceStatisticsConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const enabled = value.enabled;
  const fields = value.fields;

  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(`Invalid worker config at ${keyPath}.enabled: expected boolean.`);
  }

  if (fields !== undefined && !isStringArray(fields)) {
    throw new Error(`Invalid worker config at ${keyPath}.fields: expected string array.`);
  }

  if (fields !== undefined) {
    const allowedFields = new Set<string>(TRACE_STATISTICS_FIELD_REGISTRY);
    const unknownField = fields.find((field) => !allowedFields.has(field));
    if (unknownField) {
      throw new Error(
        `Invalid worker config at ${keyPath}.fields: unknown field "${unknownField}". Allowed: ${TRACE_STATISTICS_FIELD_REGISTRY.join(", ")}.`,
      );
    }
  }

  return {
    enabled: enabled === true,
    fields: fields === undefined ? [...DEFAULT_TRACE_STATISTICS_FIELDS] : [...fields],
  };
}

function validateRunDefaults(value: unknown, keyPath: string): RunDefaultsConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: RunDefaultsConfig = {};

  if (value.revertable !== undefined && typeof value.revertable !== "boolean") {
    throw new Error(`Invalid worker config at ${keyPath}.revertable: expected boolean.`);
  }
  if (typeof value.revertable === "boolean") {
    result.revertable = value.revertable;
  }

  if (value.commit !== undefined && typeof value.commit !== "boolean") {
    throw new Error(`Invalid worker config at ${keyPath}.commit: expected boolean.`);
  }
  if (typeof value.commit === "boolean") {
    result.commit = value.commit;
  }

  if (value.commitMessage !== undefined && typeof value.commitMessage !== "string") {
    throw new Error(`Invalid worker config at ${keyPath}.commitMessage: expected string.`);
  }
  if (typeof value.commitMessage === "string") {
    result.commitMessage = value.commitMessage;
  }

  if (value.commitMode !== undefined) {
    const commitMode = value.commitMode;
    if (typeof commitMode !== "string" || !RUN_COMMIT_MODES.includes(commitMode as RunDefaultsConfig["commitMode"] & string)) {
      throw new Error(
        `Invalid worker config at ${keyPath}.commitMode: expected one of ${RUN_COMMIT_MODES.join(", ")}.`,
      );
    }
    result.commitMode = commitMode as RunDefaultsConfig["commitMode"];
  }

  return result;
}

function validateAutoCompactDefaults(value: unknown, keyPath: string): AutoCompactDefaultsConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: AutoCompactDefaultsConfig = {};
  if (value.beforeExit !== undefined && typeof value.beforeExit !== "boolean") {
    throw new Error(`Invalid worker config at ${keyPath}.beforeExit: expected boolean.`);
  }
  if (typeof value.beforeExit === "boolean") {
    result.beforeExit = value.beforeExit;
  }

  return result;
}

function validateNonNegativeNumber(value: unknown, keyPath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid worker config at ${keyPath}: expected non-negative number.`);
  }

  return value;
}

function validateNonNegativeInteger(value: unknown, keyPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid worker config at ${keyPath}: expected non-negative integer.`);
  }

  return value;
}

function validatePositiveInteger(value: unknown, keyPath: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid worker config at ${keyPath}: expected positive integer.`);
  }

  return value;
}

function validateHealthPolicy(value: unknown, keyPath: string): WorkerHealthPolicyConfig | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: WorkerHealthPolicyConfig = {};

  const cooldowns = value.cooldownSecondsByFailureClass;
  if (cooldowns !== undefined) {
    if (!isPlainObject(cooldowns)) {
      throw new Error(`Invalid worker config at ${keyPath}.cooldownSecondsByFailureClass: expected object.`);
    }

    const validatedCooldowns: NonNullable<WorkerHealthPolicyConfig["cooldownSecondsByFailureClass"]> = {};
    if (cooldowns.usage_limit !== undefined) {
      validatedCooldowns.usage_limit = validateNonNegativeNumber(
        cooldowns.usage_limit,
        `${keyPath}.cooldownSecondsByFailureClass.usage_limit`,
      );
    }
    if (cooldowns.transport_unavailable !== undefined) {
      validatedCooldowns.transport_unavailable = validateNonNegativeNumber(
        cooldowns.transport_unavailable,
        `${keyPath}.cooldownSecondsByFailureClass.transport_unavailable`,
      );
    }
    if (cooldowns.execution_failure_other !== undefined) {
      validatedCooldowns.execution_failure_other = validateNonNegativeNumber(
        cooldowns.execution_failure_other,
        `${keyPath}.cooldownSecondsByFailureClass.execution_failure_other`,
      );
    }

    result.cooldownSecondsByFailureClass = validatedCooldowns;
  }

  if (value.maxFailoverAttemptsPerTask !== undefined) {
    result.maxFailoverAttemptsPerTask = validatePositiveInteger(
      value.maxFailoverAttemptsPerTask,
      `${keyPath}.maxFailoverAttemptsPerTask`,
    );
  }

  if (value.maxFailoverAttemptsPerRun !== undefined) {
    result.maxFailoverAttemptsPerRun = validatePositiveInteger(
      value.maxFailoverAttemptsPerRun,
      `${keyPath}.maxFailoverAttemptsPerRun`,
    );
  }

  if (value.fallbackStrategy !== undefined) {
    const fallbackStrategy = value.fallbackStrategy;
    if (
      fallbackStrategy !== WORKER_HEALTH_POLICY_FALLBACK_STRATEGY_STRICT_ORDER
      && fallbackStrategy !== WORKER_HEALTH_POLICY_FALLBACK_STRATEGY_PRIORITY
    ) {
      throw new Error(
        `Invalid worker config at ${keyPath}.fallbackStrategy: expected one of `
          + `${WORKER_HEALTH_POLICY_FALLBACK_STRATEGY_STRICT_ORDER}, ${WORKER_HEALTH_POLICY_FALLBACK_STRATEGY_PRIORITY}.`,
      );
    }

    result.fallbackStrategy = fallbackStrategy;
  }

  const unavailableReevaluation = value.unavailableReevaluation;
  if (unavailableReevaluation !== undefined) {
    if (!isPlainObject(unavailableReevaluation)) {
      throw new Error(`Invalid worker config at ${keyPath}.unavailableReevaluation: expected object.`);
    }

    const validatedUnavailableReevaluation: NonNullable<WorkerHealthPolicyConfig["unavailableReevaluation"]> = {};

    if (unavailableReevaluation.mode !== undefined) {
      const mode = unavailableReevaluation.mode;
      if (
        mode !== WORKER_HEALTH_POLICY_UNAVAILABLE_REEVALUATION_MANUAL
        && mode !== WORKER_HEALTH_POLICY_UNAVAILABLE_REEVALUATION_COOLDOWN
      ) {
        throw new Error(
          `Invalid worker config at ${keyPath}.unavailableReevaluation.mode: expected one of `
            + `${WORKER_HEALTH_POLICY_UNAVAILABLE_REEVALUATION_MANUAL}, ${WORKER_HEALTH_POLICY_UNAVAILABLE_REEVALUATION_COOLDOWN}.`,
        );
      }

      validatedUnavailableReevaluation.mode = mode;
    }

    if (unavailableReevaluation.probeCooldownSeconds !== undefined) {
      validatedUnavailableReevaluation.probeCooldownSeconds = validateNonNegativeNumber(
        unavailableReevaluation.probeCooldownSeconds,
        `${keyPath}.unavailableReevaluation.probeCooldownSeconds`,
      );
    }

    result.unavailableReevaluation = validatedUnavailableReevaluation;
  }

  return result;
}

/**
 * Validates the top-level worker configuration document.
 */
function validateWorkerConfig(value: unknown): WorkerConfig {
  if (!isPlainObject(value)) {
    throw new Error("Invalid worker config: expected top-level JSON object.");
  }

  const workers = value.workers;
  const fallbacks = resolveRawFallbacks(value);
  const workerTimeoutMs = value.workerTimeoutMs;
  const profiles = value.profiles;
  const autoCompact = value.autoCompact;

  return {
    workers: workers === undefined ? undefined : validateWorkers(workers, "workers"),
    fallbacks: fallbacks === undefined ? undefined : validateFallbacks(fallbacks, "fallbacks"),
    workerTimeoutMs: workerTimeoutMs === undefined
      ? undefined
      : validateNonNegativeInteger(workerTimeoutMs, "workerTimeoutMs"),
    profiles: profiles === undefined ? undefined : validateProfileMap(profiles, "profiles"),
    traceStatistics: value.traceStatistics === undefined
      ? undefined
      : validateTraceStatisticsConfig(value.traceStatistics, "traceStatistics"),
    healthPolicy: validateHealthPolicy(value.healthPolicy, "healthPolicy"),
    run: value.run === undefined ? undefined : validateRunDefaults(value.run, "run"),
    ...(autoCompact === undefined
      ? {}
      : { autoCompact: validateAutoCompactDefaults(autoCompact, "autoCompact") }),
  };
}

function cloneWorkerCommand(value: WorkerCommand | undefined): WorkerCommand | undefined {
  return value ? [...value] : undefined;
}

function cloneWorkerCommands(value: WorkerCommand[] | undefined): WorkerCommand[] | undefined {
  return value?.map((entry) => [...entry]);
}

function cloneWorkers(value: WorkersConfig | undefined): WorkersConfig | undefined {
  if (!value) {
    return undefined;
  }

  const cloned: WorkersConfig = {};
  if (value.default) {
    cloned.default = cloneWorkerCommand(value.default);
  }
  if (value.interactive) {
    cloned.interactive = cloneWorkerCommand(value.interactive);
  }
  return cloned;
}

function cloneFallbacks(value: FallbacksConfig | undefined): FallbacksConfig | undefined {
  if (!value) {
    return undefined;
  }

  const cloned: FallbacksConfig = {};
  for (const [key, commands] of Object.entries(value)) {
    const clonedCommands = cloneWorkerCommands(commands);
    if (clonedCommands !== undefined) {
      cloned[key] = clonedCommands;
    }
  }

  if (Object.keys(cloned).length === 0) {
    return undefined;
  }

  return cloned;
}

function cloneCommandProfiles(
  value: Record<string, WorkerCommand> | undefined,
): Record<string, WorkerCommand> | undefined {
  if (!value) {
    return undefined;
  }

  const cloned: Record<string, WorkerCommand> = {};
  for (const [key, command] of Object.entries(value)) {
    if (!command) {
      continue;
    }
    cloned[key] = [...command];
  }
  return cloned;
}

function cloneTraceStatistics(value: TraceStatisticsConfig | undefined): TraceStatisticsConfig | undefined {
  if (!value) {
    return undefined;
  }

  return {
    enabled: value.enabled,
    fields: [...value.fields],
  };
}

function cloneHealthPolicy(value: WorkerHealthPolicyConfig | undefined): WorkerHealthPolicyConfig | undefined {
  if (!value) {
    return undefined;
  }

  const cloned: WorkerHealthPolicyConfig = {
    cooldownSecondsByFailureClass: value.cooldownSecondsByFailureClass
      ? { ...value.cooldownSecondsByFailureClass }
      : undefined,
    maxFailoverAttemptsPerTask: value.maxFailoverAttemptsPerTask,
    maxFailoverAttemptsPerRun: value.maxFailoverAttemptsPerRun,
    fallbackStrategy: value.fallbackStrategy,
    unavailableReevaluation: value.unavailableReevaluation
      ? { ...value.unavailableReevaluation }
      : undefined,
  };

  if (
    cloned.cooldownSecondsByFailureClass === undefined
    && cloned.maxFailoverAttemptsPerTask === undefined
    && cloned.maxFailoverAttemptsPerRun === undefined
    && cloned.fallbackStrategy === undefined
    && cloned.unavailableReevaluation === undefined
  ) {
    return undefined;
  }

  return cloned;
}

function cloneRunDefaults(value: RunDefaultsConfig | undefined): RunDefaultsConfig | undefined {
  if (!value) {
    return undefined;
  }

  const cloned: RunDefaultsConfig = {
    revertable: value.revertable,
    commit: value.commit,
    commitMessage: value.commitMessage,
    commitMode: value.commitMode,
  };

  if (
    cloned.revertable === undefined
    && cloned.commit === undefined
    && cloned.commitMessage === undefined
    && cloned.commitMode === undefined
  ) {
    return undefined;
  }

  return cloned;
}

function cloneAutoCompactDefaults(value: AutoCompactDefaultsConfig | undefined): AutoCompactDefaultsConfig | undefined {
  if (!value) {
    return undefined;
  }

  const cloned: AutoCompactDefaultsConfig = {
    beforeExit: value.beforeExit,
  };

  if (cloned.beforeExit === undefined) {
    return undefined;
  }

  return cloned;
}

function mergeRunDefaults(
  base: RunDefaultsConfig | undefined,
  override: RunDefaultsConfig | undefined,
): RunDefaultsConfig | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: RunDefaultsConfig = {
    revertable: override?.revertable ?? base?.revertable,
    commit: override?.commit ?? base?.commit,
    commitMessage: override?.commitMessage ?? base?.commitMessage,
    commitMode: override?.commitMode ?? base?.commitMode,
  };

  if (
    merged.revertable === undefined
    && merged.commit === undefined
    && merged.commitMessage === undefined
    && merged.commitMode === undefined
  ) {
    return undefined;
  }

  return merged;
}

function mergeAutoCompactDefaults(
  base: AutoCompactDefaultsConfig | undefined,
  override: AutoCompactDefaultsConfig | undefined,
): AutoCompactDefaultsConfig | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: AutoCompactDefaultsConfig = {
    beforeExit: override?.beforeExit ?? base?.beforeExit,
  };

  if (merged.beforeExit === undefined) {
    return undefined;
  }

  return merged;
}

function mergeWorkers(base: WorkersConfig | undefined, override: WorkersConfig | undefined): WorkersConfig | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: WorkersConfig = {
    default: override?.default !== undefined ? cloneWorkerCommand(override.default) : cloneWorkerCommand(base?.default),
    interactive: override?.interactive !== undefined ? cloneWorkerCommand(override.interactive) : cloneWorkerCommand(base?.interactive),
  };

  if (!merged.default && !merged.interactive) {
    return undefined;
  }

  return merged;
}

function mergeFallbacks(base: FallbacksConfig | undefined, override: FallbacksConfig | undefined): FallbacksConfig | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: FallbacksConfig = {
    ...(cloneFallbacks(base) ?? {}),
    ...(cloneFallbacks(override) ?? {}),
  };
  const defaultFallbacks = override?.[FALLBACKS_DEFAULT_KEY] !== undefined
    ? cloneWorkerCommands(override[FALLBACKS_DEFAULT_KEY])
    : cloneWorkerCommands(base?.[FALLBACKS_DEFAULT_KEY]);

  if (defaultFallbacks !== undefined) {
    merged[FALLBACKS_DEFAULT_KEY] = defaultFallbacks;
  } else {
    delete merged[FALLBACKS_DEFAULT_KEY];
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeProfileMaps(
  base: Record<string, WorkerCommand> | undefined,
  override: Record<string, WorkerCommand> | undefined,
): Record<string, WorkerCommand> | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged = {
    ...(cloneCommandProfiles(base) ?? {}),
    ...(cloneCommandProfiles(override) ?? {}),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}

function mergeHealthPolicy(
  base: WorkerHealthPolicyConfig | undefined,
  override: WorkerHealthPolicyConfig | undefined,
): WorkerHealthPolicyConfig | undefined {
  if (!base && !override) {
    return undefined;
  }

  const mergedCooldowns = {
    ...(base?.cooldownSecondsByFailureClass ?? {}),
    ...(override?.cooldownSecondsByFailureClass ?? {}),
  };
  const mergedUnavailableReevaluation = {
    ...(base?.unavailableReevaluation ?? {}),
    ...(override?.unavailableReevaluation ?? {}),
  };

  const merged: WorkerHealthPolicyConfig = {
    cooldownSecondsByFailureClass: Object.keys(mergedCooldowns).length > 0
      ? mergedCooldowns
      : undefined,
    maxFailoverAttemptsPerTask: override?.maxFailoverAttemptsPerTask ?? base?.maxFailoverAttemptsPerTask,
    maxFailoverAttemptsPerRun: override?.maxFailoverAttemptsPerRun ?? base?.maxFailoverAttemptsPerRun,
    fallbackStrategy: override?.fallbackStrategy ?? base?.fallbackStrategy,
    unavailableReevaluation: Object.keys(mergedUnavailableReevaluation).length > 0
      ? mergedUnavailableReevaluation
      : undefined,
  };

  if (
    merged.cooldownSecondsByFailureClass === undefined
    && merged.maxFailoverAttemptsPerTask === undefined
    && merged.maxFailoverAttemptsPerRun === undefined
    && merged.fallbackStrategy === undefined
    && merged.unavailableReevaluation === undefined
  ) {
    return undefined;
  }

  return merged;
}

function mergeWorkerConfig(
  base: WorkerConfig | undefined,
  override: WorkerConfig | undefined,
): WorkerConfig | undefined {
  if (!base && !override) {
    return undefined;
  }

  const mergedHealthPolicy = mergeHealthPolicy(base?.healthPolicy, override?.healthPolicy);
  const mergedAutoCompact = mergeAutoCompactDefaults(base?.autoCompact, override?.autoCompact);

  return {
    workers: mergeWorkers(base?.workers, override?.workers),
    fallbacks: mergeFallbacks(base?.fallbacks, override?.fallbacks),
    workerTimeoutMs: override?.workerTimeoutMs ?? base?.workerTimeoutMs,
    profiles: mergeProfileMaps(base?.profiles, override?.profiles),
    traceStatistics: override?.traceStatistics !== undefined
      ? cloneTraceStatistics(override.traceStatistics)
      : cloneTraceStatistics(base?.traceStatistics),
    healthPolicy: mergedHealthPolicy,
    run: mergeRunDefaults(base?.run, override?.run),
    ...(mergedAutoCompact === undefined ? {} : { autoCompact: mergedAutoCompact }),
  };
}

function applyBuiltInDefaults(config: WorkerConfig | undefined): WorkerConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    workers: cloneWorkers(config.workers),
    fallbacks: cloneFallbacks(config.fallbacks),
    workerTimeoutMs: config.workerTimeoutMs,
    profiles: cloneCommandProfiles(config.profiles),
    traceStatistics: config.traceStatistics
      ? cloneTraceStatistics(config.traceStatistics)
      : {
        enabled: false,
        fields: [...DEFAULT_TRACE_STATISTICS_FIELDS],
    },
    healthPolicy: cloneHealthPolicy(config.healthPolicy),
    run: cloneRunDefaults(config.run),
    ...(config.autoCompact !== undefined
      ? { autoCompact: cloneAutoCompactDefaults(config.autoCompact) }
      : {}),
  };
}

function valueAtPath(root: unknown, pathSegments: readonly string[]): unknown {
  let current: unknown = root;
  for (const segment of pathSegments) {
    if (!isPlainObject(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function resolveConfigForScope(
  configDir: string,
  scope: WorkerConfigReadableScope,
  globalResolution: GlobalConfigPathResolution,
): WorkerConfig | undefined {
  const localConfigPath = path.join(configDir, WORKER_CONFIG_FILE_NAME);
  const localConfig = loadConfigFile(localConfigPath, "local", true);
  const globalConfigPath = globalResolution.discoveredPath;
  const globalConfig = globalConfigPath
    ? loadConfigFile(globalConfigPath, "global", false)
    : undefined;

  if (scope === "local") {
    return localConfig;
  }

  if (scope === "global") {
    return globalConfig;
  }

  return applyBuiltInDefaults(mergeWorkerConfig(globalConfig, localConfig));
}

function resolveConfigPaths(configDir: string, globalResolution: GlobalConfigPathResolution): WorkerConfigPathsResult {
  return {
    localConfigPath: path.join(configDir, WORKER_CONFIG_FILE_NAME),
    globalConfigPath: globalResolution.discoveredPath,
    globalCanonicalPath: globalResolution.canonicalPath,
  };
}

function resolveValueSource(
  pathSegments: readonly string[],
  builtInConfig: WorkerConfig | undefined,
  globalConfig: WorkerConfig | undefined,
  localConfig: WorkerConfig | undefined,
): WorkerConfigValueSource | undefined {
  const sources: WorkerConfigValueSource[] = [];
  if (valueAtPath(builtInConfig, pathSegments) !== undefined) {
    sources.push("built-in");
  }
  if (valueAtPath(globalConfig, pathSegments) !== undefined) {
    sources.push("global");
  }
  if (valueAtPath(localConfig, pathSegments) !== undefined) {
    sources.push("local");
  }

  if (sources.length === 0) {
    return undefined;
  }
  if (sources.length === 1) {
    return sources[0];
  }
  return "mixed";
}

function collectValueSources(
  config: WorkerConfig | undefined,
  builtInConfig: WorkerConfig | undefined,
  globalConfig: WorkerConfig | undefined,
  localConfig: WorkerConfig | undefined,
): WorkerConfigValueSourceMap {
  if (!config) {
    return {};
  }

  const valueSources: WorkerConfigValueSourceMap = {};

  const walk = (value: unknown, pathSegments: string[]): void => {
    if (pathSegments.length > 0) {
      const pathKey = pathSegments.join(".");
      const source = resolveValueSource(pathSegments, builtInConfig, globalConfig, localConfig);
      if (source !== undefined) {
        valueSources[pathKey] = source;
      }
    }

    if (!isPlainObject(value)) {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        continue;
      }
      walk(child, [...pathSegments, key]);
    }
  };

  walk(config, []);
  return valueSources;
}

function formatScopeLabel(scope: WorkerConfigWritableScope): string {
  return scope === "global" ? "global worker config" : "worker config";
}

function formatLoadScopeLabel(scope: "global" | "local"): string {
  return scope === "global" ? "global worker config" : "worker config";
}

function formatConfigRepairGuidance(scope: "global" | "local", configPath: string): string {
  const shared = `Repair guidance: ensure \"${configPath}\" contains valid JSON with a top-level object (for example: {}).`;
  if (scope === "local") {
    return `${shared} To reset project defaults, back up and remove the file, then run \`rundown init --overwrite-config\`.`;
  }

  return `${shared} To reset global defaults, back up and remove the file, then run \`rundown config set workers.default '[\"opencode\",\"run\"]' --type json --scope global\`.`;
}

function parseKeyPath(keyPath: string): string[] {
  const trimmed = keyPath.trim();
  if (trimmed.length === 0) {
    throw new Error("Invalid config key path: expected a non-empty dotted path.");
  }

  const segments = trimmed.split(".").map((segment) => segment.trim());
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error(`Invalid config key path "${keyPath}": segments cannot be empty.`);
  }

  for (const segment of segments) {
    if (segment === "__proto__" || segment === "prototype" || segment === "constructor") {
      throw new Error(`Invalid config key path "${keyPath}": segment "${segment}" is not allowed.`);
    }
  }

  return segments;
}

function validateSchemaKeyPath(pathSegments: readonly string[], keyPath: string): void {
  const [root, second, third, fourth] = pathSegments;

  const fail = (): never => {
    throw new Error(
      `Unknown config key path "${keyPath}". Use --unsafe to write arbitrary keys.`,
    );
  };

  if (root === "workers") {
    if (pathSegments.length === 1 || (pathSegments.length === 2 && (second === "default" || second === "interactive" || second === "tui"))) {
      return;
    }
    fail();
  }

  if (root === "fallbacks") {
    if (pathSegments.length === 1 || pathSegments.length === 2 || (pathSegments.length === 3 && second === "profiles")) {
      return;
    }
    fail();
  }

  if (root === "profiles") {
    if (pathSegments.length === 1 || pathSegments.length === 2) {
      return;
    }
    fail();
  }

  if (root === "workerTimeoutMs") {
    if (pathSegments.length === 1) {
      return;
    }
    fail();
  }

  if (root === "traceStatistics") {
    if (pathSegments.length === 1 || (pathSegments.length === 2 && (second === "enabled" || second === "fields"))) {
      return;
    }
    fail();
  }

  if (root === "healthPolicy") {
    if (
      pathSegments.length === 1
      || (pathSegments.length === 2 && (second === "cooldownSecondsByFailureClass" || second === "maxFailoverAttemptsPerTask" || second === "maxFailoverAttemptsPerRun" || second === "fallbackStrategy" || second === "unavailableReevaluation"))
      || (pathSegments.length === 3 && second === "cooldownSecondsByFailureClass" && (third === "usage_limit" || third === "transport_unavailable" || third === "execution_failure_other"))
      || (pathSegments.length === 3 && second === "unavailableReevaluation" && (third === "mode" || third === "probeCooldownSeconds"))
    ) {
      return;
    }
    fail();
  }

  if (root === "run") {
    if (pathSegments.length === 1 || (pathSegments.length === 2 && (second === "revertable" || second === "commit" || second === "commitMessage" || second === "commitMode"))) {
      return;
    }
    fail();
  }

  if (root === "autoCompact") {
    if (pathSegments.length === 1 || (pathSegments.length === 2 && second === "beforeExit")) {
      return;
    }
    fail();
  }

  if (fourth !== undefined) {
    fail();
  }

  fail();
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWritableConfigDocument(configPath: string, scope: WorkerConfigWritableScope): Record<string, unknown> {
  const guidance = formatConfigRepairGuidance(scope, configPath);
  try {
    const source = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(source);
    if (!isJsonObject(parsed)) {
      throw new Error(`Failed to parse ${formatScopeLabel(scope)} at "${configPath}": expected top-level JSON object. ${guidance}`);
    }
    return parsed;
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse ${formatScopeLabel(scope)} at "${configPath}": invalid JSON (${error.message}). ${guidance}`);
    }

    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Failed to read ${formatScopeLabel(scope)} at "${configPath}": ${String(error)}.`);
  }
}

function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      if (!areJsonValuesEqual(left[index], right[index])) {
        return false;
      }
    }
    return true;
  }

  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key)) {
        return false;
      }
      if (!areJsonValuesEqual(left[key], right[key])) {
        return false;
      }
    }
    return true;
  }

  return false;
}

function setPathValue(root: Record<string, unknown>, pathSegments: readonly string[], value: unknown): boolean {
  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index] as string;
    const next = cursor[segment];

    if (next === undefined) {
      const created: Record<string, unknown> = {};
      cursor[segment] = created;
      cursor = created;
      continue;
    }

    if (!isJsonObject(next)) {
      throw new Error(
        `Cannot set config key "${pathSegments.join(".")}": "${pathSegments.slice(0, index + 1).join(".")}" is not an object.`,
      );
    }

    cursor = next;
  }

  const leafKey = pathSegments[pathSegments.length - 1] as string;
  const current = cursor[leafKey];
  if (areJsonValuesEqual(current, value)) {
    return false;
  }

  cursor[leafKey] = value;
  return true;
}

function unsetPathValue(root: Record<string, unknown>, pathSegments: readonly string[]): boolean {
  const parents: Array<{ holder: Record<string, unknown>; key: string }> = [];
  let cursor: Record<string, unknown> = root;

  for (let index = 0; index < pathSegments.length - 1; index += 1) {
    const segment = pathSegments[index] as string;
    const next = cursor[segment];
    if (!isJsonObject(next)) {
      return false;
    }
    parents.push({ holder: cursor, key: segment });
    cursor = next;
  }

  const leafKey = pathSegments[pathSegments.length - 1] as string;
  if (!Object.hasOwn(cursor, leafKey)) {
    return false;
  }

  delete cursor[leafKey];

  for (let index = parents.length - 1; index >= 0; index -= 1) {
    const parent = parents[index] as { holder: Record<string, unknown>; key: string };
    const child = parent.holder[parent.key];
    if (!isJsonObject(child) || Object.keys(child).length > 0) {
      break;
    }
    delete parent.holder[parent.key];
  }

  return true;
}

function writeConfigDocument(configPath: string, scope: WorkerConfigWritableScope, value: Record<string, unknown>): void {
  const dirPath = path.dirname(configPath);
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to prepare directory for ${formatScopeLabel(scope)} at "${configPath}": ${String(error)}.`);
  }

  const serialized = JSON.stringify(value, null, 2) + "\n";
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tempPath, serialized, "utf-8");

    try {
      fs.renameSync(tempPath, configPath);
      return;
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EEXIST") {
        fs.writeFileSync(configPath, serialized, "utf-8");
        fs.rmSync(tempPath, { force: true });
        return;
      }
      throw renameError;
    }
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw new Error(`Failed to write ${formatScopeLabel(scope)} at "${configPath}": ${String(error)}.`);
  }
}

function resolveWritableConfigPath(
  scope: WorkerConfigWritableScope,
  configDir: string,
  resolveGlobalPath: () => {
    discoveredPath: string | undefined;
    canonicalPath?: string | undefined;
  },
): string {
  if (scope === "local") {
    return path.join(configDir, WORKER_CONFIG_FILE_NAME);
  }

  const globalResolution = resolveGlobalPath();
  const writableGlobalPath = globalResolution.discoveredPath ?? globalResolution.canonicalPath;
  if (!writableGlobalPath) {
    throw new Error("Unable to resolve global config path for write operations.");
  }

  return writableGlobalPath;
}

function applyConfigMutation(
  configPath: string,
  scope: WorkerConfigWritableScope,
  input: WorkerConfigSetValueInput | WorkerConfigUnsetValueInput,
): WorkerConfigMutationResult {
  const keySegments = parseKeyPath(input.keyPath);
  if ("value" in input && input.unsafe !== true) {
    validateSchemaKeyPath(keySegments, input.keyPath);
  }
  const document = readWritableConfigDocument(configPath, scope);
  const changed = "value" in input
    ? setPathValue(document, keySegments, input.value)
    : unsetPathValue(document, keySegments);

  if (!changed) {
    return {
      configPath,
      changed: false,
    };
  }

  if ("value" in input && input.unsafe !== true) {
    validateWorkerConfig(document);
  }

  writeConfigDocument(configPath, scope, document);
  return {
    configPath,
    changed: true,
  };
}

function loadConfigFile(configPath: string, scope: "global" | "local", optional: boolean): WorkerConfig | undefined {
  const scopeLabel = formatLoadScopeLabel(scope);
  const guidance = formatConfigRepairGuidance(scope, configPath);
  let parsed: unknown;
  try {
    const source = fs.readFileSync(configPath, "utf-8");
    parsed = JSON.parse(source);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse ${scopeLabel} at "${configPath}": invalid JSON (${error.message}). ${guidance}`);
    }

    throw new Error(`Failed to read ${scopeLabel} at "${configPath}": ${String(error)}. ${guidance}`);
  }

  try {
    return validateWorkerConfig(parsed);
  } catch (error) {
    throw new Error(`Invalid ${scopeLabel} at "${configPath}": ${(error as Error).message} ${guidance}`);
  }
}

/**
 * Creates the worker configuration adapter that loads and validates config
 * values from `<configDir>/config.json`.
 */
export function createWorkerConfigAdapter(options: CreateWorkerConfigAdapterOptions = {}): WorkerConfigPort {
  const resolveGlobalPath = options.resolveGlobalConfigPath ?? resolveGlobalConfigPath;

  const loadWithSources = (configDir: string): WorkerConfigLoadWithSourcesResult => {
    const localConfigPath = path.join(configDir, WORKER_CONFIG_FILE_NAME);
    const localConfig = loadConfigFile(localConfigPath, "local", true);
    const globalResolution = normalizeGlobalResolution(resolveGlobalPath());
    const globalConfigPath = globalResolution.discoveredPath;
    const globalConfig = globalConfigPath
      ? loadConfigFile(globalConfigPath, "global", false)
      : undefined;
    const layeredConfig = mergeWorkerConfig(globalConfig, localConfig);
    const config = applyBuiltInDefaults(layeredConfig);
    const builtInConfig = config
      && globalConfig?.traceStatistics === undefined
      && localConfig?.traceStatistics === undefined
      ? {
        traceStatistics: {
          enabled: false,
          fields: [...DEFAULT_TRACE_STATISTICS_FIELDS],
        },
      }
      : undefined;

    return {
      config,
      valueSources: collectValueSources(config, builtInConfig, globalConfig, localConfig),
      localConfigPath,
      globalConfigPath,
    };
  };

  return {
    /**
     * Loads worker configuration from disk.
     *
     * Returns `undefined` when the configuration file does not exist.
     */
    load(configDir) {
      return loadWithSources(configDir).config;
    },
    loadWithSources(configDir): WorkerConfigLoadWithSourcesResult {
      return loadWithSources(configDir);
    },
    readValue(configDir, scope, keyPath): unknown {
      const keySegments = parseKeyPath(keyPath);
      const globalResolution = normalizeGlobalResolution(resolveGlobalPath());
      const config = resolveConfigForScope(configDir, scope, globalResolution);
      return valueAtPath(config, keySegments);
    },
    listValues(configDir, scope): WorkerConfig | undefined {
      const globalResolution = normalizeGlobalResolution(resolveGlobalPath());
      return resolveConfigForScope(configDir, scope, globalResolution);
    },
    getConfigPaths(configDir): WorkerConfigPathsResult {
      const globalResolution = normalizeGlobalResolution(resolveGlobalPath());
      return resolveConfigPaths(configDir, globalResolution);
    },
    setValue(configDir, input): WorkerConfigMutationResult {
      const configPath = resolveWritableConfigPath(input.scope, configDir, resolveGlobalPath);
      return applyConfigMutation(configPath, input.scope, input);
    },
    unsetValue(configDir, input): WorkerConfigMutationResult {
      const configPath = resolveWritableConfigPath(input.scope, configDir, resolveGlobalPath);
      return applyConfigMutation(configPath, input.scope, input);
    },
  };
}
