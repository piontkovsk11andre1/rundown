import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureCommanderOutputHandlers, emitCliFatalError } from "../../src/presentation/cli-invocation-log.js";
import type { CliInvocationLogState } from "../../src/presentation/cli-invocation-types.js";

const UTC_ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("configureCommanderOutputHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("ignores empty Commander parse-time writes for global log mirroring", () => {
    const command = new Command();
    const write = vi.fn();
    const state: CliInvocationLogState = {
      writer: { write },
      context: {
        command: "run",
        argv: ["run", "tasks.md"],
        cwd: "/workspace",
        pid: 123,
        version: "1.2.3",
        sessionId: "session-1",
      },
    };

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    configureCommanderOutputHandlers(command, () => state);

    type OutputConfiguration = {
      writeOut: (output: string) => void;
      writeErr: (output: string) => void;
    };
    const outputConfiguration = (command as unknown as { _outputConfiguration: OutputConfiguration })._outputConfiguration;

    outputConfiguration.writeOut("");
    outputConfiguration.writeErr("");

    expect(write).not.toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("mirrors non-empty Commander parse-time stdout and stderr writes", () => {
    const command = new Command();
    const write = vi.fn();
    const state: CliInvocationLogState = {
      writer: { write },
      context: {
        command: "run",
        argv: ["run", "tasks.md"],
        cwd: "/workspace",
        pid: 123,
        version: "1.2.3",
        sessionId: "session-1",
      },
    };

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    configureCommanderOutputHandlers(command, () => state);

    type OutputConfiguration = {
      writeOut: (output: string) => void;
      writeErr: (output: string) => void;
    };
    const outputConfiguration = (command as unknown as { _outputConfiguration: OutputConfiguration })._outputConfiguration;

    outputConfiguration.writeOut("Usage: rundown run [options]\n");
    outputConfiguration.writeErr("error: unknown option '--bad-flag'\n");

    expect(stdoutSpy).toHaveBeenCalledWith("Usage: rundown run [options]\n");
    expect(stderrSpy).toHaveBeenCalledWith("error: unknown option '--bad-flag'\n");

    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, expect.objectContaining({
      level: "info",
      stream: "stdout",
      kind: "commander",
      message: "Usage: rundown run [options]\n",
      command: "run",
      argv: ["run", "tasks.md"],
      cwd: "/workspace",
      pid: 123,
      version: "1.2.3",
      session_id: "session-1",
      ts: expect.any(String),
    }));
    expect(write).toHaveBeenNthCalledWith(2, expect.objectContaining({
      level: "error",
      stream: "stderr",
      kind: "commander",
      message: "error: unknown option '--bad-flag'\n",
      command: "run",
      argv: ["run", "tasks.md"],
      cwd: "/workspace",
      pid: 123,
      version: "1.2.3",
      session_id: "session-1",
      ts: expect.any(String),
    }));

    const firstTs = (write.mock.calls[0]?.[0] as { ts: string }).ts;
    const secondTs = (write.mock.calls[1]?.[0] as { ts: string }).ts;
    expect(firstTs).toMatch(UTC_ISO_8601_TIMESTAMP);
    expect(secondTs).toMatch(UTC_ISO_8601_TIMESTAMP);
  });

  it("writes fatal invocation log entries with UTC ISO timestamps", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-28T21:22:23.456Z"));

    const write = vi.fn();
    const state: CliInvocationLogState = {
      writer: { write },
      context: {
        command: "run",
        argv: ["run", "tasks.md"],
        cwd: "/workspace",
        pid: 123,
        version: "1.2.3",
        sessionId: "session-fatal",
      },
    };

    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    emitCliFatalError("boom", state);

    expect(stderrSpy).toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      kind: "cli-fatal",
      level: "error",
      stream: "stderr",
      message: "boom",
      ts: "2026-03-28T21:22:23.456Z",
    }));
    expect((write.mock.calls[0]?.[0] as { ts: string }).ts).toMatch(UTC_ISO_8601_TIMESTAMP);

    vi.useRealTimers();
  });
});
