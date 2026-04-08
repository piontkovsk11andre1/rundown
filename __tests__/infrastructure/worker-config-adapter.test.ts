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

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at commands.execute: unknown command. Allowed: help, run, plan, discuss, research, reverify, verify, memory, or tools.{toolName}.`,
    );
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
});
