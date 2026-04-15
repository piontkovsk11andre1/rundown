import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWithTask } from "../../src/application/with-task.js";
import { createWorkerConfigAdapter } from "../../src/infrastructure/adapters/worker-config-adapter.js";

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
  it("creates .rundown/config.json when missing and writes preset keys", () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
    });

    const result = withTask({ harness: "opencode" });

    expect(result).toEqual({
      exitCode: 0,
      harnessKey: "opencode",
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

  it("merges preset updates without clobbering unrelated config keys", () => {
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
    });

    const result = withTask({ harness: "gemini" });

    expect(result.exitCode).toBe(0);
    expect(result.harnessKey).toBe("gemini");
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

    expect(parsed.workers?.default).toEqual(["gemini", "run", "--file", "$file", "$bootstrap"]);
    expect(parsed.workers?.tui).toEqual(["gemini"]);
    expect(parsed.workers?.fallbacks).toEqual([["fallback", "run"]]);
    expect(parsed.commands?.discuss).toEqual(["gemini"]);
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

  it("re-applying the same preset is idempotent", () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
    });

    const first = withTask({ harness: "pi" });
    expect(first.exitCode).toBe(0);
    const configPath = path.join(configDir, "config.json");
    const before = fs.readFileSync(configPath, "utf8");

    const second = withTask({ harness: "pi" });
    expect(second.exitCode).toBe(0);
    const after = fs.readFileSync(configPath, "utf8");

    expect(after).toBe(before);
    expect(second.changed).toBe(false);
  });

  it("accepts case-insensitive aliases and writes canonical harness commands", () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
    });

    const result = withTask({ harness: "OpenAI-Codex" });
    expect(result.exitCode).toBe(0);
    expect(result.harnessKey).toBe("codex");

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

  it("keeps persisted config stable across equivalent alias inputs", () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
    });

    const first = withTask({ harness: "OpenCode" });
    expect(first.exitCode).toBe(0);
    expect(first.harnessKey).toBe("opencode");

    const configPath = path.join(configDir, "config.json");
    const before = fs.readFileSync(configPath, "utf8");

    const second = withTask({ harness: "open-code" });
    expect(second.exitCode).toBe(0);
    expect(second.harnessKey).toBe("opencode");

    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toBe(before);
    expect(second.changed).toBe(false);
  });

  it("fails with actionable supported list when harness is unknown", () => {
    const workspaceDir = makeTempWorkspace();
    const configDir = path.join(workspaceDir, ".rundown");

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
    });

    expect(() => withTask({ harness: "unknown-harness" })).toThrow(
      "Unknown harness preset: unknown-harness. Supported presets: opencode, claude, gemini, codex, aider, cursor, pi. Run `rundown with <harness>` using one of the supported names.",
    );
  });
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-with-task-"));
  tempDirs.push(dir);
  return dir;
}
