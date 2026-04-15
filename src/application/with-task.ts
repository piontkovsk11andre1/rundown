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

function resolveConfigDirPath(configDir: ConfigDirResult | undefined): string {
  return configDir?.configDir ?? process.cwd();
}

function hasPresetFallbackPolicy(presetPayload: { workers: { fallbacks?: string[][] } }): boolean {
  return Object.hasOwn(presetPayload.workers, "fallbacks");
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

    const defaultResult = dependencies.workerConfigPort.setValue(configDirPath, {
      scope: "local",
      keyPath: "workers.default",
      value: presetPayload.workers.default,
    });

    const tuiResult = presetPayload.workers.tui
      ? dependencies.workerConfigPort.setValue(configDirPath, {
        scope: "local",
        keyPath: "workers.tui",
        value: presetPayload.workers.tui,
      })
      : dependencies.workerConfigPort.unsetValue(configDirPath, {
        scope: "local",
        keyPath: "workers.tui",
      });

    const discussResult = presetPayload.commands?.discuss
      ? dependencies.workerConfigPort.setValue(configDirPath, {
        scope: "local",
        keyPath: "commands.discuss",
        value: presetPayload.commands.discuss,
      })
      : dependencies.workerConfigPort.unsetValue(configDirPath, {
        scope: "local",
        keyPath: "commands.discuss",
      });

    const fallbackResult = hasPresetFallbackPolicy(presetPayload)
      ? (presetPayload.workers.fallbacks && presetPayload.workers.fallbacks.length > 0
        ? dependencies.workerConfigPort.setValue(configDirPath, {
          scope: "local",
          keyPath: "workers.fallbacks",
          value: presetPayload.workers.fallbacks,
        })
        : dependencies.workerConfigPort.unsetValue(configDirPath, {
          scope: "local",
          keyPath: "workers.fallbacks",
        }))
      : undefined;

    const configPath = defaultResult.configPath;
    const changed = defaultResult.changed
      || tuiResult.changed
      || discussResult.changed
      || fallbackResult?.changed === true;

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
