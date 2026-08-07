import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWithTask } from "../../src/application/with-task.js";
import { createWorkerConfigAdapter } from "../../src/infrastructure/adapters/worker-config-adapter.js";
import { resolveConfigDirForInvocation } from "../../src/presentation/cli-app-init.js";
import type { InteractiveInputPort } from "../../src/domain/ports/interactive-input-port.js";
import type { WorkerConfigPort } from "../../src/domain/ports/worker-config-port.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) {
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("with-task", () => {
  it("creates .rundown/config.json when missing and writes preset keys", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: createInteractiveInputStub(),
    });

    const result = await withTask({ provider: "opencode" });

    expect(result).toEqual({
      exitCode: 0,
      providerKey: "opencode",
      source: "preset",
      cancelled: false,
      changed: true,
      configPath: path.join(configDir, "config.json"),
      existingLocalWorkerKeys: [],
      configuredKeys: [
        {
          keyPath: "workers.default",
          status: "set",
          value: ["opencode", "run", "$bootstrap"],
        },
        {
          keyPath: "workers.interactive",
          status: "set",
          value: ["opencode", "--prompt", "$bootstrap"],
        },
        {
          keyPath: "fallbacks.default",
          status: "preserved",
        },
      ],
    });
    const configPath = path.join(configDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({
      workers: {
        default: ["opencode", "run", "$bootstrap"],
        interactive: ["opencode", "--prompt", "$bootstrap"],
      },
    });
  });

  it("merges opencode preset updates without clobbering unrelated config keys", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      workers: {
        default: ["legacy", "run"],
        interactive: ["legacy"],
      },
      fallbacks: {
        default: [["fallback", "run"]],
      },
      run: {
        commit: true,
      },
      workspace: {
        directories: {
          design: "design",
          specs: "specs",
          migrations: "migrations",
        },
      },
    }, null, 2) + "\n");

    const interactiveInput = createInteractiveInputStub([
      {
        value: "true",
        usedDefault: false,
        interactive: true,
      },
    ]);

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput,
    });

    const result = await withTask({ provider: "opencode" });

    expect(result.exitCode).toBe(0);
    expect(result.providerKey).toBe("opencode");
    expect(result.source).toBe("preset");
    expect(result.changed).toBe(true);
    expect(result.existingLocalWorkerKeys).toEqual([
      "workers.default",
      "workers.interactive",
      "fallbacks.default",
    ]);

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      workers?: {
        default?: string[];
        interactive?: string[];
      };
      fallbacks?: {
        default?: string[][];
      };
      run?: { commit?: boolean };
      workspace?: unknown;
    };

    expect(parsed.workers?.default).toEqual(["opencode", "run", "$bootstrap"]);
    expect(parsed.workers?.interactive).toEqual(["opencode", "--prompt", "$bootstrap"]);
    expect(parsed.fallbacks?.default).toEqual([["fallback", "run"]]);
    expect(parsed.run?.commit).toBe(true);
    expect(parsed.workspace).toEqual({
      directories: {
        design: "design",
        specs: "specs",
        migrations: "migrations",
      },
    });
  });

  it("re-applying the opencode preset is idempotent", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    const interactiveInput = createInteractiveInputStub();

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput,
    });

    const first = await withTask({ provider: "opencode" });
    expect(first.exitCode).toBe(0);
    const configPath = path.join(configDir, "config.json");
    const before = fs.readFileSync(configPath, "utf8");

    const second = await withTask({ provider: "opencode" });
    expect(second.exitCode).toBe(0);
    const after = fs.readFileSync(configPath, "utf8");

    expect(after).toBe(before);
    expect(second.source).toBe("preset");
    expect(second.changed).toBe(false);
    expect(second.cancelled).toBe(false);
    expect(second.existingLocalWorkerKeys).toEqual(["workers.default", "workers.interactive"]);
    expect(vi.mocked(interactiveInput.prompt)).not.toHaveBeenCalled();
  });

  it("prompts before overwriting existing local worker keys for opencode", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      workers: {
        default: ["legacy", "run"],
        interactive: ["legacy"],
      },
    }, null, 2) + "\n");

    const interactiveInput = createInteractiveInputStub([
      {
        value: "true",
        usedDefault: false,
        interactive: true,
      },
    ]);

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput,
    });

    const result = await withTask({ provider: "opencode" });

    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.existingLocalWorkerKeys).toEqual(["workers.default", "workers.interactive"]);
    expect(vi.mocked(interactiveInput.prepareForPrompt)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenNthCalledWith(1, {
      kind: "confirm",
      message: "Local worker config already exists (workers.default, workers.interactive). Running \"rundown with opencode\" will replace or update these worker settings. Continue?",
      defaultValue: false,
    });

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      workers?: {
        default?: string[];
        interactive?: string[];
      };
    };
    expect(parsed.workers?.default).toEqual(["opencode", "run", "$bootstrap"]);
    expect(parsed.workers?.interactive).toEqual(["opencode", "--prompt", "$bootstrap"]);
  });

  it("cancels opencode overwrite when user declines confirmation", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      workers: {
        default: ["legacy", "run"],
        interactive: ["legacy"],
      },
    }, null, 2) + "\n");
    const before = fs.readFileSync(configPath, "utf8");

    const interactiveInput = createInteractiveInputStub([
      {
        value: "false",
        usedDefault: false,
        interactive: true,
      },
    ]);

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput,
    });

    const result = await withTask({ provider: "opencode" });
    const after = fs.readFileSync(configPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.existingLocalWorkerKeys).toEqual(["workers.default", "workers.interactive"]);
    expect(result.configuredKeys).toEqual([]);
    expect(after).toBe(before);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenCalledTimes(1);
  });

  it("keeps config unchanged when overwrite confirmation is interrupted", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      workers: {
        default: ["legacy", "run"],
        interactive: ["legacy"],
      },
    }, null, 2) + "\n");
    const before = fs.readFileSync(configPath, "utf8");

    const interactiveInput: InteractiveInputPort = {
      isTTY: vi.fn(() => true),
      prepareForPrompt: vi.fn(),
      prompt: vi.fn(async () => {
        const interrupted = new Error("Input interrupted by user (Ctrl+C).");
        interrupted.name = "InteractiveInputInterruptedError";
        throw interrupted;
      }),
    };

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput,
    });

    const result = await withTask({ provider: "opencode" });
    const after = fs.readFileSync(configPath, "utf8");

    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.existingLocalWorkerKeys).toEqual(["workers.default", "workers.interactive"]);
    expect(result.configuredKeys).toEqual([]);
    expect(after).toBe(before);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenCalledTimes(1);
  });

  it("fails in non-interactive mode when overwrite confirmation is required", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      workers: {
        default: ["legacy", "run"],
      },
    }, null, 2) + "\n");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: {
        isTTY: () => false,
        prompt: vi.fn(async () => {
          throw new Error("prompt should not run in non-interactive mode");
        }),
      },
    });

    await expect(withTask({ provider: "opencode" })).rejects.toThrow(
      "Cannot apply \"with opencode\" non-interactively because local worker config already exists (workers.default). Re-run in an interactive terminal to confirm replacing/updating worker settings.",
    );
  });

  it("skips overwrite confirmation when only global worker keys exist", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    const globalRoot = makeTempWorkspace();
    const globalConfigPath = path.join(globalRoot, "global-config.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({
      workers: {
        default: ["legacy", "run"],
        interactive: ["legacy"],
      },
    }, null, 2) + "\n");

    const interactiveInput = createInteractiveInputStub();
    const workerConfigPort = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({
        discoveredPath: globalConfigPath,
        canonicalPath: globalConfigPath,
      }),
    });
    const withTask = createWithTask({
      workerConfigPort,
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput,
    });

    const result = await withTask({ provider: "opencode" });

    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.existingLocalWorkerKeys).toEqual([]);
    expect(vi.mocked(interactiveInput.prepareForPrompt)).not.toHaveBeenCalled();
    expect(vi.mocked(interactiveInput.prompt)).not.toHaveBeenCalled();

    const parsed = JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")) as {
      workers?: {
        default?: string[];
        interactive?: string[];
      };
    };

    expect(parsed.workers?.default).toEqual(["opencode", "run", "$bootstrap"]);
    expect(parsed.workers?.interactive).toEqual(["opencode", "--prompt", "$bootstrap"]);
  });

  it("accepts case-insensitive aliases and writes canonical provider commands", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: createInteractiveInputStub(),
    });

    const result = await withTask({ provider: "OpenAI-Codex" });
    expect(result.exitCode).toBe(0);
    expect(result.providerKey).toBe("codex");
    expect(result.source).toBe("preset");

    const configPath = path.join(configDir, "config.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      workers?: {
        default?: string[];
        interactive?: string[];
      };
    };

    expect(parsed.workers?.default).toEqual(["codex", "run", "--file", "$file", "$bootstrap"]);
    expect(parsed.workers?.interactive).toEqual(["codex"]);
  });

  it("keeps persisted config stable across equivalent alias inputs", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: createInteractiveInputStub(),
    });

    const first = await withTask({ provider: "OpenCode" });
    expect(first.exitCode).toBe(0);
    expect(first.providerKey).toBe("opencode");
    expect(first.source).toBe("preset");

    const configPath = path.join(configDir, "config.json");
    const before = fs.readFileSync(configPath, "utf8");

    const second = await withTask({ provider: "open-code" });
    expect(second.exitCode).toBe(0);
    expect(second.providerKey).toBe("opencode");
    expect(second.source).toBe("preset");

    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toBe(before);
    expect(second.changed).toBe(false);
  });

  it("reports no-op without writing when effective values already match preset", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    const configPath = path.join(configDir, "config.json");

    const workerConfigPort: WorkerConfigPort = {
      load: vi.fn(() => undefined),
      getConfigPaths: vi.fn(() => ({
        localConfigPath: configPath,
        globalConfigPath: "/global/config.json",
        globalCanonicalPath: "/global/config.json",
      })),
      readValue: vi.fn((_, scope, keyPath) => {
        if (scope === "local") {
          return undefined;
        }

        if (scope === "effective") {
          switch (keyPath) {
            case "workers.default":
              return ["opencode", "run", "$bootstrap"];
            case "workers.interactive":
              return ["opencode", "--prompt", "$bootstrap"];
            default:
              return undefined;
          }
        }

        return undefined;
      }),
      setValue: vi.fn(() => {
        throw new Error("setValue should not be called for no-op application");
      }),
      unsetValue: vi.fn(() => {
        throw new Error("unsetValue should not be called for no-op application");
      }),
    };

    const withTask = createWithTask({
      workerConfigPort,
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: createInteractiveInputStub(),
    });

    const result = await withTask({ provider: "OpenCode" });

    expect(result.exitCode).toBe(0);
    expect(result.source).toBe("preset");
    expect(result.providerKey).toBe("opencode");
    expect(result.changed).toBe(false);
    expect(result.configPath).toBe(configPath);
    expect(result.existingLocalWorkerKeys).toEqual([]);
    expect(result.configuredKeys).toEqual([
      {
        keyPath: "workers.default",
        status: "set",
        value: ["opencode", "run", "$bootstrap"],
      },
      {
        keyPath: "workers.interactive",
        status: "set",
        value: ["opencode", "--prompt", "$bootstrap"],
      },
      {
        keyPath: "fallbacks.default",
        status: "preserved",
      },
    ]);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(workerConfigPort.setValue).not.toHaveBeenCalled();
    expect(workerConfigPort.unsetValue).not.toHaveBeenCalled();
  });

  it("detects local worker keys before applying opencode preset", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      workers: {
        interactive: ["legacy", "--prompt", "$bootstrap"],
      },
    }, null, 2) + "\n");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: createInteractiveInputStub(),
    });

    const result = await withTask({ provider: "opencode" });

    expect(result.exitCode).toBe(0);
    expect(result.existingLocalWorkerKeys).toEqual(["workers.interactive"]);
  });

  it("rejects unknown providers without prompting or writing config", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    const interactiveInput = createInteractiveInputStub();

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput,
    });

    await expect(withTask({ provider: "OpenCode-Pro" })).rejects.toThrow(
      "Unknown provider preset: opencode-pro.",
    );
    expect(vi.mocked(interactiveInput.prepareForPrompt)).not.toHaveBeenCalled();
    expect(vi.mocked(interactiveInput.prompt)).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(configDir, "config.json"))).toBe(false);
  });

  it("uses explicit --config-dir over discovered .rundown paths in with flow", async () => {
    const workspaceDir = makeTempWorkspace();
    const discoveredConfigDir = path.join(workspaceDir, ".rundown");
    const explicitConfigDir = path.join(workspaceDir, ".rundown-explicit");
    const invocationDir = path.join(workspaceDir, "nested", "project");
    fs.mkdirSync(discoveredConfigDir, { recursive: true });
    fs.writeFileSync(path.join(discoveredConfigDir, "config.json"), JSON.stringify({
      run: {
        commit: true,
      },
    }, null, 2) + "\n");
    fs.mkdirSync(explicitConfigDir, { recursive: true });
    fs.mkdirSync(invocationDir, { recursive: true });

    const resolvedConfigDir = resolveConfigDirForInvocation(
      ["with", "opencode", "--config-dir", explicitConfigDir],
      invocationDir,
    );
    expect(resolvedConfigDir).toEqual({
      configDir: explicitConfigDir,
      isExplicit: true,
    });

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: resolvedConfigDir,
      interactiveInput: createInteractiveInputStub(),
    });

    const result = await withTask({ provider: "opencode" });

    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.configPath).toBe(path.join(explicitConfigDir, "config.json"));

    const explicitConfigPath = path.join(explicitConfigDir, "config.json");
    expect(fs.existsSync(explicitConfigPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(explicitConfigPath, "utf8"))).toEqual({
      workers: {
        default: ["opencode", "run", "$bootstrap"],
        interactive: ["opencode", "--prompt", "$bootstrap"],
      },
    });

    expect(JSON.parse(fs.readFileSync(path.join(discoveredConfigDir, "config.json"), "utf8"))).toEqual({
      run: {
        commit: true,
      },
    });
  });

  it("discovers .rundown upward when --config-dir is not provided", async () => {
    const workspaceDir = makeTempWorkspace();
    const discoveredConfigDir = path.join(workspaceDir, ".rundown");
    const invocationDir = path.join(workspaceDir, "apps", "feature", "src");
    fs.mkdirSync(discoveredConfigDir, { recursive: true });
    fs.mkdirSync(invocationDir, { recursive: true });
    fs.writeFileSync(path.join(discoveredConfigDir, "config.json"), JSON.stringify({
      run: {
        commit: true,
      },
      fallbacks: {
        default: [["fallback", "run"]],
      },
    }, null, 2) + "\n");

    const resolvedConfigDir = resolveConfigDirForInvocation(["with", "opencode"], invocationDir);
    expect(resolvedConfigDir).toEqual({
      configDir: discoveredConfigDir,
      isExplicit: false,
    });

    const interactiveInput = createInteractiveInputStub([
      {
        value: "true",
        usedDefault: false,
        interactive: true,
      },
    ]);

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: resolvedConfigDir,
      interactiveInput,
    });

    const result = await withTask({ provider: "opencode" });

    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(result.configPath).toBe(path.join(discoveredConfigDir, "config.json"));

    const parsed = JSON.parse(fs.readFileSync(path.join(discoveredConfigDir, "config.json"), "utf8")) as {
      run?: { commit?: boolean };
      workers?: {
        default?: string[];
        interactive?: string[];
      };
      fallbacks?: {
        default?: string[][];
      };
    };

    expect(parsed.workers?.default).toEqual(["opencode", "run", "$bootstrap"]);
    expect(parsed.workers?.interactive).toEqual(["opencode", "--prompt", "$bootstrap"]);
    expect(parsed.fallbacks?.default).toEqual([["fallback", "run"]]);
    expect(parsed.run?.commit).toBe(true);
  });

  it("keeps global config untouched while applying opencode using effective built-in/global/local resolution", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");
    const globalRoot = makeTempWorkspace();
    const globalConfigPath = path.join(globalRoot, "global-config.json");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(globalConfigPath, JSON.stringify({
      workers: {
        default: ["codex", "run", "--file", "$file", "$bootstrap"],
        interactive: ["codex"],
      },
    }, null, 2) + "\n");
    const globalBefore = fs.readFileSync(globalConfigPath, "utf8");

    const workerConfigPort = createWorkerConfigAdapter({
      resolveGlobalConfigPath: () => ({
        discoveredPath: globalConfigPath,
        canonicalPath: globalConfigPath,
      }),
    });
    const readValue = workerConfigPort.readValue;
    expect(readValue).toBeTypeOf("function");
    if (!readValue) {
      throw new Error("Expected workerConfigPort.readValue to be available");
    }

    expect(readValue(configDir, "effective", "workers.default")).toEqual([
      "codex",
      "run",
      "--file",
      "$file",
      "$bootstrap",
    ]);
    expect(readValue(configDir, "effective", "traceStatistics.enabled")).toBe(false);

    const withTask = createWithTask({
      workerConfigPort,
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: createInteractiveInputStub(),
    });

    const result = await withTask({ provider: "opencode" });

    expect(result.exitCode).toBe(0);
    expect(result.changed).toBe(true);
    expect(readValue(configDir, "global", "workers.default")).toEqual([
      "codex",
      "run",
      "--file",
      "$file",
      "$bootstrap",
    ]);
    expect(readValue(configDir, "local", "workers.default")).toEqual([
      "opencode",
      "run",
      "$bootstrap",
    ]);
    expect(readValue(configDir, "effective", "workers.default")).toEqual([
      "opencode",
      "run",
      "$bootstrap",
    ]);

    const globalAfter = fs.readFileSync(globalConfigPath, "utf8");
    expect(globalAfter).toBe(globalBefore);
  });
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-with-task-"));
  tempDirs.push(dir);
  return dir;
}

function createInteractiveInputStub(
  promptResponses: Array<{ value: string; usedDefault: boolean; interactive: boolean }> = [],
): InteractiveInputPort {
  const queue = [...promptResponses];

  return {
    isTTY: vi.fn(() => true),
    prepareForPrompt: vi.fn(),
    prompt: vi.fn(async (request) => {
      const queued = queue.shift();
      if (queued) {
        return queued;
      }

      if (request.kind === "confirm") {
        const defaultValue = request.defaultValue ?? false;
        return {
          value: defaultValue ? "true" : "false",
          usedDefault: true,
          interactive: false,
        };
      }

      return {
        value: request.defaultValue ?? "",
        usedDefault: true,
        interactive: false,
      };
    }),
  };
}
