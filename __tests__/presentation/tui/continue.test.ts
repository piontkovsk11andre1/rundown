import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTuiHarness } from "./harness.ts";
import { createApp } from "../../../src/create-app.js";

let resolveRunTask: ((exitCode: number) => void) | null = null;

vi.mock("../../../src/create-app.js", () => ({
  createApp: vi.fn((options?: { ports?: { output?: { emit?: (event: unknown) => void } } }) => {
    const emit = options?.ports?.output?.emit;
    return {
      listTasks: vi.fn(async () => {
        emit?.({ kind: "task", task: { line: 12, textLines: ["First unchecked task"] } });
        emit?.({ kind: "task", task: { line: 24, textLines: ["Second unchecked task"] } });
        emit?.({ kind: "task", task: { line: 48, textLines: ["Third unchecked task"] } });
        return 0;
      }),
      runTask: vi.fn(async () => new Promise<number>((resolve) => {
        resolveRunTask = resolve;
      })),
      releaseAllLocks: vi.fn(),
      awaitShutdown: vi.fn(async () => {}),
    };
  }),
}));

describe("tui continue integration", () => {
  beforeEach(() => {
    resolveRunTask = null;
    vi.clearAllMocks();
  });

  it("moves preview to run, follows phase transitions, and shows done counts", async () => {
    const harness = await createTuiHarness({ initialScene: "continue" });

    expect(harness.frame()).toContain("Continue Preview");
    expect(harness.frame()).toContain("next: 012 - First unchecked task");

    await harness.press("enter");

    expect(harness.frame()).toContain("Action:  materialize");
    expect(harness.frame()).toContain("Operation:     SCAN");

    await harness.emit({
      kind: "group-start",
      label: "Task 1",
      counter: { current: 1, total: 3 },
    });
    expect(harness.frame()).toContain("Operation:     EXECUTE");

    await harness.emit({
      kind: "progress",
      progress: { label: "scan", current: 1, total: 5, detail: "scan 1/5" },
    });
    expect(harness.frame()).toContain("Operation:     SCAN");

    await harness.emit({
      kind: "info",
      message: "verifying task output",
    });
    expect(harness.frame()).toContain("Operation:     VERIFY");

    await harness.emit({
      kind: "group-end",
      status: "failure",
      message: "verify failed",
    });
    expect(harness.frame()).toContain("Operation:     REPAIR");

    await harness.emit({
      kind: "group-start",
      label: "Task 2",
      counter: { current: 2, total: 3 },
    });
    await harness.emit({
      kind: "group-end",
      status: "success",
    });
    expect(harness.frame()).toContain("Operation:     FINALIZE");

    resolveRunTask?.(0);
    await Promise.resolve();
    await Promise.resolve();
    await harness.emit({ kind: "info", message: "run complete" });

    expect(harness.frame()).toContain("Run Summary");
    expect(harness.frame()).toContain("Counts: 1/3 tasks");
    expect(harness.frame()).toContain("Failures: 1   Repairs: 0   Resolves: 0");
    expect(harness.frame()).toContain("Run complete (exit 0).");
    expect(createApp).toHaveBeenCalled();
  });
});
