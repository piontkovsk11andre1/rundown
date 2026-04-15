import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWithTask } from "../../src/application/with-task.js";
import { createWorkerConfigAdapter } from "../../src/infrastructure/adapters/worker-config-adapter.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";

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
    const events: ApplicationOutputEvent[] = [];

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      output: {
        emit: (event) => events.push(event),
      },
    });

    const code = withTask({ harness: "opencode" });

    expect(code).toBe(0);
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

    expect(events).toContainEqual({ kind: "success", message: "Applied harness preset: opencode" });
    expect(events).toContainEqual({ kind: "info", message: "Configured keys:" });
    expect(events).toContainEqual({
      kind: "info",
      message: "- workers.default = [\"opencode\",\"run\",\"--file\",\"$file\",\"$bootstrap\"]",
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "- workers.tui = [\"opencode\"]",
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "- commands.discuss = [\"opencode\"]",
    });
    expect(events).toContainEqual({
      kind: "info",
      message: "- workers.fallbacks (preserved)",
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
      output: {
        emit: () => {},
      },
    });

    const code = withTask({ harness: "gemini" });

    expect(code).toBe(0);

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
    const events: ApplicationOutputEvent[] = [];

    const withTask = createWithTask({
      workerConfigPort: createWorkerConfigAdapter(),
      configDir: {
        configDir,
        isExplicit: true,
      },
      output: {
        emit: (event) => events.push(event),
      },
    });

    expect(withTask({ harness: "pi" })).toBe(0);
    const configPath = path.join(configDir, "config.json");
    const before = fs.readFileSync(configPath, "utf8");

    expect(withTask({ harness: "pi" })).toBe(0);
    const after = fs.readFileSync(configPath, "utf8");

    expect(after).toBe(before);
    expect(events).toContainEqual({
      kind: "info",
      message: "No change: harness preset pi is already configured.",
    });
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
      output: {
        emit: () => {},
      },
    });

    expect(() => withTask({ harness: "unknown-harness" })).toThrow(
      "Unknown harness preset: unknown-harness. Supported presets: opencode, claude, gemini, codex, aider, cursor, pi.",
    );
  });
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-with-task-"));
  tempDirs.push(dir);
  return dir;
}
