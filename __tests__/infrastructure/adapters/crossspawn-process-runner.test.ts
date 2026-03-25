import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("cross-spawn", () => ({
  default: spawnMock,
}));

import { createCrossSpawnProcessRunner } from "../../../src/infrastructure/adapters/crossspawn-process-runner.js";

afterEach(() => {
  spawnMock.mockReset();
  vi.useRealTimers();
});

describe("createCrossSpawnProcessRunner", () => {
  it("runs detached commands and unreferences the child", async () => {
    const unref = vi.fn();
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = unref;
    spawnMock.mockReturnValue(child);

    const runner = createCrossSpawnProcessRunner();
    const result = await runner.run({ command: "node", args: ["server.js"], cwd: "/repo", mode: "detached" });

    expect(result).toEqual({ exitCode: null, stdout: "", stderr: "" });
    expect(spawnMock).toHaveBeenCalledWith("node", ["server.js"], expect.objectContaining({
      cwd: "/repo",
      detached: true,
      stdio: "ignore",
    }));
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("runs tui commands with inherited stdio", async () => {
    const child = new EventEmitter();
    spawnMock.mockReturnValue(child);

    const runner = createCrossSpawnProcessRunner();
    const promise = runner.run({ command: "npm", args: ["test"], cwd: "/repo", mode: "tui", shell: true });
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(spawnMock).toHaveBeenCalledWith("npm", ["test"], expect.objectContaining({
      cwd: "/repo",
      shell: true,
      stdio: "inherit",
    }));
  });

  it("captures stdout and stderr in wait mode", async () => {
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    spawnMock.mockReturnValue(child);

    const runner = createCrossSpawnProcessRunner();
    const promise = runner.run({ command: "npm", args: ["run", "lint"], cwd: "/repo", mode: "wait", env: { CI: "1" } });
    child.stdout.emit("data", Buffer.from("ok"));
    child.stderr.emit("data", Buffer.from("warn"));
    child.emit("close", 3);

    await expect(promise).resolves.toEqual({ exitCode: 3, stdout: "ok", stderr: "warn" });
    expect(spawnMock).toHaveBeenCalledWith("npm", ["run", "lint"], expect.objectContaining({
      cwd: "/repo",
      env: { CI: "1" },
      stdio: ["inherit", "pipe", "pipe"],
    }));
  });

  it("kills wait-mode process on timeout", async () => {
    vi.useFakeTimers();

    const kill = vi.fn();
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: (signal: string) => void };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = kill;
    spawnMock.mockReturnValue(child);

    const runner = createCrossSpawnProcessRunner();
    const promise = runner.run({ command: "npm", args: ["run", "slow"], cwd: "/repo", mode: "wait", timeoutMs: 50 });

    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", null);
    await expect(promise).resolves.toEqual({ exitCode: null, stdout: "", stderr: "" });
  });
});
