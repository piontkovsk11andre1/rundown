import { EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import {
  getHarnessPresetPayload,
  listHarnessPresetKeys,
  resolveHarnessPresetKey,
} from "../domain/harness-preset-registry.js";
import type { ConfigDirResult } from "../domain/ports/config-dir-port.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { WorkerConfigPort } from "../domain/ports/worker-config-port.js";

export interface WithTaskOptions {
  harness: string;
}

export interface WithTaskDependencies {
  workerConfigPort: WorkerConfigPort;
  configDir: ConfigDirResult | undefined;
  output: ApplicationOutputPort;
}

function resolveConfigDirPath(configDir: ConfigDirResult | undefined): string {
  return configDir?.configDir ?? process.cwd();
}

function formatWorkerCommand(command: readonly string[]): string {
  return JSON.stringify(command);
}

function formatConfiguredKeyLine(keyPath: string, value: string): string {
  return `- ${keyPath} = ${value}`;
}

function formatRemovedKeyLine(keyPath: string): string {
  return `- ${keyPath} (removed)`;
}

function formatPreservedKeyLine(keyPath: string): string {
  return `- ${keyPath} (preserved)`;
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
): (options: WithTaskOptions) => number {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return (options: WithTaskOptions): number => {
    const harnessKey = resolveHarnessPresetKey(options.harness);
    if (!harnessKey) {
      throw new Error(
        `Unknown harness preset: ${options.harness}. Supported presets: ${listHarnessPresetKeys().join(", ")}.`,
      );
    }

    if (!dependencies.workerConfigPort.setValue || !dependencies.workerConfigPort.unsetValue) {
      throw new Error("The `with` command is not available in this build.");
    }

    const configDirPath = resolveConfigDirPath(dependencies.configDir);
    const presetPayload = getHarnessPresetPayload(harnessKey);

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

    emit({
      kind: changed ? "success" : "info",
      message: changed
        ? `Applied harness preset: ${harnessKey}`
        : `No change: harness preset ${harnessKey} is already configured.`,
    });
    emit({ kind: "info", message: `Path: ${configPath}` });
    emit({ kind: "info", message: "Configured keys:" });
    emit({
      kind: "info",
      message: formatConfiguredKeyLine(
        "workers.default",
        formatWorkerCommand(presetPayload.workers.default),
      ),
    });
    emit({
      kind: "info",
      message: presetPayload.workers.tui
        ? formatConfiguredKeyLine(
          "workers.tui",
          formatWorkerCommand(presetPayload.workers.tui),
        )
        : formatRemovedKeyLine("workers.tui"),
    });
    emit({
      kind: "info",
      message: presetPayload.commands?.discuss
        ? formatConfiguredKeyLine(
          "commands.discuss",
          formatWorkerCommand(presetPayload.commands.discuss),
        )
        : formatRemovedKeyLine("commands.discuss"),
    });
    emit({
      kind: "info",
      message: hasPresetFallbackPolicy(presetPayload)
        ? (presetPayload.workers.fallbacks && presetPayload.workers.fallbacks.length > 0
          ? formatConfiguredKeyLine(
            "workers.fallbacks",
            JSON.stringify(presetPayload.workers.fallbacks),
          )
          : formatRemovedKeyLine("workers.fallbacks"))
        : formatPreservedKeyLine("workers.fallbacks"),
    });

    return EXIT_CODE_SUCCESS;
  };
}
