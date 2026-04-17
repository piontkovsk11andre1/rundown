import path from "node:path";
import { EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import {
  getHarnessPresetPayload,
  resolveHarnessPresetKey,
  normalizeHarnessPresetAlias,
  type HarnessPresetPayload,
} from "../domain/harness-preset-registry.js";
import type { ConfigDirResult } from "../domain/ports/config-dir-port.js";
import type { InteractiveInputPort } from "../domain/ports/interactive-input-port.js";
import type { WorkerConfigPort } from "../domain/ports/worker-config-port.js";
import { parseWorkerPattern } from "../domain/worker-pattern.js";

export interface WithTaskOptions {
  harness: string;
}

export interface WithTaskDependencies {
  workerConfigPort: WorkerConfigPort;
  configDir: ConfigDirResult | undefined;
  interactiveInput: InteractiveInputPort;
}

export interface WithTaskConfiguredKeyResult {
  keyPath: "workers.default" | "workers.tui" | "commands.discuss" | "workers.fallbacks";
  status: "set" | "removed" | "preserved";
  value?: readonly string[] | readonly string[][];
}

export interface WithTaskResult {
  exitCode: number;
  harnessKey: string;
  source: "preset" | "custom";
  changed: boolean;
  configPath: string;
  configuredKeys: readonly WithTaskConfiguredKeyResult[];
}

type WithTaskMutableKeyPath = Exclude<WithTaskConfiguredKeyResult["keyPath"], "workers.fallbacks"> | "workers.fallbacks";

interface WithTaskMutationPlanItem {
  keyPath: WithTaskMutableKeyPath;
  action: "set" | "unset";
  value?: readonly string[] | readonly string[][];
}

function resolveConfigDirPath(configDir: ConfigDirResult | undefined): string {
  return configDir?.configDir ?? process.cwd();
}

function hasPresetFallbackPolicy(presetPayload: { workers: { fallbacks?: string[][] } }): boolean {
  return Object.hasOwn(presetPayload.workers, "fallbacks");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function areConfigValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false;
    }

    for (let index = 0; index < left.length; index += 1) {
      if (!areConfigValuesEqual(left[index], right[index])) {
        return false;
      }
    }

    return true;
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }

    for (const key of leftKeys) {
      if (!Object.hasOwn(right, key)) {
        return false;
      }

      if (!areConfigValuesEqual(left[key], right[key])) {
        return false;
      }
    }

    return true;
  }

  return false;
}

function buildPresetMutationPlan(presetPayload: HarnessPresetPayload): WithTaskMutationPlanItem[] {
  const mutationPlan: WithTaskMutationPlanItem[] = [
    {
      keyPath: "workers.default",
      action: "set",
      value: presetPayload.workers.default,
    },
    presetPayload.workers.tui
      ? {
        keyPath: "workers.tui",
        action: "set",
        value: presetPayload.workers.tui,
      }
      : {
        keyPath: "workers.tui",
        action: "unset",
      },
    presetPayload.commands?.discuss
      ? {
        keyPath: "commands.discuss",
        action: "set",
        value: presetPayload.commands.discuss,
      }
      : {
        keyPath: "commands.discuss",
        action: "unset",
      },
  ];

  if (hasPresetFallbackPolicy(presetPayload)) {
    mutationPlan.push(
      presetPayload.workers.fallbacks && presetPayload.workers.fallbacks.length > 0
        ? {
          keyPath: "workers.fallbacks",
          action: "set",
          value: presetPayload.workers.fallbacks,
        }
        : {
          keyPath: "workers.fallbacks",
          action: "unset",
        },
    );
  }

  return mutationPlan;
}

function shouldApplyLocalMutation(
  mutation: WithTaskMutationPlanItem,
  localValue: unknown,
  effectiveValue: unknown,
): boolean {
  if (mutation.action === "unset") {
    return localValue !== undefined;
  }

  if (areConfigValuesEqual(localValue, mutation.value)) {
    return false;
  }

  if (localValue === undefined && areConfigValuesEqual(effectiveValue, mutation.value)) {
    return false;
  }

  return true;
}

function resolveLocalConfigPath(dependencies: WithTaskDependencies, configDirPath: string): string {
  const paths = dependencies.workerConfigPort.getConfigPaths?.(configDirPath);
  return paths?.localConfigPath ?? path.join(configDirPath, "config.json");
}

/**
 * Creates the `with` command use case.
 *
 * Applies the selected harness preset by mutating only targeted worker and
 * command keys in local config, preserving all unrelated settings.
 */
export function createWithTask(
  dependencies: WithTaskDependencies,
): (options: WithTaskOptions) => Promise<WithTaskResult> {
  return async (options: WithTaskOptions): Promise<WithTaskResult> => {
    const harnessKey = resolveHarnessPresetKey(options.harness);

    if (!dependencies.workerConfigPort.setValue || !dependencies.workerConfigPort.unsetValue) {
      throw new Error("The `with` command is not available in this build.");
    }

    const configDirPath = resolveConfigDirPath(dependencies.configDir);
    const resultSource = harnessKey ? "preset" : "custom";
    const resolvedHarnessKey = (harnessKey
      ?? normalizeHarnessPresetAlias(options.harness))
      || options.harness.trim();
    const presetPayload = harnessKey
      ? getHarnessPresetPayload(harnessKey)
      : await promptUnknownHarnessPreset(options.harness, dependencies.interactiveInput);

    const mutationPlan = buildPresetMutationPlan(presetPayload);
    const plannedMutations = mutationPlan.filter((mutation) => {
      const localValue = dependencies.workerConfigPort.readValue?.(
        configDirPath,
        "local",
        mutation.keyPath,
      );
      const effectiveValue = dependencies.workerConfigPort.readValue?.(
        configDirPath,
        "effective",
        mutation.keyPath,
      );

      if (localValue === undefined && effectiveValue === undefined) {
        return true;
      }

      return shouldApplyLocalMutation(mutation, localValue, effectiveValue);
    });

    let changed = false;
    let configPath = resolveLocalConfigPath(dependencies, configDirPath);

    for (const mutation of plannedMutations) {
      const mutationResult = mutation.action === "set"
        ? dependencies.workerConfigPort.setValue(configDirPath, {
          scope: "local",
          keyPath: mutation.keyPath,
          value: mutation.value,
        })
        : dependencies.workerConfigPort.unsetValue(configDirPath, {
          scope: "local",
          keyPath: mutation.keyPath,
        });

      configPath = mutationResult.configPath;
      changed = changed || mutationResult.changed;
    }

    return {
      exitCode: EXIT_CODE_SUCCESS,
      harnessKey: resolvedHarnessKey,
      source: resultSource,
      changed,
      configPath,
      configuredKeys: [
        {
          keyPath: "workers.default",
          status: "set",
          value: [...presetPayload.workers.default],
        },
        presetPayload.workers.tui
          ? {
            keyPath: "workers.tui",
            status: "set",
            value: [...presetPayload.workers.tui],
          }
          : {
            keyPath: "workers.tui",
            status: "removed",
          },
        presetPayload.commands?.discuss
          ? {
            keyPath: "commands.discuss",
            status: "set",
            value: [...presetPayload.commands.discuss],
          }
          : {
            keyPath: "commands.discuss",
            status: "removed",
          },
        hasPresetFallbackPolicy(presetPayload)
          ? (presetPayload.workers.fallbacks && presetPayload.workers.fallbacks.length > 0
            ? {
              keyPath: "workers.fallbacks",
              status: "set",
              value: presetPayload.workers.fallbacks.map((command) => [...command]),
            }
            : {
              keyPath: "workers.fallbacks",
              status: "removed",
            })
          : {
            keyPath: "workers.fallbacks",
            status: "preserved",
          },
      ],
    };
  };
}

async function promptUnknownHarnessPreset(
  harness: string,
  interactiveInput: InteractiveInputPort,
): Promise<HarnessPresetPayload> {
  const suggestedBaseCommand = normalizeHarnessPresetAlias(harness) || "worker";
  const defaultWorkerPrompt = `${suggestedBaseCommand} run --file $file $bootstrap`;
  const tuiWorkerPrompt = suggestedBaseCommand;

  if (interactiveInput.prepareForPrompt) {
    await interactiveInput.prepareForPrompt();
  }

  const defaultWorkerResult = await interactiveInput.prompt({
    kind: "text",
    message: `Unknown harness \"${harness}\". Enter deterministic CLI invocation (workers.default)`,
    defaultValue: defaultWorkerPrompt,
    required: true,
  });

  const configureTuiResult = await interactiveInput.prompt({
    kind: "confirm",
    message: "Configure a separate interactive invocation for workers.tui and commands.discuss?",
    defaultValue: true,
  });
  const shouldConfigureTui = configureTuiResult.value.trim().toLowerCase() === "true";

  const defaultWorker = parseWorkerPattern(defaultWorkerResult.value).command;

  if (!shouldConfigureTui) {
    return {
      workers: {
        default: defaultWorker,
      },
    };
  }

  const tuiWorkerResult = await interactiveInput.prompt({
    kind: "text",
    message: "Enter interactive invocation (workers.tui / commands.discuss)",
    defaultValue: tuiWorkerPrompt,
    required: true,
  });
  const tuiWorker = parseWorkerPattern(tuiWorkerResult.value).command;

  return {
    workers: {
      default: defaultWorker,
      tui: tuiWorker,
    },
    commands: {
      discuss: tuiWorker,
    },
  };
}
