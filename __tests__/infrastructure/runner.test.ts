import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("cross-spawn", () => ({
  default: spawnMock,
}));

describe("runWorker", () => {
  afterEach(() => {
    spawnMock.mockReset();
    cleanupWorkspaceRuns();
  });

  it("uses an attached prompt file plus a short bootstrap message for opencode run in file transport", async () => {
    let capturedPromptFile = "";
    let capturedPromptFileContent = "";

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      const fileFlagIndex = args.indexOf("--file");
      capturedPromptFile = args[fileFlagIndex + 1];
      capturedPromptFileContent = fs.readFileSync(capturedPromptFile, "utf-8");

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");
    const prompt = "You are working on a project.\n\n## Task\n\nDo the thing.";

    const result = await runWorker({
      command: ["opencode", "run"],
      prompt,
      mode: "wait",
      transport: "file",
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args[0]).toBe("run");
    expect(args[1]).toBe("Read the attached Markdown file first. It contains the full task instructions and context for this run.");
    expect(args).toContain("--file");
    expect(capturedPromptFile).toMatch(/\.md-todo[\\/]runs[\\/]run-.*[\\/]01-worker[\\/]prompt\.md$/);
    expect(capturedPromptFileContent).toBe(prompt);
    expect(args.at(-2)).toBe("--file");
    expect(args.at(-1)).toBe(capturedPromptFile);
    expect(args).not.toContain(prompt);
    expect(fs.existsSync(capturedPromptFile)).toBe(false);
  });

  it("keeps arg transport inline for opencode run", async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");
    const prompt = "inline prompt";

    await runWorker({
      command: ["opencode", "run"],
      prompt,
      mode: "wait",
      transport: "arg",
      cwd: process.cwd(),
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args).toEqual(["run", prompt]);
  });

  it("uses a single --prompt=... argument for opencode tui in file transport", async () => {
    let capturedPromptFile = "";
    let capturedPromptFileContent = "";

    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      capturedPromptFile = findFirstPromptFile();
      capturedPromptFileContent = fs.readFileSync(capturedPromptFile, "utf-8");

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    await runWorker({
      command: ["opencode"],
      prompt: "full prompt content",
      mode: "tui",
      transport: "file",
      cwd: process.cwd(),
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    if (process.platform === "win32") {
      expect(cmd).toBe("cmd");
      expect(args.slice(0, 4)).toEqual(["/c", "start", "/wait", '""']);
      expect(args[4]).toBe("opencode");
      expect(args[5]).toMatch(/^--prompt=The full rendered md-todo task prompt is staged in \.md-todo\/runs\/run-.*\/01-worker\/prompt\.md\. Open and read that file completely before taking any action, then continue the work in this session\.$/);
    } else {
      expect(cmd).toBe("opencode");
      expect(args).toHaveLength(1);
      expect(args[0]).toMatch(/^--prompt=The full rendered md-todo task prompt is staged in \.md-todo\/runs\/run-.*\/01-worker\/prompt\.md\. Open and read that file completely before taking any action, then continue the work in this session\.$/);
    }
    expect(capturedPromptFile).toMatch(/\.md-todo[\\/]runs[\\/]run-.*[\\/]01-worker[\\/]prompt\.md$/);
    expect(capturedPromptFileContent).toBe("full prompt content");
    expect(fs.existsSync(capturedPromptFile)).toBe(false);
  });

  it("uses a single --prompt=... argument for opencode tui in arg transport", async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");
    const prompt = "Open the task and do the work.";

    await runWorker({
      command: ["opencode"],
      prompt,
      mode: "tui",
      transport: "arg",
      cwd: process.cwd(),
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    if (process.platform === "win32") {
      expect(cmd).toBe("cmd");
      expect(args).toEqual(["/c", "start", "/wait", '""', "opencode", `--prompt=${prompt}`]);
    } else {
      expect(cmd).toBe("opencode");
      expect(args).toEqual([`--prompt=${prompt}`]);
    }
  });

  it("keeps runtime artifacts when keepArtifacts is enabled", async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("hello from worker\n"));
        child.stderr.emit("data", Buffer.from("warn from worker\n"));
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    await runWorker({
      command: ["opencode", "run"],
      prompt: "saved prompt",
      mode: "wait",
      transport: "file",
      cwd: process.cwd(),
      keepArtifacts: true,
    });

    const runsDir = path.join(process.cwd(), ".md-todo", "runs");
    const [runDirName] = fs.readdirSync(runsDir);
    const phaseDir = path.join(runsDir, runDirName!, "01-worker");

    expect(fs.readFileSync(path.join(phaseDir, "prompt.md"), "utf-8")).toBe("saved prompt");
    expect(fs.readFileSync(path.join(phaseDir, "stdout.log"), "utf-8")).toBe("hello from worker\n");
    expect(fs.readFileSync(path.join(phaseDir, "stderr.log"), "utf-8")).toBe("warn from worker\n");
    expect(fs.existsSync(path.join(runsDir, runDirName!, "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(phaseDir, "metadata.json"))).toBe(true);
  });

  it("preserves detached runtime artifacts even without keepArtifacts", async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        unref: () => void;
      };

      child.unref = vi.fn();
      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    const result = await runWorker({
      command: ["opencode", "run"],
      prompt: "detached prompt",
      mode: "detached",
      transport: "file",
      cwd: process.cwd(),
    });

    expect(result.exitCode).toBeNull();

    const promptFile = findFirstPromptFile();
    expect(promptFile).toMatch(/\.md-todo[\\/]runs[\\/]run-.*[\\/]01-worker[\\/]prompt\.md$/);
    expect(fs.readFileSync(promptFile, "utf-8")).toBe("detached prompt");
  });
});

function cleanupWorkspaceRuns(): void {
  const runsDir = path.join(process.cwd(), ".md-todo", "runs");
  if (!fs.existsSync(runsDir)) {
    return;
  }

  fs.rmSync(runsDir, { recursive: true, force: true });
}

function findFirstPromptFile(): string {
  const runsDir = path.join(process.cwd(), ".md-todo", "runs");
  for (const runDir of fs.readdirSync(runsDir)) {
    const phaseDir = path.join(runsDir, runDir, "01-worker", "prompt.md");
    if (fs.existsSync(phaseDir)) {
      return phaseDir;
    }
  }

  throw new Error("No prompt file found under .md-todo/runs.");
}
