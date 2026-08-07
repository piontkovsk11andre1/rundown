import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

import { createCliBlockExecutor } from "../../src/infrastructure/cli-block-executor.js";
import { createRuntimeArtifactsContext } from "../../src/infrastructure/runtime-artifacts.js";

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
});

describe("createCliBlockExecutor", () => {
  it("captures stdout and stderr from command execution", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const executor = createCliBlockExecutor();
    const resultPromise = executor.execute("echo hi", "/repo");

    child.stdout.emit("data", Buffer.from("ok"));
    child.stderr.emit("data", Buffer.from("warn"));
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "warn",
    });

    expect(spawnMock).toHaveBeenCalledWith("echo hi", expect.objectContaining({
      cwd: "/repo",
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
      env: expect.objectContaining(process.env),
    }));
  });

  it("merges custom environment variables into child process env", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const executor = createCliBlockExecutor();
    const resultPromise = executor.execute("echo hi", "/repo", {
      env: {
        RUNDOWN_VAR_DB_HOST: "localhost",
      },
    });

    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith("echo hi", expect.objectContaining({
      env: expect.objectContaining({
        ...process.env,
        RUNDOWN_VAR_DB_HOST: "localhost",
      }),
    }));
  });

  it("makes custom environment variables visible to spawned commands", async () => {
    const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockImplementation(spawn);

    const executor = createCliBlockExecutor();
    const result = await executor.execute(
      `node -e "process.stdout.write(process.env.RUNDOWN_VAR_DB_HOST || '')"`,
      process.cwd(),
      {
        env: {
          RUNDOWN_VAR_DB_HOST: "localhost",
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("localhost");
    expect(result.stderr).toBe("");
  });

  it("uses default timeout and marks command as timed out", async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    const child = createChildProcess() as ReturnType<typeof createChildProcess> & {
      kill: (signal: string) => void;
    };
    child.kill = kill;
    spawnMock.mockReturnValue(child);

    const executor = createCliBlockExecutor();
    const resultPromise = executor.execute("sleep 999", "/repo");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 124,
      stdout: "",
      stderr: "Command timed out after 30000ms.",
    });
  });

  it("supports custom timeout and preserves stderr content", async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    const child = createChildProcess() as ReturnType<typeof createChildProcess> & {
      kill: (signal: string) => void;
    };
    child.kill = kill;
    spawnMock.mockReturnValue(child);

    const executor = createCliBlockExecutor();
    const resultPromise = executor.execute("slow", "/repo", { timeoutMs: 50 });

    child.stderr.emit("data", Buffer.from("still running"));
    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 124,
      stdout: "",
      stderr: "still running\nCommand timed out after 50ms.",
    });
  });

  it("disables timeout when timeoutMs is zero", async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    const child = createChildProcess() as ReturnType<typeof createChildProcess> & {
      kill: (signal: string) => void;
    };
    child.kill = kill;
    spawnMock.mockReturnValue(child);

    const executor = createCliBlockExecutor();
    const resultPromise = executor.execute("slow", "/repo", { timeoutMs: 0 });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(kill).not.toHaveBeenCalled();

    child.emit("close", 0);
    await expect(resultPromise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  it("runs a real shell command and captures output", async () => {
    const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockImplementation(spawn);

    const executor = createCliBlockExecutor();
    const result = await executor.execute("echo hello", process.cwd());

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.stderr).toBe("");
  });

  it("records command execution into runtime artifacts when artifact context is provided", async () => {
    const { spawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    spawnMock.mockImplementation(spawn);

    const cwd = process.cwd();
    const context = createRuntimeArtifactsContext({
      cwd,
      commandName: "run",
      keepArtifacts: true,
    });

    const executor = createCliBlockExecutor();
    const result = await executor.execute("echo hello", cwd, {
      artifactContext: context,
      artifactPhase: "worker",
      artifactPhaseLabel: "cli-source",
      artifactExtra: { promptType: "source" },
      artifactCommandOrdinal: 3,
    });

    expect(result.exitCode).toBe(0);

    const phaseDir = path.join(context.rootDir, "01-cli-source");
    expect(fs.existsSync(path.join(phaseDir, "metadata.json"))).toBe(true);

    const metadata = JSON.parse(fs.readFileSync(path.join(phaseDir, "metadata.json"), "utf-8")) as {
      phase: string;
      phaseLabel?: string;
      command?: string[];
      extra?: Record<string, unknown>;
      stdoutFile?: string | null;
      stderrFile?: string | null;
      outputCaptured: boolean;
    };

    expect(metadata.phase).toBe("worker");
    expect(metadata.phaseLabel).toBe("cli-source");
    expect(metadata.command).toEqual(["echo hello"]);
    expect(metadata.outputCaptured).toBe(true);
    expect(metadata.extra).toEqual({
      promptType: "source",
      cliBlockCommand: "echo hello",
    });
    expect(metadata.stdoutFile).toBe("stdout.log");
    expect(metadata.stderrFile).toBeNull();
    expect(fs.readFileSync(path.join(phaseDir, "cli-block-3-stdout.txt"), "utf-8").trim()).toBe("hello");
    expect(fs.readFileSync(path.join(phaseDir, "cli-block-3-stderr.txt"), "utf-8")).toBe("");
  });
});

function createChildProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
