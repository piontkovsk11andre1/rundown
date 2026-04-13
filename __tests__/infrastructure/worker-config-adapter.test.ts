import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerConfigAdapter } from "../../src/infrastructure/adapters/worker-config-adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempConfigDir(): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-config-"));
  tempDirs.push(projectDir);
  const configDir = path.join(projectDir, ".rundown");
  fs.mkdirSync(configDir, { recursive: true });
  return configDir;
}

function writeConfig(configDir: string, source: string): string {
  const configPath = path.join(configDir, "config.json");
  fs.writeFileSync(configPath, source, "utf-8");
  return configPath;
}

function makeTempFilePath(fileName: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-config-global-"));
  tempDirs.push(dir);
  return path.join(dir, fileName);
}

function writeGlobalConfig(source: string): string {
  const configPath = makeTempFilePath("global-config.json");
  fs.writeFileSync(configPath, source, "utf-8");
  return configPath;
}

describe("createWorkerConfigAdapter", () => {
  it("loads a valid config", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
        profiles: {
          fast: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();
    const loaded = adapter.load(configDir);

    expect(loaded).toEqual({
      workers: {
        default: ["opencode", "run", "--model", "gpt-5.3-codex"],
      },
      profiles: {
        fast: ["opencode", "run", "--model", "gpt-5.3-codex"],
      },
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("returns undefined when config.json does not exist", () => {
    const configDir = makeTempConfigDir();

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toBeUndefined();
  });

  it("loads global config when local config is missing", () => {
    const configDir = makeTempConfigDir();
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "global"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.load(configDir)).toEqual({
      workers: {
        default: ["opencode", "run", "--model", "global"],
      },
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("merges global defaults with local overrides", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          tui: ["opencode", "run", "--model", "local-tui"],
        },
        commands: {
          plan: ["opencode", "run", "--model", "local-plan"],
        },
        profiles: {
          fast: ["opencode", "run", "--model", "local-fast"],
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "global-default"],
        },
        commands: {
          plan: ["opencode", "run", "--model", "global-plan"],
          research: ["opencode", "run", "--model", "global-research"],
        },
        profiles: {
          fast: ["opencode", "run", "--model", "global-fast"],
          deep: ["opencode", "run", "--model", "global-deep"],
        },
        healthPolicy: {
          maxFailoverAttemptsPerTask: 3,
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.load(configDir)).toEqual({
      workers: {
        default: ["opencode", "run", "--model", "global-default"],
        tui: ["opencode", "run", "--model", "local-tui"],
      },
      commands: {
        plan: ["opencode", "run", "--model", "local-plan"],
        research: ["opencode", "run", "--model", "global-research"],
      },
      profiles: {
        fast: ["opencode", "run", "--model", "local-fast"],
        deep: ["opencode", "run", "--model", "global-deep"],
      },
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      healthPolicy: {
        maxFailoverAttemptsPerTask: 3,
      },
    });
  });

  it("deep-merges nested healthPolicy objects with local keys overriding global keys", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        healthPolicy: {
          cooldownSecondsByFailureClass: {
            transport_unavailable: 30,
          },
          unavailableReevaluation: {
            probeCooldownSeconds: 45,
          },
          maxFailoverAttemptsPerRun: 9,
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        healthPolicy: {
          cooldownSecondsByFailureClass: {
            usage_limit: 120,
            transport_unavailable: 60,
          },
          unavailableReevaluation: {
            mode: "cooldown",
          },
          maxFailoverAttemptsPerTask: 2,
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      commands: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      healthPolicy: {
        cooldownSecondsByFailureClass: {
          usage_limit: 120,
          transport_unavailable: 30,
        },
        unavailableReevaluation: {
          mode: "cooldown",
          probeCooldownSeconds: 45,
        },
        maxFailoverAttemptsPerTask: 2,
        maxFailoverAttemptsPerRun: 9,
      },
    });
  });

  it("keeps global nested healthPolicy values when local nested objects are empty", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        healthPolicy: {
          cooldownSecondsByFailureClass: {},
          unavailableReevaluation: {},
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        healthPolicy: {
          cooldownSecondsByFailureClass: {
            usage_limit: 90,
          },
          unavailableReevaluation: {
            mode: "manual",
          },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      commands: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      healthPolicy: {
        cooldownSecondsByFailureClass: {
          usage_limit: 90,
        },
        unavailableReevaluation: {
          mode: "manual",
        },
      },
    });
  });

  it("uses replace semantics for arrays and map entries during layering", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "local-default"],
          fallbacks: [["codex", "exec"]],
        },
        commands: {
          plan: ["opencode", "run", "--model", "local-plan"],
        },
        profiles: {
          fast: ["opencode", "run", "--model", "local-fast"],
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "global-default"],
          fallbacks: [["claude", "-p", "$bootstrap"], ["aider", "--message-file", "$file"]],
        },
        commands: {
          plan: ["opencode", "run", "--model", "global-plan"],
          research: ["opencode", "run", "--model", "global-research"],
        },
        profiles: {
          fast: ["opencode", "run", "--model", "global-fast"],
          deep: ["opencode", "run", "--model", "global-deep"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.load(configDir)).toEqual({
      workers: {
        default: ["opencode", "run", "--model", "local-default"],
        fallbacks: [["codex", "exec"]],
      },
      commands: {
        plan: ["opencode", "run", "--model", "local-plan"],
        research: ["opencode", "run", "--model", "global-research"],
      },
      profiles: {
        fast: ["opencode", "run", "--model", "local-fast"],
        deep: ["opencode", "run", "--model", "global-deep"],
      },
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("throws with clear message when global config JSON is malformed", () => {
    const configDir = makeTempConfigDir();
    const globalConfigPath = writeGlobalConfig("{not valid json");

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(() => adapter.load(configDir)).toThrow(
      `Failed to parse global worker config at \"${globalConfigPath}\": invalid JSON`,
    );
  });

  it("throws when config.json contains malformed JSON", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(configDir, "{not valid json");

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Failed to parse worker config at \"${configPath}\": invalid JSON`,
    );
  });

  it("throws with descriptive message for invalid schema", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: "opencode run",
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at workers.default: expected string array.`,
    );
  });

  it("loads minimal config with workers.default only", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: {
        default: ["opencode", "run"],
      },
      commands: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("loads config with workers.tui and workers.fallbacks", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "$bootstrap"],
          tui: ["opencode", "$bootstrap"],
          fallbacks: [
            ["claude", "-p", "$bootstrap"],
            ["aider", "--message-file", "$file"],
          ],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: {
        default: ["opencode", "run", "$bootstrap"],
        tui: ["opencode", "$bootstrap"],
        fallbacks: [
          ["claude", "-p", "$bootstrap"],
          ["aider", "--message-file", "$file"],
        ],
      },
      commands: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("loads full config with workers, commands, and profiles", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--color", "always"],
        },
        commands: {
          plan: ["opencode", "run", "--model", "opus-4.6"],
          research: ["opencode", "run", "--model", "opus-4.6"],
          discuss: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
        profiles: {
          complex: ["opencode", "run", "--model", "opus-4.6"],
          fast: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: {
        default: ["opencode", "run", "--color", "always"],
      },
      commands: {
        plan: ["opencode", "run", "--model", "opus-4.6"],
        research: ["opencode", "run", "--model", "opus-4.6"],
        discuss: ["opencode", "run", "--model", "gpt-5.3-codex"],
      },
      profiles: {
        complex: ["opencode", "run", "--model", "opus-4.6"],
        fast: ["opencode", "run", "--model", "gpt-5.3-codex"],
      },
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("loads explicit traceStatistics config", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        traceStatistics: {
          enabled: true,
          fields: ["total_time", "verify_time", "repair_attempts"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      commands: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: true,
        fields: ["total_time", "verify_time", "repair_attempts"],
      },
    });
  });

  it("rejects unknown trace statistics fields", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        traceStatistics: {
          enabled: true,
          fields: ["total_time", "mystery_metric"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at traceStatistics.fields: unknown field \"mystery_metric\". Allowed: total_time, execution_time, verify_time, repair_time, idle_time, tokens_estimated, phases_count, verify_attempts, repair_attempts.`,
    );
  });

  it("reports actionable details for unknown trace statistics fields", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        traceStatistics: {
          enabled: true,
          fields: ["total_time", "tokens_estimated", "surprise_metric"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    try {
      adapter.load(configDir);
      throw new Error("Expected adapter.load to throw for unknown trace statistic field.");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Invalid worker config at");
      expect(message).toContain("traceStatistics.fields");
      expect(message).toContain('unknown field "surprise_metric"');
      expect(message).toContain("Allowed:");
      expect(message).toContain("total_time");
      expect(message).toContain("tokens_estimated");
      expect(message).toContain("verify_attempts");
    }
  });

  it("rejects unknown command keys in commands config", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        commands: {
          execute: ["opencode", "run"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    try {
      adapter.load(configDir);
      throw new Error("Expected adapter.load to throw for unknown command key.");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(`Invalid worker config at \"${configPath}\"`);
      expect(message).toContain("Invalid worker config at commands.execute: unknown command.");
      expect(message).toContain("Allowed:");
      expect(message).toContain("help");
      expect(message).toContain("run");
      expect(message).toContain("migrate-slug");
      expect(message).toContain("plan");
      expect(message).toContain("tools.{toolName}");
    }
  });

  it("rejects non-array command values", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        commands: {
          run: { worker: ["opencode"] },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at commands.run: expected string array.`,
    );
  });

  it("rejects non-array profile values", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        profiles: {
          fast: { workerArgs: ["--model", "gpt"] },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at profiles.fast: expected string array.`,
    );
  });

  it("loads healthPolicy config fields", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        healthPolicy: {
          cooldownSecondsByFailureClass: {
            usage_limit: 120,
            transport_unavailable: 45,
            execution_failure_other: 5,
          },
          maxFailoverAttemptsPerTask: 3,
          maxFailoverAttemptsPerRun: 7,
          fallbackStrategy: "strict_order",
          unavailableReevaluation: {
            mode: "cooldown",
            probeCooldownSeconds: 300,
          },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      commands: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      healthPolicy: {
        cooldownSecondsByFailureClass: {
          usage_limit: 120,
          transport_unavailable: 45,
          execution_failure_other: 5,
        },
        maxFailoverAttemptsPerTask: 3,
        maxFailoverAttemptsPerRun: 7,
        fallbackStrategy: "strict_order",
        unavailableReevaluation: {
          mode: "cooldown",
          probeCooldownSeconds: 300,
        },
      },
    });
  });

  it("rejects unknown healthPolicy fallback strategy", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        healthPolicy: {
          fallbackStrategy: "randomized",
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at healthPolicy.fallbackStrategy: expected one of strict_order, priority.`,
    );
  });

  it("rejects invalid healthPolicy cooldown values", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        healthPolicy: {
          cooldownSecondsByFailureClass: {
            usage_limit: -1,
          },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at healthPolicy.cooldownSecondsByFailureClass.usage_limit: expected non-negative number.`,
    );
  });

  it("rejects invalid healthPolicy failover attempt limits", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        healthPolicy: {
          maxFailoverAttemptsPerTask: 0,
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at healthPolicy.maxFailoverAttemptsPerTask: expected positive integer.`,
    );
  });

  it("rejects unknown unavailable reevaluation mode", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        healthPolicy: {
          unavailableReevaluation: {
            mode: "always",
          },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at healthPolicy.unavailableReevaluation.mode: expected one of manual, cooldown.`,
    );
  });
});
