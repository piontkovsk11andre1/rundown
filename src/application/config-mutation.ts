import { EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { ConfigDirResult } from "../domain/ports/config-dir-port.js";
import type { WorkerConfigPort } from "../domain/ports/worker-config-port.js";
import type { WorkerConfig, WorkerConfigReadableScope, WorkerConfigValueSourceMap } from "../domain/worker-config.js";

export type ConfigMutationScope = "local" | "global";
export type ConfigValueType = "auto" | "string" | "number" | "boolean" | "json";
export type ConfigReadScope = WorkerConfigReadableScope;

export interface ConfigSetOptions {
  scope: ConfigMutationScope;
  key: string;
  value: string;
  valueType: ConfigValueType;
}

export interface ConfigUnsetOptions {
  scope: ConfigMutationScope;
  key: string;
}

export interface ConfigGetOptions {
  scope: ConfigReadScope;
  key: string;
  json: boolean;
  showSource: boolean;
}

export interface ConfigListOptions {
  scope: ConfigReadScope;
  json: boolean;
  showSource: boolean;
}

export interface ConfigPathOptions {
  scope: ConfigReadScope;
}

export interface ConfigMutationDependencies {
  workerConfigPort: WorkerConfigPort;
  configDir: ConfigDirResult | undefined;
  output: ApplicationOutputPort;
}

interface ConfigReadEnvelope {
  scope: ConfigReadScope;
  value: unknown;
  source?: string;
}

interface ConfigListEnvelope {
  scope: ConfigReadScope;
  config: WorkerConfig | undefined;
  sources?: WorkerConfigValueSourceMap;
}

interface ConfigPathEnvelope {
  scope: ConfigReadScope;
  path: string;
}

function parseConfigValue(raw: string, valueType: ConfigValueType): unknown {
  if (valueType === "string") {
    return raw;
  }

  if (valueType === "number") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid config value for --type number: ${raw}.`);
    }
    return parsed;
  }

  if (valueType === "boolean") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
    throw new Error(`Invalid config value for --type boolean: ${raw}. Use true or false.`);
  }

  if (valueType === "json") {
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw new Error(`Invalid config value for --type json: ${(error as Error).message}`);
    }
  }

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function resolveConfigDirPath(configDir: ConfigDirResult | undefined): string {
  return configDir?.configDir ?? process.cwd();
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function resolveValueSourceForKey(
  key: string,
  valueSources: WorkerConfigValueSourceMap,
): string | undefined {
  const direct = valueSources[key];
  if (direct !== undefined) {
    return direct;
  }

  const prefix = `${key}.`;
  const nestedSources = Object.entries(valueSources)
    .filter(([pathKey]) => pathKey.startsWith(prefix))
    .map(([, source]) => source);
  if (nestedSources.length === 0) {
    return undefined;
  }

  const unique = new Set(nestedSources);
  if (unique.size === 1) {
    return nestedSources[0];
  }

  return "mixed";
}

function resolveGlobalPathForScope(
  scope: ConfigReadScope,
  paths: ReturnType<NonNullable<WorkerConfigPort["getConfigPaths"]>>,
): string {
  if (scope === "local") {
    return paths.localConfigPath;
  }

  if (scope === "global") {
    return paths.globalConfigPath ?? paths.globalCanonicalPath ?? "(unresolved)";
  }

  return paths.localConfigPath;
}

export function createConfigSet(
  dependencies: ConfigMutationDependencies,
): (options: ConfigSetOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return (options: ConfigSetOptions): number => {
    if (!dependencies.workerConfigPort.setValue) {
      throw new Error("The `config set` command is not available in this build.");
    }

    const parsedValue = parseConfigValue(options.value, options.valueType);
    const result = dependencies.workerConfigPort.setValue(resolveConfigDirPath(dependencies.configDir), {
      scope: options.scope,
      keyPath: options.key,
      value: parsedValue,
    });

    if (result.changed) {
      emit({ kind: "success", message: `Updated ${options.scope} config: ${options.key}` });
      emit({ kind: "info", message: `Path: ${result.configPath}` });
    } else {
      emit({ kind: "info", message: `No change: ${options.key} already has the requested value.` });
      emit({ kind: "info", message: `Path: ${result.configPath}` });
    }

    return EXIT_CODE_SUCCESS;
  };
}

export function createConfigUnset(
  dependencies: ConfigMutationDependencies,
): (options: ConfigUnsetOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return (options: ConfigUnsetOptions): number => {
    if (!dependencies.workerConfigPort.unsetValue) {
      throw new Error("The `config unset` command is not available in this build.");
    }

    const result = dependencies.workerConfigPort.unsetValue(resolveConfigDirPath(dependencies.configDir), {
      scope: options.scope,
      keyPath: options.key,
    });

    if (result.changed) {
      emit({ kind: "success", message: `Removed ${options.scope} config key: ${options.key}` });
      emit({ kind: "info", message: `Path: ${result.configPath}` });
    } else {
      emit({ kind: "info", message: `No change: ${options.key} was not set.` });
      emit({ kind: "info", message: `Path: ${result.configPath}` });
    }

    return EXIT_CODE_SUCCESS;
  };
}

export function createConfigGet(
  dependencies: ConfigMutationDependencies,
): (options: ConfigGetOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return (options: ConfigGetOptions): number => {
    if (!dependencies.workerConfigPort.readValue) {
      throw new Error("The `config get` command is not available in this build.");
    }

    const configDirPath = resolveConfigDirPath(dependencies.configDir);
    const value = dependencies.workerConfigPort.readValue(configDirPath, options.scope, options.key);
    if (value === undefined) {
      throw new Error(`Config key not found in ${options.scope} scope: ${options.key}`);
    }

    let source: string | undefined;
    if (options.showSource && options.scope === "effective") {
      const withSources = dependencies.workerConfigPort.loadWithSources?.(configDirPath);
      if (withSources) {
        source = resolveValueSourceForKey(options.key, withSources.valueSources);
      }
    }

    if (options.json) {
      const envelope: ConfigReadEnvelope = {
        scope: options.scope,
        value,
      };
      if (source !== undefined) {
        envelope.source = source;
      }
      emit({ kind: "text", text: JSON.stringify(envelope, null, 2) });
      return EXIT_CODE_SUCCESS;
    }

    emit({ kind: "text", text: stringifyValue(value) });
    if (source !== undefined) {
      emit({ kind: "info", message: `Source: ${source}` });
    }

    return EXIT_CODE_SUCCESS;
  };
}

export function createConfigList(
  dependencies: ConfigMutationDependencies,
): (options: ConfigListOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return (options: ConfigListOptions): number => {
    if (!dependencies.workerConfigPort.listValues) {
      throw new Error("The `config list` command is not available in this build.");
    }

    const configDirPath = resolveConfigDirPath(dependencies.configDir);
    const config = dependencies.workerConfigPort.listValues(configDirPath, options.scope);
    let valueSources: WorkerConfigValueSourceMap | undefined;

    if (options.showSource && options.scope === "effective") {
      valueSources = dependencies.workerConfigPort.loadWithSources?.(configDirPath).valueSources;
    }

    if (options.json) {
      const envelope: ConfigListEnvelope = {
        scope: options.scope,
        config,
      };
      if (valueSources) {
        envelope.sources = valueSources;
      }
      emit({ kind: "text", text: JSON.stringify(envelope, null, 2) });
      return EXIT_CODE_SUCCESS;
    }

    if (config === undefined) {
      emit({ kind: "text", text: "{}" });
    } else {
      emit({ kind: "text", text: JSON.stringify(config, null, 2) });
    }
    if (valueSources) {
      emit({ kind: "text", text: `Sources: ${JSON.stringify(valueSources, null, 2)}` });
    }

    return EXIT_CODE_SUCCESS;
  };
}

export function createConfigPath(
  dependencies: ConfigMutationDependencies,
): (options: ConfigPathOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return (options: ConfigPathOptions): number => {
    if (!dependencies.workerConfigPort.getConfigPaths) {
      throw new Error("The `config path` command is not available in this build.");
    }

    const configDirPath = resolveConfigDirPath(dependencies.configDir);
    const paths = dependencies.workerConfigPort.getConfigPaths(configDirPath);
    const resolvedPath = resolveGlobalPathForScope(options.scope, paths);

    const envelope: ConfigPathEnvelope = {
      scope: options.scope,
      path: resolvedPath,
    };
    emit({ kind: "text", text: JSON.stringify(envelope, null, 2) });

    return EXIT_CODE_SUCCESS;
  };
}
