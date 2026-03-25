import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
  spawnMock,
  beginRuntimePhaseMock,
  completeRuntimePhaseMock,
  createRuntimeArtifactsContextMock,
  finalizeRuntimeArtifactsMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  beginRuntimePhaseMock: vi.fn(() => ({ phase: "inline-cli" })),
  completeRuntimePhaseMock: vi.fn(),
  createRuntimeArtifactsContextMock: vi.fn(() => ({ runId: "run-inline", rootDir: "/tmp/run-inline" })),
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

import { executeInlineCli } from "../../src/infrastructure/inline-cli.js";

afterEach(() => {
  spawnMock.mockReset();
  beginRuntimePhaseMock.mockClear();
  completeRuntimePhaseMock.mockClear();
  createRuntimeArtifactsContextMock.mockClear();
  finalizeRuntimeArtifactsMock.mockClear();
});

describe("executeInlineCli", () => {
  it("uses provided artifact context and captures stdout/stderr on success", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const artifactContext = { runId: "existing-run" };
    const promise = executeInlineCli("npm test", "/repo", { artifactContext, artifactExtra: { taskType: "inline" } });

    child.stdout.emit("data", Buffer.from("hello"));
    child.stderr.emit("data", Buffer.from("warn"));
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({
      exitCode: 0,
      stdout: "hello",
      stderr: "warn",
    });

    expect(createRuntimeArtifactsContextMock).not.toHaveBeenCalled();
    expect(beginRuntimePhaseMock).toHaveBeenCalledWith(artifactContext, expect.objectContaining({
      phase: "inline-cli",
      command: ["npm test"],
      extra: { taskType: "inline" },
    }));
    expect(completeRuntimePhaseMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      exitCode: 0,
      stdout: "hello",
      stderr: "warn",
      outputCaptured: true,
    }));
    expect(finalizeRuntimeArtifactsMock).not.toHaveBeenCalled();
  });

  it("creates and finalizes owned artifacts when no context is provided", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeInlineCli("npm run lint", "/repo", { keepArtifacts: true });
    child.emit("close", 9);

    await expect(promise).resolves.toEqual({
      exitCode: 9,
      stdout: "",
      stderr: "",
    });

    expect(createRuntimeArtifactsContextMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/repo",
      commandName: "inline-cli",
      workerCommand: ["npm run lint"],
      keepArtifacts: true,
    }));
    expect(finalizeRuntimeArtifactsMock).toHaveBeenCalledWith(expect.anything(), {
      status: "failed",
      preserve: true,
    });
  });

  it("records phase failure and rejects when spawn emits error", async () => {
    const child = createChildProcess();
    spawnMock.mockReturnValue(child);

    const promise = executeInlineCli("npm run build", "/repo");
    const error = new Error("spawn failed");
    child.emit("error", error);

    await expect(promise).rejects.toThrow("spawn failed");
    expect(completeRuntimePhaseMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      exitCode: null,
      outputCaptured: true,
      notes: "spawn failed",
      extra: { error: true },
    }));
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
