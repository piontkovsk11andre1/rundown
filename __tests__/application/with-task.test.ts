import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWithTask } from "../../src/application/with-task.js";
import { createWorkerConfigAdapter } from "../../src/infrastructure/adapters/worker-config-adapter.js";
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

    const result = await withTask({ harness: "opencode" });

    expect(result).toEqual({
      exitCode: 0,
      harnessKey: "opencode",
      source: "preset",
      changed: true,
      configPath: path.join(configDir, "config.json"),
      configuredKeys: [
        {
          keyPath: "workers.default",
          status: "set",
          value: ["opencode", "run", "--file", "$file", "$bootstrap"],
        },
        {
          keyPath: "workers.tui",
          status: "set",
          value: ["opencode"],
        },
        {
          keyPath: "commands.discuss",
          status: "set",
          value: ["opencode"],
        },
        {
          keyPath: "workers.fallbacks",
          status: "preserved",
        },
      ],
    });
    const configPath = path.join(configDir, "config.json");
    expect(fs.existsSync(configPath)).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(parsed).toEqual({
      workers: {
        default: ["opencode", "run", "--file", "$file", "$bootstrap"],
        tui: ["opencode"],
      },
      commands: {
        discuss: ["opencode"],
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
        tui: ["legacy"],
        fallbacks: [["fallback", "run"]],
      },
      commands: {
        discuss: ["legacy"],
        run: ["custom", "run"],
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

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: createInteractiveInputStub(),
    });

    const result = await withTask({ harness: "opencode" });

    expect(result.exitCode).toBe(0);
    expect(result.harnessKey).toBe("opencode");
    expect(result.source).toBe("preset");
    expect(result.changed).toBe(true);

    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      workers?: {
        default?: string[];
        tui?: string[];
        fallbacks?: string[][];
      };
      commands?: {
        discuss?: string[];
        run?: string[];
      };
      run?: { commit?: boolean };
      workspace?: unknown;
    };

    expect(parsed.workers?.default).toEqual(["opencode", "run", "--file", "$file", "$bootstrap"]);
    expect(parsed.workers?.tui).toEqual(["opencode"]);
    expect(parsed.workers?.fallbacks).toEqual([["fallback", "run"]]);
    expect(parsed.commands?.discuss).toEqual(["opencode"]);
    expect(parsed.commands?.run).toEqual(["custom", "run"]);
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

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      interactiveInput: createInteractiveInputStub(),
    });

    const first = await withTask({ harness: "opencode" });
    expect(first.exitCode).toBe(0);
    const configPath = path.join(configDir, "config.json");
    const before = fs.readFileSync(configPath, "utf8");

    const second = await withTask({ harness: "opencode" });
    expect(second.exitCode).toBe(0);
    const after = fs.readFileSync(configPath, "utf8");

    expect(after).toBe(before);
    expect(second.source).toBe("preset");
    expect(second.changed).toBe(false);
  });

  it("accepts case-insensitive aliases and writes canonical harness commands", async () => {
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

    const result = await withTask({ harness: "OpenAI-Codex" });
    expect(result.exitCode).toBe(0);
    expect(result.harnessKey).toBe("codex");
    expect(result.source).toBe("preset");

    const configPath = path.join(configDir, "config.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      workers?: {
        default?: string[];
        tui?: string[];
      };
      commands?: {
        discuss?: string[];
      };
    };

    expect(parsed.workers?.default).toEqual(["codex", "run", "--file", "$file", "$bootstrap"]);
    expect(parsed.workers?.tui).toEqual(["codex"]);
    expect(parsed.commands?.discuss).toEqual(["codex"]);
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

    const first = await withTask({ harness: "OpenCode" });
    expect(first.exitCode).toBe(0);
    expect(first.harnessKey).toBe("opencode");
    expect(first.source).toBe("preset");

    const configPath = path.join(configDir, "config.json");
    const before = fs.readFileSync(configPath, "utf8");

    const second = await withTask({ harness: "open-code" });
    expect(second.exitCode).toBe(0);
    expect(second.harnessKey).toBe("opencode");
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
              return ["opencode", "run", "--file", "$file", "$bootstrap"];
            case "workers.tui":
              return ["opencode"];
            case "commands.discuss":
              return ["opencode"];
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

    const result = await withTask({ harness: "OpenCode" });

    expect(result.exitCode).toBe(0);
    expect(result.source).toBe("preset");
    expect(result.harnessKey).toBe("opencode");
    expect(result.changed).toBe(false);
    expect(result.configPath).toBe(configPath);
    expect(result.configuredKeys).toEqual([
      {
        keyPath: "workers.default",
        status: "set",
        value: ["opencode", "run", "--file", "$file", "$bootstrap"],
      },
      {
        keyPath: "workers.tui",
        status: "set",
        value: ["opencode"],
      },
      {
        keyPath: "commands.discuss",
        status: "set",
        value: ["opencode"],
      },
      {
        keyPath: "workers.fallbacks",
        status: "preserved",
      },
    ]);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(workerConfigPort.setValue).not.toHaveBeenCalled();
    expect(workerConfigPort.unsetValue).not.toHaveBeenCalled();
  });

  it("prompts and saves custom worker mappings for unknown harness names", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const interactiveInput = createInteractiveInputStub([
      {
        value: "mytool exec --prompt-file $file --bootstrap $bootstrap",
        usedDefault: false,
        interactive: true,
      },
      {
        value: "true",
        usedDefault: false,
        interactive: true,
      },
      {
        value: "mytool chat",
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

    const result = await withTask({ harness: "MyTool" });

    expect(result.exitCode).toBe(0);
    expect(result.source).toBe("custom");
    expect(result.harnessKey).toBe("mytool");
    expect(result.changed).toBe(true);
    expect(vi.mocked(interactiveInput.prepareForPrompt)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenNthCalledWith(1, {
      kind: "text",
      message: "Unknown harness \"MyTool\". Enter deterministic CLI invocation (workers.default)",
      defaultValue: "mytool run --file $file $bootstrap",
      required: true,
    });
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenNthCalledWith(2, {
      kind: "confirm",
      message: "Configure a separate interactive invocation for workers.tui and commands.discuss?",
      defaultValue: true,
    });
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenNthCalledWith(3, {
      kind: "text",
      message: "Enter interactive invocation (workers.tui / commands.discuss)",
      defaultValue: "mytool",
      required: true,
    });

    const configPath = path.join(configDir, "config.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      workers?: {
        default?: string[];
        tui?: string[];
      };
      commands?: {
        discuss?: string[];
      };
    };

    expect(parsed.workers?.default).toEqual(["mytool", "exec", "--prompt-file", "$file", "--bootstrap", "$bootstrap"]);
    expect(parsed.workers?.tui).toEqual(["mytool", "chat"]);
    expect(parsed.commands?.discuss).toEqual(["mytool", "chat"]);
  });

  it("supports unknown-harness setup without a distinct interactive command", async () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const interactiveInput = createInteractiveInputStub([
      {
        value: "pi run --file $file $bootstrap",
        usedDefault: false,
        interactive: true,
      },
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

    const result = await withTask({ harness: "something-new" });

    expect(result.exitCode).toBe(0);
    expect(result.source).toBe("custom");
    expect(result.harnessKey).toBe("something-new");
    expect(vi.mocked(interactiveInput.prepareForPrompt)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenNthCalledWith(1, {
      kind: "text",
      message: "Unknown harness \"something-new\". Enter deterministic CLI invocation (workers.default)",
      defaultValue: "something-new run --file $file $bootstrap",
      required: true,
    });
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenNthCalledWith(2, {
      kind: "confirm",
      message: "Configure a separate interactive invocation for workers.tui and commands.discuss?",
      defaultValue: true,
    });
    const configuredTui = result.configuredKeys.find((entry) => entry.keyPath === "workers.tui");
    const configuredDiscuss = result.configuredKeys.find((entry) => entry.keyPath === "commands.discuss");
    expect(configuredTui?.status).toBe("removed");
    expect(configuredDiscuss?.status).toBe("removed");

    const configPath = path.join(configDir, "config.json");
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
      workers?: {
        default?: string[];
        tui?: string[];
      };
      commands?: {
        discuss?: string[];
      };
    };

    expect(parsed.workers?.default).toEqual(["pi", "run", "--file", "$file", "$bootstrap"]);
    expect(parsed.workers?.tui).toBeUndefined();
    expect(parsed.commands?.discuss).toBeUndefined();
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
