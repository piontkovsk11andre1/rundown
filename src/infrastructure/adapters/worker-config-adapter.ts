import fs from "node:fs";
import path from "node:path";
import {
  resolveGlobalConfigPath,
  type GlobalConfigPathResolution,
} from "./global-config-path-adapter.js";
import type { WorkerConfigPort } from "../../domain/ports/worker-config-port.js";
import {
  DEFAULT_TRACE_STATISTICS_FIELDS,
  TRACE_STATISTICS_FIELD_REGISTRY,
  WORKER_HEALTH_POLICY_FALLBACK_STRATEGY_PRIORITY,
  WORKER_HEALTH_POLICY_FALLBACK_STRATEGY_STRICT_ORDER,
  WORKER_HEALTH_POLICY_UNAVAILABLE_REEVALUATION_COOLDOWN,
  WORKER_HEALTH_POLICY_UNAVAILABLE_REEVALUATION_MANUAL,
  WORKER_CONFIG_COMMAND_NAMES,
  type WorkerHealthPolicyConfig,
  type TraceStatisticsConfig,
  type WorkerCommand,
  type WorkerCommandProfiles,
  type WorkerConfig,
  type WorkerConfigLoadWithSourcesResult,
  type WorkerConfigMutationResult,
  type WorkerConfigSetValueInput,
  type WorkerConfigUnsetValueInput,
  type WorkerConfigValueSource,
  type WorkerConfigValueSourceMap,
  type WorkerConfigWritableScope,
  type WorkerConfigCommandName,
  type WorkersConfig,
} from "../../domain/worker-config.js";

const WORKER_CONFIG_FILE_NAME = "config.json";

interface CreateWorkerConfigAdapterOptions {
  readonly resolveGlobalConfigPath?: () => {
    discoveredPath: string | undefined;
    canonicalPath?: string | undefined;
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
 * Validates the `workers` section: { default?, tui?, fallbacks? }.
 */
function validateWorkers(value: unknown, keyPath: string): WorkersConfig {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const result: WorkersConfig = {};

  if (value.default !== undefined) {
    result.default = validateWorkerCommand(value.default, `${keyPath}.default`);
  }

  if (value.tui !== undefined) {
    result.tui = validateWorkerCommand(value.tui, `${keyPath}.tui`);
  }

  if (value.fallbacks !== undefined) {
    if (!Array.isArray(value.fallbacks)) {
      throw new Error(`Invalid worker config at ${keyPath}.fallbacks: expected array.`);
    }

    result.fallbacks = (value.fallbacks as unknown[]).map((entry, index) =>
      validateWorkerCommand(entry, `${keyPath}.fallbacks[${index}]`),
    );
  }

  return result;
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
 * Returns true when a config key matches the `tools.{toolName}` pattern.
 */
function isToolsKey(key: string): key is `tools.${string}` {
  return key.startsWith("tools.") && key.length > "tools.".length;
}

/**
 * Validates `commands` config and accepts known command keys and `tools.*` keys.
 */
function validateCommandProfiles(value: unknown, keyPath: string): WorkerCommandProfiles {
  if (!isPlainObject(value)) {
    throw new Error(`Invalid worker config at ${keyPath}: expected object.`);
  }

  const allowedNames = new Set<string>(WORKER_CONFIG_COMMAND_NAMES);
  const result: WorkerCommandProfiles = {};

  for (const [key, command] of Object.entries(value)) {
    if (!allowedNames.has(key) && !isToolsKey(key)) {
      throw new Error(
        `Invalid worker config at ${keyPath}.${key}: unknown command. Allowed: ${WORKER_CONFIG_COMMAND_NAMES.join(", ")}, or tools.{toolName}.`,
      );
    }

    result[key as WorkerConfigCommandName] = validateWorkerCommand(command, `${keyPath}.${key}`);
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

function validateNonNegativeNumber(value: unknown, keyPath: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid worker config at ${keyPath}: expected non-negative number.`);
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
  const commands = value.commands;
  const profiles = value.profiles;

  return {
    workers: workers === undefined ? undefined : validateWorkers(workers, "workers"),
    commands: commands === undefined ? undefined : validateCommandProfiles(commands, "commands"),
    profiles: profiles === undefined ? undefined : validateProfileMap(profiles, "profiles"),
    traceStatistics: value.traceStatistics === undefined
      ? undefined
      : validateTraceStatisticsConfig(value.traceStatistics, "traceStatistics"),
    healthPolicy: validateHealthPolicy(value.healthPolicy, "healthPolicy"),
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
  if (value.tui) {
    cloned.tui = cloneWorkerCommand(value.tui);
  }
  if (value.fallbacks) {
    cloned.fallbacks = cloneWorkerCommands(value.fallbacks);
  }
  return cloned;
}

function cloneCommandProfiles(
  value: WorkerCommandProfiles | Record<string, WorkerCommand> | undefined,
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

function cloneWorkerCommandProfiles(value: WorkerCommandProfiles | undefined): WorkerCommandProfiles | undefined {
  if (!value) {
    return undefined;
  }

  const cloned: WorkerCommandProfiles = {};
  for (const [key, command] of Object.entries(value)) {
    if (!command) {
      continue;
    }
    cloned[key as WorkerConfigCommandName] = [...command];
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

function mergeWorkers(base: WorkersConfig | undefined, override: WorkersConfig | undefined): WorkersConfig | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: WorkersConfig = {
    default: override?.default !== undefined ? cloneWorkerCommand(override.default) : cloneWorkerCommand(base?.default),
    tui: override?.tui !== undefined ? cloneWorkerCommand(override.tui) : cloneWorkerCommand(base?.tui),
    fallbacks: override?.fallbacks !== undefined ? cloneWorkerCommands(override.fallbacks) : cloneWorkerCommands(base?.fallbacks),
  };

  if (!merged.default && !merged.tui && !merged.fallbacks) {
    return undefined;
  }

  return merged;
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

function mergeCommandProfiles(
  base: WorkerCommandProfiles | undefined,
  override: WorkerCommandProfiles | undefined,
): WorkerCommandProfiles | undefined {
  if (!base && !override) {
    return undefined;
  }

  const merged: WorkerCommandProfiles = {};
  for (const [key, command] of Object.entries(base ?? {})) {
    if (!command) {
      continue;
    }
    merged[key as WorkerConfigCommandName] = [...command];
  }
  for (const [key, command] of Object.entries(override ?? {})) {
    if (!command) {
      continue;
    }
    merged[key as WorkerConfigCommandName] = [...command];
  }

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

  return {
    workers: mergeWorkers(base?.workers, override?.workers),
    commands: mergeCommandProfiles(base?.commands, override?.commands),
    profiles: mergeProfileMaps(base?.profiles, override?.profiles),
    traceStatistics: override?.traceStatistics !== undefined
      ? cloneTraceStatistics(override.traceStatistics)
      : cloneTraceStatistics(base?.traceStatistics),
    healthPolicy: mergedHealthPolicy,
  };
}

function applyBuiltInDefaults(config: WorkerConfig | undefined): WorkerConfig | undefined {
  if (!config) {
    return undefined;
  }

  return {
    workers: cloneWorkers(config.workers),
    commands: cloneWorkerCommandProfiles(config.commands),
    profiles: cloneCommandProfiles(config.profiles),
    traceStatistics: config.traceStatistics
      ? cloneTraceStatistics(config.traceStatistics)
      : {
        enabled: false,
        fields: [...DEFAULT_TRACE_STATISTICS_FIELDS],
      },
    healthPolicy: cloneHealthPolicy(config.healthPolicy),
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
    const globalConfigPath = resolveGlobalPath().discoveredPath;
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
