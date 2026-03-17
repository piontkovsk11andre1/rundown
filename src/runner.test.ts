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
    cleanupWorkspaceRuntime();
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

    const { runWorker } = await import("./runner.js");
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
    expect(capturedPromptFile).toMatch(/prompt-.*\.md$/);
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

    const { runWorker } = await import("./runner.js");
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

      const runtimeDir = path.join(process.cwd(), ".md-todo", "runtime");
      const [promptFile] = fs.readdirSync(runtimeDir)
        .filter((entry) => entry.endsWith(".md"))
        .map((entry) => path.join(runtimeDir, entry));

      capturedPromptFile = promptFile!;
      capturedPromptFileContent = fs.readFileSync(capturedPromptFile, "utf-8");

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("./runner.js");

    await runWorker({
      command: ["opencode"],
      prompt: "full prompt content",
      mode: "tui",
      transport: "file",
      cwd: process.cwd(),
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/^--prompt=The full rendered md-todo task prompt is staged in \.md-todo\/runtime\/prompt-.*\.md\. Open and read that file completely before taking any action, then continue the work in this session\.$/);
    expect(capturedPromptFile).toMatch(/\.md-todo[\\/]runtime[\\/]prompt-.*\.md$/);
    expect(capturedPromptFileContent).toBe("full prompt content");
    expect(fs.existsSync(capturedPromptFile)).toBe(true);
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

    const { runWorker } = await import("./runner.js");
    const prompt = "Open the task and do the work.";

    await runWorker({
      command: ["opencode"],
      prompt,
      mode: "tui",
      transport: "arg",
      cwd: process.cwd(),
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args).toEqual([`--prompt=${prompt}`]);
  });
});

function cleanupWorkspaceRuntime(): void {
  const runtimeDir = path.join(process.cwd(), ".md-todo", "runtime");
  if (!fs.existsSync(runtimeDir)) {
    return;
  }

  for (const entry of fs.readdirSync(runtimeDir)) {
    fs.unlinkSync(path.join(runtimeDir, entry));
  }

  fs.rmSync(runtimeDir, { recursive: true, force: true });
}