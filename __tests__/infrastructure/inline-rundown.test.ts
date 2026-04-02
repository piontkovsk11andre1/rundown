import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeArtifactsContext } from "../../src/infrastructure/runtime-artifacts.js";

const {
  spawnMock,
  beginRuntimePhaseMock,
  completeRuntimePhaseMock,
  createRuntimeArtifactsContextMock,
  finalizeRuntimeArtifactsMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  beginRuntimePhaseMock: vi.fn(() => ({ phase: "worker" })),
  completeRuntimePhaseMock: vi.fn(),
  createRuntimeArtifactsContextMock: vi.fn(() => ({ runId: "run-rundown", rootDir: "/tmp/run-rundown" })),
  finalizeRuntimeArtifactsMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../../src/infrastructure/runtime-artifacts.js", () => ({
  beginRuntimePhase: beginRuntimePhaseMock,
  completeRuntimePhase: completeRuntimePhaseMock,
  createRuntimeArtifactsContext: createRuntimeArtifactsContextMock,
  finalizeRuntimeArtifacts: finalizeRuntimeArtifactsMock,
}));

import { executeRundownTask } from "../../src/infrastructure/inline-rundown.js";

const ORIGINAL_ARGV = process.argv.slice();

afterEach(() => {
  spawnMock.mockReset();
  beginRuntimePhaseMock.mockClear();
  completeRuntimePhaseMock.mockClear();
  createRuntimeArtifactsContextMock.mockClear();
  finalizeRuntimeArtifactsMock.mockClear();
  process.argv = ORIGINAL_ARGV.slice();
});

describe("executeRundownTask", () => {
  it("uses process argv runtime and entrypoint by default", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js", "run", "Parent.md"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(["Child.md", "--verify"], "/repo");
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      ["/repo/dist/cli.js", "run", "Child.md", "--verify"],
      expect.objectContaining({
        cwd: "/repo",
        stdio: ["inherit", "pipe", "pipe"],
        shell: false,
      }),
    );
  });

  it("uses explicit rundownCommand override when provided", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(["Child.md"], "/repo", {
      rundownCommand: ["rundown", "--config", "custom.toml"],
    });
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "rundown",
      ["--config", "custom.toml", "run", "Child.md"],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("falls back to rundown binary when argv is unavailable", async () => {
    process.argv = [];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(["Child.md"], "/repo");
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "rundown",
      ["run", "Child.md"],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("forwards parent worker, transport and boolean flags when not overridden", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(["Child.md"], "/repo", {
      parentWorkerCommand: ["opencode", "run"],
      parentTransport: "arg",
      parentKeepArtifacts: true,
      parentShowAgentOutput: true,
      parentIgnoreCliBlock: true,
      parentVerify: false,
      parentNoRepair: true,
      parentRepairAttempts: 2,
    });
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      [
        "/repo/dist/cli.js",
        "run",
        "Child.md",
        "--worker",
        "opencode",
        "run",
        "--transport",
        "arg",
        "--keep-artifacts",
        "--show-agent-output",
        "--ignore-cli-block",
        "--no-verify",
        "--no-repair",
      ],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("does not forward parent flags when inline args override them", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(
      ["Child.md", "--worker", "child", "--transport=arg", "--keep-artifacts", "--show-agent-output"],
      "/repo",
      {
        parentWorkerCommand: ["parent", "run"],
        parentTransport: "file",
        parentKeepArtifacts: true,
        parentShowAgentOutput: true,
        parentIgnoreCliBlock: true,
        parentVerify: true,
        parentNoRepair: true,
        parentRepairAttempts: 8,
      },
    );
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      [
        "/repo/dist/cli.js",
        "run",
        "Child.md",
        "--worker",
        "child",
        "--transport=arg",
        "--keep-artifacts",
        "--show-agent-output",
        "--ignore-cli-block",
        "--verify",
        "--no-repair",
      ],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("does not forward --show-agent-output when inline args disable it explicitly", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(
      ["Child.md", "--no-show-agent-output"],
      "/repo",
      {
        parentWorkerCommand: ["parent", "run"],
        parentTransport: "file",
        parentKeepArtifacts: false,
        parentShowAgentOutput: true,
        parentIgnoreCliBlock: false,
        parentVerify: true,
        parentNoRepair: false,
        parentRepairAttempts: 1,
      },
    );
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      [
        "/repo/dist/cli.js",
        "run",
        "Child.md",
        "--no-show-agent-output",
        "--worker",
        "parent",
        "run",
        "--transport",
        "file",
        "--verify",
        "--repair-attempts",
        "1",
      ],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("does not forward parent verify or no-repair when inline args override repair attempts", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(
      ["Child.md", "--no-verify", "--repair-attempts=3"],
      "/repo",
      {
        parentVerify: true,
        parentNoRepair: true,
        parentRepairAttempts: 9,
      },
    );
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      [
        "/repo/dist/cli.js",
        "run",
        "Child.md",
        "--no-verify",
        "--repair-attempts=3",
      ],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("forwards parent verify and repair attempts when not overridden", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(["Child.md"], "/repo", {
      parentVerify: true,
      parentNoRepair: false,
      parentRepairAttempts: 4,
    });
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      [
        "/repo/dist/cli.js",
        "run",
        "Child.md",
        "--verify",
        "--repair-attempts",
        "4",
      ],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("keeps inline verify and no-repair overrides over parent defaults", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(
      ["Child.md", "--verify", "--no-repair"],
      "/repo",
      {
        parentVerify: false,
        parentNoRepair: false,
        parentRepairAttempts: 6,
      },
    );
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      [
        "/repo/dist/cli.js",
        "run",
        "Child.md",
        "--verify",
        "--no-repair",
      ],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("normalizes legacy --retries overrides to --repair-attempts", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(
      ["Child.md", "--no-repair", "--retries", "0", "--retries=2"],
      "/repo",
      {
        parentNoRepair: true,
        parentRepairAttempts: 9,
      },
    );
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });

    expect(spawnMock).toHaveBeenCalledWith(
      "/usr/local/bin/node",
      [
        "/repo/dist/cli.js",
        "run",
        "Child.md",
        "--no-repair",
        "--repair-attempts",
        "0",
        "--repair-attempts=2",
      ],
      expect.objectContaining({
        cwd: "/repo",
        shell: false,
      }),
    );
  });

  it("uses provided artifact context and records rundown-delegate phase details", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const artifactContext: RuntimeArtifactsContext = {
      runId: "existing-run",
      rootDir: "/tmp/existing-run",
      cwd: "/repo",
      configDir: "/repo/.rundown",
      keepArtifacts: false,
      commandName: "rundown-delegate",
      sequence: 0,
    };
    const promise = executeRundownTask(["Child.md", "--verify"], "/repo", {
      artifactContext,
      artifactExtra: { taskType: "rundown" },
    });

    child.stdout.emit("data", Buffer.from("ok"));
    child.stderr.emit("data", Buffer.from("warn"));
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "warn",
    });

    expect(createRuntimeArtifactsContextMock).not.toHaveBeenCalled();
    expect(beginRuntimePhaseMock).toHaveBeenCalledWith(
      artifactContext,
      expect.objectContaining({
        phase: "rundown-delegate",
        phaseLabel: "rundown-delegate",
        command: ["/usr/local/bin/node", "/repo/dist/cli.js", "run", "Child.md", "--verify"],
        transport: "rundown-delegate",
        extra: { taskType: "rundown" },
      }),
    );
    expect(completeRuntimePhaseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        exitCode: 0,
        stdout: "ok",
        stderr: "warn",
        outputCaptured: true,
      }),
    );
    expect(finalizeRuntimeArtifactsMock).not.toHaveBeenCalled();
  });

  it("creates and finalizes owned artifact context for delegated rundown runs", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(["Child.md"], "/repo", { keepArtifacts: true });
    child.emit("close", 9);

    await expect(promise).resolves.toEqual({
      exitCode: 9,
      stdout: "",
      stderr: "",
    });

    expect(createRuntimeArtifactsContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        commandName: "rundown-delegate",
        workerCommand: ["/usr/local/bin/node", "/repo/dist/cli.js", "run", "Child.md"],
        transport: "rundown-delegate",
        keepArtifacts: true,
      }),
    );
    expect(finalizeRuntimeArtifactsMock).toHaveBeenCalledWith(expect.anything(), {
      status: "failed",
      preserve: true,
    });
  });

  it("records artifact failure details when spawn emits error", async () => {
    process.argv = ["/usr/local/bin/node", "/repo/dist/cli.js"];
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeRundownTask(["Child.md"], "/repo");
    const error = new Error("spawn failed");
    child.emit("error", error);

    await expect(promise).rejects.toThrow("spawn failed");
    expect(completeRuntimePhaseMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        exitCode: null,
        outputCaptured: true,
        notes: "spawn failed",
        extra: { error: true },
      }),
    );
    expect(finalizeRuntimeArtifactsMock).toHaveBeenCalledWith(expect.anything(), {
      status: "failed",
      preserve: false,
    });
  });
});

function createChildProcess(): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}
