import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CODE_FAILURE,
  EXIT_CODE_NO_WORK,
  normalizeExitCode,
} from "../../src/domain/exit-codes.js";
import {
  runPostCommandAutoCompact,
} from "../../src/application/post-command-auto-compact.js";

describe("runPostCommandAutoCompact", () => {
  it.each([
    { condition: "failure", primaryExitCode: EXIT_CODE_FAILURE },
    { condition: "no-work", primaryExitCode: EXIT_CODE_NO_WORK },
    { condition: "dry-run", primaryExitCode: EXIT_CODE_NO_WORK },
    { condition: "print-only", primaryExitCode: EXIT_CODE_NO_WORK },
    { condition: "cancellation", primaryExitCode: 130 },
  ])("skips compaction for $condition primary outcomes", async ({ primaryExitCode }) => {
    const compactTask = vi.fn(async () => 0);
    const emit = vi.fn();

    const exitCode = await runPostCommandAutoCompact({
      primaryExitCode,
      autoCompact: { beforeExit: true },
      compactTask,
      output: { emit },
    });

    expect(exitCode).toBe(normalizeExitCode(primaryExitCode));
    expect(compactTask).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("skips compaction when compact-before-exit is disabled", async () => {
    const compactTask = vi.fn(async () => 0);
    const emit = vi.fn();

    const exitCode = await runPostCommandAutoCompact({
      primaryExitCode: 0,
      autoCompact: { beforeExit: false },
      compactTask,
      output: { emit },
    });

    expect(exitCode).toBe(0);
    expect(compactTask).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("runs compaction after successful primary command", async () => {
    const compactTask = vi.fn(async () => 0);
    const emit = vi.fn();

    const exitCode = await runPostCommandAutoCompact({
      primaryExitCode: 0,
      workspace: "../workspace-source",
      autoCompact: { beforeExit: true },
      compactTask,
      output: { emit },
    });

    expect(exitCode).toBe(0);
    expect(compactTask).toHaveBeenCalledTimes(1);
    expect(compactTask).toHaveBeenCalledWith({
      workspace: "../workspace-source",
      target: "all",
      dryRun: false,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps primary success when compaction reports no-work", async () => {
    const compactTask = vi.fn(async () => 3);
    const emit = vi.fn();

    const exitCode = await runPostCommandAutoCompact({
      primaryExitCode: 0,
      autoCompact: { beforeExit: true },
      compactTask,
      output: { emit },
    });

    expect(exitCode).toBe(0);
    expect(compactTask).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("returns failure and emits an error when auto-compaction fails", async () => {
    const compactTask = vi.fn(async () => 1);
    const emit = vi.fn();

    const exitCode = await runPostCommandAutoCompact({
      primaryExitCode: 0,
      autoCompact: { beforeExit: true },
      compactTask,
      output: { emit },
    });

    expect(exitCode).toBe(1);
    expect(compactTask).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      kind: "error",
      message: "Primary command succeeded, but --compact-before-exit failed (target=all).",
    });
  });

  it("returns failure and emits the thrown compaction error", async () => {
    const compactTask = vi.fn(async () => {
      throw new Error("disk unavailable");
    });
    const emit = vi.fn();

    const exitCode = await runPostCommandAutoCompact({
      primaryExitCode: 0,
      autoCompact: { beforeExit: true },
      compactTask,
      output: { emit },
    });

    expect(exitCode).toBe(1);
    expect(compactTask).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith({
      kind: "error",
      message: "Primary command succeeded, but --compact-before-exit failed (target=all): disk unavailable",
    });
  });
});
