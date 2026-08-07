import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createWorkerConfigAdapter } from "../../src/infrastructure/adapters/worker-config-adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  vi.restoreAllMocks();
});

beforeEach(() => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-config-home-"));
  tempDirs.push(isolatedHome);
  vi.spyOn(os, "homedir").mockReturnValue(isolatedHome);
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
  it("setValue writes local scoped key updates safely", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "local-default"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();
    const result = adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "profiles.plan",
      value: ["opencode", "run", "--model", "local-plan"],
    });

    expect(result).toEqual({
      configPath: path.join(configDir, "config.json"),
      changed: true,
    });
    expect(adapter.load(configDir)).toMatchObject({
      workers: {
        default: ["opencode", "run", "--model", "local-default"],
      },
      profiles: {
        plan: ["opencode", "run", "--model", "local-plan"],
      },
    });
  });

  it("setValue rejects unknown config key paths unless unsafe is explicit", () => {
    const configDir = makeTempConfigDir();
    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "agent.notes",
      value: "enabled",
    })).toThrow('Unknown config key path "agent.notes". Use --unsafe to write arbitrary keys.');

    expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(false);
  });

  it("setValue allows arbitrary key paths in unsafe mode", () => {
    const configDir = makeTempConfigDir();
    const adapter = createWorkerConfigAdapter();

    const result = adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "agent.notes",
      value: "enabled",
      unsafe: true,
    });

    expect(result?.changed).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf-8"))).toEqual({
      agent: {
        notes: "enabled",
      },
    });
  });

  it("setValue validates resulting schema before writing", () => {
    const configDir = makeTempConfigDir();
    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "workers.default",
      value: "opencode run",
    })).toThrow("Invalid worker config at workers.default: expected string array.");

    expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(false);
  });

  it("setValue writes global scope to discovered global path", () => {
    const configDir = makeTempConfigDir();
    const globalConfigPath = writeGlobalConfig("{}\n");

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    const result = adapter.setValue?.(configDir, {
      scope: "global",
      keyPath: "workers.default",
      value: ["opencode", "run", "--model", "global-default"],
    });

    expect(result).toEqual({
      configPath: globalConfigPath,
      changed: true,
    });
    expect(adapter.load(configDir)).toMatchObject({
      workers: {
        default: ["opencode", "run", "--model", "global-default"],
      },
    });
  });

  it("setValue creates canonical global config path when nothing is discovered", () => {
    const configDir = makeTempConfigDir();
    const canonicalDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-config-canonical-"));
    tempDirs.push(canonicalDir);
    const canonicalGlobalPath = path.join(canonicalDir, "rundown", "config.json");

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: undefined, canonicalPath: canonicalGlobalPath }),
    });

    const result = adapter.setValue?.(configDir, {
      scope: "global",
      keyPath: "profiles.research",
      value: ["opencode", "run", "--model", "global-research"],
    });

    expect(result).toEqual({
      configPath: canonicalGlobalPath,
      changed: true,
    });
    expect(fs.existsSync(canonicalGlobalPath)).toBe(true);
  });

  it("unsetValue removes nested local keys and prunes empty objects", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        profiles: {
          plan: ["opencode", "run", "--model", "local-plan"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();
    const result = adapter.unsetValue?.(configDir, {
      scope: "local",
      keyPath: "profiles.plan",
    });

    expect(result).toEqual({
      configPath,
      changed: true,
    });
    expect(fs.readFileSync(configPath, "utf-8")).toBe("{}\n");
  });

  it("setValue returns unchanged when existing value matches", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run"],
        },
      }, null, 2) + "\n",
    );
    const before = fs.readFileSync(configPath, "utf-8");

    const adapter = createWorkerConfigAdapter();
    const result = adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "workers.default",
      value: ["opencode", "run"],
    });

    expect(result).toEqual({
      configPath,
      changed: false,
    });
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("unsetValue returns unchanged when key path is absent", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(configDir, "{}\n");
    const before = fs.readFileSync(configPath, "utf-8");

    const adapter = createWorkerConfigAdapter();
    const result = adapter.unsetValue?.(configDir, {
      scope: "local",
      keyPath: "profiles.plan",
    });

    expect(result).toEqual({
      configPath,
      changed: false,
    });
    expect(fs.readFileSync(configPath, "utf-8")).toBe(before);
  });

  it("rejects setValue when local config JSON is malformed", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(configDir, "{not valid json");

    const adapter = createWorkerConfigAdapter();
    expect(() => adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "workers.default",
      value: ["opencode", "run"],
    })).toThrow(`Failed to parse worker config at "${configPath}": invalid JSON`);

    expect(fs.readFileSync(configPath, "utf-8")).toBe("{not valid json");
  });

  it("rejects setValue when key path traverses non-object values", () => {
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
    expect(() => adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "workers.default.command",
      value: ["impossible"],
      unsafe: true,
    })).toThrow("Cannot set config key \"workers.default.command\": \"workers.default\" is not an object.");
  });

  it("rejects unsafe key-path segments for setValue", () => {
    const configDir = makeTempConfigDir();

    const adapter = createWorkerConfigAdapter();
    expect(() => adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "workers.__proto__",
      value: ["opencode", "run"],
    })).toThrow("Invalid config key path \"workers.__proto__\": segment \"__proto__\" is not allowed.");
  });

  it("returns effective config value source attribution", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          interactive: ["opencode", "run", "--model", "local-interactive"],
        },
        profiles: {
          plan: ["opencode", "run", "--model", "local-plan"],
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "global-default"],
        },
        profiles: {
          plan: ["opencode", "run", "--model", "global-plan"],
          research: ["opencode", "run", "--model", "global-research"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    const loaded = adapter.loadWithSources?.(configDir);

    expect(loaded).toBeDefined();
    expect(loaded?.globalConfigPath).toBe(globalConfigPath);
    expect(loaded?.localConfigPath).toBe(path.join(configDir, "config.json"));
    expect(loaded?.valueSources).toMatchObject({
      "workers.default": "global",
      "workers.interactive": "local",
      "profiles.plan": "mixed",
      "profiles.research": "global",
      "traceStatistics.enabled": "built-in",
      "traceStatistics.fields": "built-in",
    });
  });

  it("attributes all effective values to local when only local config exists", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "local-default"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();
    const loaded = adapter.loadWithSources?.(configDir);

    expect(loaded).toBeDefined();
    expect(loaded?.globalConfigPath).toBeUndefined();
    expect(loaded?.valueSources).toMatchObject({
      "workers.default": "local",
      "traceStatistics.enabled": "built-in",
      "traceStatistics.fields": "built-in",
    });
  });

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

  it("readValue resolves scope-aware key reads", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "local"],
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "global"],
          interactive: ["opencode", "run", "--model", "global-interactive"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.readValue?.(configDir, "local", "workers.default")).toEqual([
      "opencode",
      "run",
      "--model",
      "local",
    ]);
    expect(adapter.readValue?.(configDir, "global", "workers.default")).toEqual([
      "opencode",
      "run",
      "--model",
      "global",
    ]);
    expect(adapter.readValue?.(configDir, "effective", "workers.default")).toEqual([
      "opencode",
      "run",
      "--model",
      "local",
    ]);
    expect(adapter.readValue?.(configDir, "effective", "workers.interactive")).toEqual([
      "opencode",
      "run",
      "--model",
      "global-interactive",
    ]);
  });

  it("listValues returns scoped config documents", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        profiles: {
          plan: ["opencode", "run", "--model", "local-plan"],
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "global-default"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.listValues?.(configDir, "global")).toEqual({
      workers: {
        default: ["opencode", "run", "--model", "global-default"],
      },
    });
    expect(adapter.listValues?.(configDir, "local")).toEqual({
      profiles: {
        plan: ["opencode", "run", "--model", "local-plan"],
      },
    });
    expect(adapter.listValues?.(configDir, "effective")).toEqual({
      workers: {
        default: ["opencode", "run", "--model", "global-default"],
      },
      profiles: {
        plan: ["opencode", "run", "--model", "local-plan"],
      },
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("loads workerTimeoutMs when configured", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workerTimeoutMs: 2500,
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workerTimeoutMs: 2500,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("loads workerTimeoutMs when explicitly disabled with zero", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workerTimeoutMs: 0,
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workerTimeoutMs: 0,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("merges workerTimeoutMs with local override semantics", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workerTimeoutMs: 500,
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workerTimeoutMs: 2_000,
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.readValue?.(configDir, "global", "workerTimeoutMs")).toBe(2_000);
    expect(adapter.readValue?.(configDir, "local", "workerTimeoutMs")).toBe(500);
    expect(adapter.readValue?.(configDir, "effective", "workerTimeoutMs")).toBe(500);
  });

  it("supports workerTimeoutMs dotted-path set and unset", () => {
    const configDir = makeTempConfigDir();
    writeConfig(configDir, "{}\n");

    const adapter = createWorkerConfigAdapter();
    expect(adapter.setValue?.(configDir, {
      scope: "local",
      keyPath: "workerTimeoutMs",
      value: 0,
    })).toEqual({
      configPath: path.join(configDir, "config.json"),
      changed: true,
    });

    expect(adapter.readValue?.(configDir, "local", "workerTimeoutMs")).toBe(0);
    expect(adapter.listValues?.(configDir, "local")).toEqual({
      workerTimeoutMs: 0,
    });

    expect(adapter.unsetValue?.(configDir, {
      scope: "local",
      keyPath: "workerTimeoutMs",
    })).toEqual({
      configPath: path.join(configDir, "config.json"),
      changed: true,
    });

    expect(adapter.readValue?.(configDir, "local", "workerTimeoutMs")).toBeUndefined();
  });

  it("merges global defaults with local overrides", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          interactive: ["opencode", "run", "--model", "local-interactive"],
        },
        profiles: {
          plan: ["opencode", "run", "--model", "local-plan"],
          fast: ["opencode", "run", "--model", "local-fast"],
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "global-default"],
        },
        profiles: {
          plan: ["opencode", "run", "--model", "global-plan"],
          research: ["opencode", "run", "--model", "global-research"],
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
        interactive: ["opencode", "run", "--model", "local-interactive"],
      },
      profiles: {
        plan: ["opencode", "run", "--model", "local-plan"],
        research: ["opencode", "run", "--model", "global-research"],
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

  it("loads run defaults from config", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        run: {
          revertable: true,
          commit: true,
          commitMessage: "done: {{task}}",
          commitMode: "file-done",
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      run: {
        revertable: true,
        commit: true,
        commitMessage: "done: {{task}}",
        commitMode: "file-done",
      },
    });
  });

  it("merges run defaults with local values overriding global", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        run: {
          commitMessage: "local message",
          commitMode: "per-task",
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        run: {
          revertable: true,
          commit: true,
          commitMessage: "global message",
          commitMode: "file-done",
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      run: {
        revertable: true,
        commit: true,
        commitMessage: "local message",
        commitMode: "per-task",
      },
    });
  });

  it("loads autoCompact defaults when configured", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        autoCompact: {
          beforeExit: true,
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      autoCompact: {
        beforeExit: true,
      },
    });
  });

  it("merges autoCompact defaults with local values overriding global", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        autoCompact: {
          beforeExit: true,
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        autoCompact: {
          beforeExit: false,
        },
      }),
    );

    const adapter = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({ discoveredPath: globalConfigPath }),
    });

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      autoCompact: {
        beforeExit: true,
      },
    });
  });

  it("rejects invalid autoCompact.beforeExit values", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        autoCompact: {
          beforeExit: "yes",
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at "${configPath}": Invalid worker config at autoCompact.beforeExit: expected boolean.`,
    );
  });

  it("rejects invalid run.commitMode values", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        run: {
          commitMode: "later",
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at "${configPath}": Invalid worker config at run.commitMode: expected one of per-task, file-done.`,
    );
  });

  it("rejects non-integer workerTimeoutMs values", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        workerTimeoutMs: 2500.5,
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at "${configPath}": Invalid worker config at workerTimeoutMs: expected non-negative integer.`,
    );
  });

  it("rejects negative workerTimeoutMs values", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(
      configDir,
      JSON.stringify({
        workerTimeoutMs: -1,
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at "${configPath}": Invalid worker config at workerTimeoutMs: expected non-negative integer.`,
    );
  });

  it("drops legacy command routing config from loaded config", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        run: {
          workerRouting: {
            verify: { worker: ["opencode", "run", "--model", "verify-model"] },
          },
          commit: true,
        },
        commands: {
          plan: {
            worker: ["opencode", "run", "--model", "plan-model"],
          },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: undefined,
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
      run: {
        commit: true,
      },
    });
  });

  it("migrates legacy workers.tui to workers.interactive while loading", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run"],
          tui: ["opencode"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: {
        default: ["opencode", "run"],
        interactive: ["opencode"],
      },
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("prefers workers.interactive over legacy workers.tui when both are present", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          tui: ["legacy", "worker"],
          interactive: ["interactive", "worker"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)?.workers).toEqual({
      interactive: ["interactive", "worker"],
    });
  });

  it("uses replace semantics for arrays and map entries during layering", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "local-default"],
        },
        fallbacks: {
          default: [["codex", "exec"]],
          fast: [["local", "fast", "fallback"]],
        },
        profiles: {
          plan: ["opencode", "run", "--model", "local-plan"],
          fast: ["opencode", "run", "--model", "local-fast"],
        },
      }),
    );
    const globalConfigPath = writeGlobalConfig(
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--model", "global-default"],
        },
        fallbacks: {
          default: [["claude", "-p", "$bootstrap"], ["aider", "--message-file", "$file"]],
          fast: [["global", "fast", "fallback"]],
          deep: [["global", "deep", "fallback"]],
        },
        profiles: {
          plan: ["opencode", "run", "--model", "global-plan"],
          research: ["opencode", "run", "--model", "global-research"],
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
      },
      fallbacks: {
        default: [["codex", "exec"]],
        fast: [["local", "fast", "fallback"]],
        deep: [["global", "deep", "fallback"]],
      },
      profiles: {
        plan: ["opencode", "run", "--model", "local-plan"],
        research: ["opencode", "run", "--model", "global-research"],
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

    try {
      adapter.load(configDir);
      throw new Error("Expected adapter.load to throw for malformed global JSON.");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(`Failed to parse global worker config at "${globalConfigPath}": invalid JSON`);
      expect(message).toContain(`Repair guidance: ensure "${globalConfigPath}" contains valid JSON with a top-level object`);
      expect(message).toContain("rundown config set");
    }
  });

  it("throws when config.json contains malformed JSON", () => {
    const configDir = makeTempConfigDir();
    const configPath = writeConfig(configDir, "{not valid json");

    const adapter = createWorkerConfigAdapter();

    try {
      adapter.load(configDir);
      throw new Error("Expected adapter.load to throw for malformed local JSON.");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain(`Failed to parse worker config at "${configPath}": invalid JSON`);
      expect(message).toContain(`Repair guidance: ensure "${configPath}" contains valid JSON with a top-level object`);
      expect(message).toContain("rundown init --overwrite-config");
    }
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
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("loads config with workers.interactive and explicit fallbacks", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "$bootstrap"],
          interactive: ["opencode", "$bootstrap"],
        },
        fallbacks: {
          default: [
            ["claude", "-p", "$bootstrap"],
            ["aider", "--message-file", "$file"],
          ],
          fast: [
            ["codex", "exec", "$bootstrap"],
          ],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      workers: {
        default: ["opencode", "run", "$bootstrap"],
        interactive: ["opencode", "$bootstrap"],
      },
      fallbacks: {
        default: [
          ["claude", "-p", "$bootstrap"],
          ["aider", "--message-file", "$file"],
        ],
        fast: [
          ["codex", "exec", "$bootstrap"],
        ],
      },
      profiles: undefined,
      traceStatistics: {
        enabled: false,
        fields: ["total_time", "tokens_estimated"],
      },
    });
  });

  it("migrates legacy workers.fallbacks into fallbacks.default on load", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "$bootstrap"],
          fallbacks: [
            ["claude", "-p", "$bootstrap"],
          ],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)?.fallbacks).toEqual({
      default: [
        ["claude", "-p", "$bootstrap"],
      ],
    });
  });

  it("loads full config with workers and profiles", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        workers: {
          default: ["opencode", "run", "--color", "always"],
        },
        profiles: {
          plan: ["opencode", "run", "--model", "opus-4.6"],
          research: ["opencode", "run", "--model", "opus-4.6"],
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
      profiles: {
        plan: ["opencode", "run", "--model", "opus-4.6"],
        research: ["opencode", "run", "--model", "opus-4.6"],
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
