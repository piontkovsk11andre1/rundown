import { describe, expect, it, vi } from "vitest";
import {
  handleTemplateCliFailure,
  TemplateCliBlockExecutionError,
  withCliTrace,
  withCommandExecutionHandler,
  withSourceCliFailureWarning,
  withTemplateCliFailureAbort,
} from "../../src/application/cli-block-handlers.js";

describe("cli-block-handlers", () => {
  it("chains command execution handlers", async () => {
    const first = vi.fn();
    const second = vi.fn();
    const options = withCommandExecutionHandler(
      {
        onCommandExecuted: async (execution) => {
          first(execution.command);
        },
      },
      async (execution) => {
        second(execution.command);
      },
    );

    await options?.onCommandExecuted?.({
      command: "echo hello",
      exitCode: 0,
      stdoutLength: 5,
      stderrLength: 0,
      durationMs: 12,
    });

    expect(first).toHaveBeenCalledWith("echo hello");
    expect(second).toHaveBeenCalledWith("echo hello");
  });

  it("writes cli trace events", async () => {
    const write = vi.fn();
    const options = withCliTrace(
      undefined,
      { write, flush: vi.fn() },
      "run-1",
      () => "2026-01-01T00:00:00.000Z",
    );

    await options?.onCommandExecuted?.({
      command: "echo trace",
      exitCode: 0,
      stdoutLength: 10,
      stderrLength: 0,
      durationMs: 25,
    });

    expect(write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "cli_block.executed",
      run_id: "run-1",
    }));
  });

  it("warns on source cli failures and throws on template failures", async () => {
    const emit = vi.fn();
    const warning = withSourceCliFailureWarning(undefined, emit);
    await warning?.onCommandExecuted?.({
      command: "echo fail",
      exitCode: 2,
      stdoutLength: 0,
      stderrLength: 1,
      durationMs: 3,
    });
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      kind: "warn",
      message: expect.stringContaining("source markdown"),
    }));

    const abort = withTemplateCliFailureAbort(undefined, "verify template");
    await expect(abort?.onCommandExecuted?.({
      command: "echo fail",
      exitCode: 1,
      stdoutLength: 0,
      stderrLength: 1,
      durationMs: 3,
    })).rejects.toThrow(TemplateCliBlockExecutionError);
  });

  it("handles template failure errors and delegates unknown errors", async () => {
    const emit = vi.fn();
    const onFailureHook = vi.fn(async () => {});
    const failRun = vi.fn(async () => 1);

    const handled = await handleTemplateCliFailure(
      new TemplateCliBlockExecutionError("repair template", "echo fail", 1),
      emit,
      onFailureHook,
      failRun,
    );
    expect(handled).toBe(1);
    expect(onFailureHook).toHaveBeenCalledTimes(1);

    const notHandled = await handleTemplateCliFailure(
      new Error("different"),
      emit,
      onFailureHook,
      failRun,
    );
    expect(notHandled).toBeNull();
  });
});
