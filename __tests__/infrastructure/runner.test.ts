import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();

vi.mock("cross-spawn", () => ({
  default: spawnMock,
}));

describe("runWorker", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-runner-test-"));
  });

  afterEach(() => {
    spawnMock.mockReset();
    fs.rmSync(workspace, { recursive: true, force: true });
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
      cwd: workspace,
    });

    expect(result.exitCode).toBe(0);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args[0]).toBe("run");
    expect(args[1]).toBe("Read the attached Markdown file first. It contains the full task instructions and context for this run.");
    expect(args).toContain("--file");
    expect(capturedPromptFile).toMatch(/\.rundown[\\/]runs[\\/]run-.*[\\/]01-worker[\\/]prompt\.md$/);
    expect(capturedPromptFileContent).toBe(prompt);
    expect(args.at(-2)).toBe("--file");
    expect(args.at(-1)).toBe(capturedPromptFile);
    expect(args).not.toContain(prompt);
    expect(fs.existsSync(capturedPromptFile)).toBe(false);
  });

  it("keeps pre-merged worker args before the prompt file for non-opencode file transport", async () => {
    let capturedPromptFile = "";

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      capturedPromptFile = args.at(-1) ?? "";

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    await runWorker({
      command: ["node", "worker.js", "--model", "gpt-5.3-codex"],
      prompt: "prompt body",
      mode: "wait",
      transport: "file",
      cwd: workspace,
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("node");
    expect(args).toEqual(["worker.js", "--model", "gpt-5.3-codex", capturedPromptFile]);
    expect(capturedPromptFile).toMatch(/\.rundown[\\/]runs[\\/]run-.*[\\/]01-worker[\\/]prompt\.md$/);
  });

  it("keeps pre-merged worker args before --file prompt path for opencode run", async () => {
    let capturedPromptFile = "";

    spawnMock.mockImplementation((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      const fileFlagIndex = args.indexOf("--file");
      capturedPromptFile = args[fileFlagIndex + 1] ?? "";

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    await runWorker({
      command: ["opencode", "run", "--model", "opus-4.6"],
      prompt: "prompt body",
      mode: "wait",
      transport: "file",
      cwd: workspace,
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args).toEqual([
      "run",
      "--model",
      "opus-4.6",
      "Read the attached Markdown file first. It contains the full task instructions and context for this run.",
      "--file",
      capturedPromptFile,
    ]);
    expect(capturedPromptFile).toMatch(/\.rundown[\\/]runs[\\/]run-.*[\\/]01-worker[\\/]prompt\.md$/);
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
      cwd: workspace,
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args).toEqual(["run", prompt]);
  });

  it("auto-appends --thinking for opencode when trace is enabled", async () => {
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

    await runWorker({
      command: ["opencode", "run"],
      prompt: "trace prompt",
      mode: "wait",
      transport: "arg",
      trace: true,
      cwd: workspace,
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args).toEqual(["run", "--thinking", "trace prompt"]);
  });

  it("does not duplicate --thinking when already provided for opencode", async () => {
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

    await runWorker({
      command: ["opencode", "run", "--thinking"],
      prompt: "trace prompt",
      mode: "wait",
      transport: "arg",
      trace: true,
      cwd: workspace,
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("opencode");
    expect(args).toEqual(["run", "--thinking", "trace prompt"]);
  });

  it("appends the prompt directly for non-opencode commands in arg transport", async () => {
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

    await runWorker({
      command: ["node", "script.js"],
      prompt: "inline prompt body",
      mode: "wait",
      transport: "arg",
      cwd: workspace,
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("node");
    expect(args).toEqual(["script.js", "inline prompt body"]);
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

      capturedPromptFile = findFirstPromptFile(workspace);
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
      cwd: workspace,
    });

    const [cmd, args] = spawnMock.mock.calls[0] as [string, string[]];
    if (process.platform === "win32") {
      expect(cmd).toBe("cmd");
      expect(args.slice(0, 4)).toEqual(["/c", "start", "/wait", '""']);
      expect(args[4]).toBe("opencode");
      expect(args[5]).toMatch(/^--prompt=The full rendered rundown task prompt is staged in \.rundown\/runs\/run-.*\/01-worker\/prompt\.md\. Open and read that file completely before taking any action, then continue the work in this session\.$/);
    } else {
      expect(cmd).toBe("opencode");
      expect(args).toHaveLength(1);
      expect(args[0]).toMatch(/^--prompt=The full rendered rundown task prompt is staged in \.rundown\/runs\/run-.*\/01-worker\/prompt\.md\. Open and read that file completely before taking any action, then continue the work in this session\.$/);
    }
    expect(capturedPromptFile).toMatch(/\.rundown[\\/]runs[\\/]run-.*[\\/]01-worker[\\/]prompt\.md$/);
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
      cwd: workspace,
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

  it("uses inherited stdio for non-Windows tui mode", async () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");

    spawnMock.mockImplementation((_cmd: string, _args: string[], _options: Record<string, unknown>) => {
      const child = new EventEmitter() as EventEmitter;

      queueMicrotask(() => {
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    const result = await runWorker({
      command: ["opencode"],
      prompt: "interactive prompt",
      mode: "tui",
      transport: "arg",
      cwd: workspace,
    });

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(spawnMock).toHaveBeenCalledWith(
      "opencode",
      ["--prompt=interactive prompt"],
      { stdio: "inherit", cwd: workspace, shell: false },
    );
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
      cwd: workspace,
      keepArtifacts: true,
    });

    const runsDir = path.join(workspace, ".rundown", "runs");
    const [runDirName] = fs.readdirSync(runsDir);
    const phaseDir = path.join(runsDir, runDirName!, "01-worker");

    expect(fs.readFileSync(path.join(phaseDir, "prompt.md"), "utf-8")).toBe("saved prompt");
    expect(fs.readFileSync(path.join(phaseDir, "stdout.log"), "utf-8")).toBe("hello from worker\n");
    expect(fs.readFileSync(path.join(phaseDir, "stderr.log"), "utf-8")).toBe("warn from worker\n");
    expect(fs.existsSync(path.join(runsDir, runDirName!, "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(phaseDir, "metadata.json"))).toBe(true);
  });

  it("writes artifacts under explicit configDir while keeping process cwd", async () => {
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
    const configDir = path.join(workspace, "config-root", ".rundown");
    fs.mkdirSync(configDir, { recursive: true });

    await runWorker({
      command: ["node", "worker.js"],
      prompt: "custom config prompt",
      mode: "wait",
      transport: "arg",
      cwd: workspace,
      configDir,
      keepArtifacts: true,
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "node",
      ["worker.js", "custom config prompt"],
      { stdio: ["inherit", "pipe", "pipe"], cwd: workspace, shell: false },
    );

    const runsDir = path.join(configDir, "runs");
    expect(fs.existsSync(runsDir)).toBe(true);
    expect(fs.readdirSync(runsDir).length).toBe(1);
    expect(fs.existsSync(path.join(workspace, ".rundown", "runs"))).toBe(false);
  });

  it("captures and mirrors tui output when captureOutput is enabled", async () => {
    vi.spyOn(os, "platform").mockReturnValue("linux");
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    spawnMock.mockImplementation((_cmd: string, _args: string[], _options: Record<string, unknown>) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.stdout.emit("data", Buffer.from("hello tui\n"));
        child.stderr.emit("data", Buffer.from("warn tui\n"));
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    const result = await runWorker({
      command: ["opencode"],
      prompt: "interactive prompt",
      mode: "tui",
      transport: "arg",
      captureOutput: true,
      keepArtifacts: true,
      cwd: workspace,
    });

    expect(result).toEqual({
      exitCode: 0,
      stdout: "hello tui\n",
      stderr: "warn tui\n",
    });
    expect(spawnMock).toHaveBeenCalledWith(
      "opencode",
      ["--prompt=interactive prompt"],
      { stdio: ["inherit", "pipe", "pipe"], cwd: workspace, shell: false },
    );
    expect(stdoutWriteSpy).toHaveBeenCalled();
    expect(stderrWriteSpy).toHaveBeenCalled();

    const runsDir = path.join(workspace, ".rundown", "runs");
    const [runDirName] = fs.readdirSync(runsDir);
    const phaseDir = path.join(runsDir, runDirName!, "01-worker");
    const metadata = JSON.parse(fs.readFileSync(path.join(phaseDir, "metadata.json"), "utf-8")) as {
      outputCaptured: boolean;
      notes?: string;
    };
    expect(metadata.outputCaptured).toBe(true);
    expect(metadata.notes).toBe("Interactive TUI mode captures and mirrors worker stdout/stderr transcripts.");
    expect(fs.readFileSync(path.join(phaseDir, "stdout.log"), "utf-8")).toBe("hello tui\n");
    expect(fs.readFileSync(path.join(phaseDir, "stderr.log"), "utf-8")).toBe("warn tui\n");

    stdoutWriteSpy.mockRestore();
    stderrWriteSpy.mockRestore();
  });

  it("uses custom artifact phase labels for directory naming", async () => {
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

    await runWorker({
      command: ["opencode", "run"],
      prompt: "scan prompt",
      mode: "wait",
      transport: "file",
      cwd: workspace,
      keepArtifacts: true,
      artifactPhase: "plan",
      artifactPhaseLabel: "plan-scan-01",
    });

    const runsDir = path.join(workspace, ".rundown", "runs");
    const [runDirName] = fs.readdirSync(runsDir);
    const phaseDir = path.join(runsDir, runDirName!, "01-plan-scan-01");
    const metadataPath = path.join(phaseDir, "metadata.json");

    expect(fs.existsSync(metadataPath)).toBe(true);
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf-8")) as {
      phase: string;
      phaseLabel?: string;
    };
    expect(metadata.phase).toBe("plan");
    expect(metadata.phaseLabel).toBe("plan-scan-01");
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
      cwd: workspace,
    });

    expect(result.exitCode).toBeNull();

    const promptFile = findFirstPromptFile(workspace);
    expect(promptFile).toMatch(/\.rundown[\\/]runs[\\/]run-.*[\\/]01-worker[\\/]prompt\.md$/);
    expect(fs.readFileSync(promptFile, "utf-8")).toBe("detached prompt");
  });

  it("fails fast when no worker command is provided", async () => {
    const { runWorker } = await import("../../src/infrastructure/runner.js");

    await expect(runWorker({
      command: [],
      prompt: "unused",
      mode: "wait",
      transport: "arg",
      cwd: workspace,
    })).rejects.toThrow("No command specified after --");
  });

  it("fails when file transport is requested but no prompt file was created", async () => {
    vi.resetModules();
    vi.doMock("../../src/infrastructure/runtime-artifacts.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/infrastructure/runtime-artifacts.js")>("../../src/infrastructure/runtime-artifacts.js");
      return {
        ...actual,
        beginRuntimePhase: vi.fn((context, options) => ({
          context,
          phase: options.phase,
          sequence: 1,
          dir: path.join(workspace, ".rundown", "runs", "mock-run", "01-worker"),
          promptFile: null,
          metadataFile: path.join(workspace, ".rundown", "runs", "mock-run", "01-worker", "metadata.json"),
          metadata: {
            runId: "mock-run",
            sequence: 1,
            phase: options.phase,
            outputCaptured: false,
            startedAt: new Date().toISOString(),
          },
        })),
      };
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    await expect(runWorker({
      command: ["node", "worker.js"],
      prompt: "prompt body",
      mode: "wait",
      transport: "file",
      cwd: workspace,
    })).rejects.toThrow("Prompt file transport requested but no prompt file was created.");

    vi.doUnmock("../../src/infrastructure/runtime-artifacts.js");
  });

  it("records worker errors before rethrowing", async () => {
    vi.resetModules();
    vi.doUnmock("../../src/infrastructure/runtime-artifacts.js");

    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.emit("error", new Error("spawn failed"));
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    await expect(runWorker({
      command: ["node", "worker.js"],
      prompt: "kept prompt",
      mode: "wait",
      transport: "file",
      cwd: workspace,
      keepArtifacts: true,
    })).rejects.toThrow("spawn failed");

    const runsDir = path.join(workspace, ".rundown", "runs");
    const [runDirName] = fs.readdirSync(runsDir);
    const phaseMetadataPath = path.join(runsDir, runDirName!, "01-worker", "metadata.json");
    const phaseMetadata = JSON.parse(fs.readFileSync(phaseMetadataPath, "utf-8")) as {
      exitCode: number | null;
      outputCaptured: boolean;
      notes?: string;
      extra?: Record<string, unknown>;
    };

    expect(phaseMetadata.exitCode).toBeNull();
    expect(phaseMetadata.outputCaptured).toBe(true);
    expect(phaseMetadata.notes).toBe("spawn failed");
    expect(phaseMetadata.extra).toEqual({ error: true });
  });

  it("does not fail when artifact directory is deleted before finalization", async () => {
    spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };

      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        fs.rmSync(path.join(workspace, ".rundown"), { recursive: true, force: true });
        child.emit("close", 0);
      });

      return child;
    });

    const { runWorker } = await import("../../src/infrastructure/runner.js");

    await expect(runWorker({
      command: ["opencode", "run"],
      prompt: "ephemeral prompt",
      mode: "wait",
      transport: "file",
      cwd: workspace,
    })).resolves.toMatchObject({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });
});

function findFirstPromptFile(workspace: string): string {
  const runsDir = path.join(workspace, ".rundown", "runs");
  for (const runDir of fs.readdirSync(runsDir)) {
    const phaseDir = path.join(runsDir, runDir, "01-worker", "prompt.md");
    if (fs.existsSync(phaseDir)) {
      return phaseDir;
    }
  }

  throw new Error("No prompt file found under .rundown/runs.");
}
