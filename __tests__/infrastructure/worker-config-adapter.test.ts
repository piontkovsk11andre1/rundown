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
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--model", "gpt-5.3-codex"],
        },
        profiles: {
          fast: {
            workerArgs: ["--model", "gpt-5.3-codex"],
          },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();
    const loaded = adapter.load(configDir);

    expect(loaded).toEqual({
      defaults: {
        worker: ["opencode", "run"],
        workerArgs: ["--model", "gpt-5.3-codex"],
      },
      profiles: {
        fast: {
          workerArgs: ["--model", "gpt-5.3-codex"],
        },
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
        defaults: {
          worker: "opencode run",
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(() => adapter.load(configDir)).toThrow(
      `Invalid worker config at \"${configPath}\": Invalid worker config at defaults.worker: expected string array.`,
    );
  });

  it("loads minimal config with defaults only", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        defaults: {
          worker: ["opencode", "run"],
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      defaults: {
        worker: ["opencode", "run"],
        workerArgs: undefined,
      },
      commands: undefined,
      profiles: undefined,
    });
  });

  it("loads full config with defaults, commands, and profiles", () => {
    const configDir = makeTempConfigDir();
    writeConfig(
      configDir,
      JSON.stringify({
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--color", "always"],
        },
        commands: {
          plan: {
            worker: ["opencode", "run"],
            workerArgs: ["--model", "opus-4.6"],
          },
          discuss: {
            workerArgs: ["--model", "gpt-5.3-codex"],
          },
        },
        profiles: {
          complex: {
            workerArgs: ["--model", "opus-4.6"],
          },
          fast: {
            workerArgs: ["--model", "gpt-5.3-codex"],
          },
        },
      }),
    );

    const adapter = createWorkerConfigAdapter();

    expect(adapter.load(configDir)).toEqual({
      defaults: {
        worker: ["opencode", "run"],
        workerArgs: ["--color", "always"],
      },
      commands: {
        plan: {
          worker: ["opencode", "run"],
          workerArgs: ["--model", "opus-4.6"],
        },
        discuss: {
          worker: undefined,
          workerArgs: ["--model", "gpt-5.3-codex"],
        },
      },
      profiles: {
        complex: {
          worker: undefined,
          workerArgs: ["--model", "opus-4.6"],
        },
        fast: {
          worker: undefined,
          workerArgs: ["--model", "gpt-5.3-codex"],
        },
      },
    });
  });
});
