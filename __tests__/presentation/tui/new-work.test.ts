import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTuiHarness } from "./harness.ts";
import { createApp } from "../../../src/create-app.js";

const newWorkMockState = vi.hoisted(() => ({
  helpTaskCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/create-app.js", () => ({
  createApp: vi.fn((options?: { ports?: { output?: { emit?: (event: unknown) => void } } }) => {
    const emit = options?.ports?.output?.emit;
    return {
      configList: vi.fn(async () => {
        emit?.({ kind: "text", text: JSON.stringify({ config: { workers: { default: ["mock-worker"] } } }) });
        return 0;
      }),
      viewWorkerHealthStatus: vi.fn(async () => {
        emit?.({
          kind: "text",
          text: JSON.stringify({
            fallbackOrderSnapshots: [
              {
                commandName: "run",
                candidates: [{ workerLabel: "mock-worker", source: "default", eligible: true }],
              },
            ],
          }),
        });
        return 0;
      }),
      helpTask: vi.fn(async (options: Record<string, unknown>) => {
        newWorkMockState.helpTaskCalls.push(options);
        return 0;
      }),
      releaseAllLocks: vi.fn(),
      awaitShutdown: vi.fn(async () => {}),
    };
  }),
}));

describe("tui new work integration", () => {
  beforeEach(() => {
    newWorkMockState.helpTaskCalls.length = 0;
    vi.clearAllMocks();
  });

  it("shows the missing agent recovery panel", async () => {
    const harness = await createTuiHarness({ initialScene: "newWork" });

    const frame = harness.frame();
    expect(frame).toContain("No agent prompt found.");
    expect(frame).toContain("rundown looks for the agent prompt at .rundown/agent.md.");
    expect(frame).toContain("[g]  Generate from template (writes .rundown/agent.md)");
  });

  it("generates .rundown/agent.md with g and returns to ready actions", async () => {
    const harness = await createTuiHarness({ initialScene: "newWork" });

    await harness.press("g");

    const frame = harness.frame();
    expect(frame).toContain("Select agent flow:");
    expect(frame).toContain("[Enter] Open agent (.rundown/agent.md)");
    expect(frame).not.toContain("No agent prompt found.");
  });

  it("enters the ready path on Enter and runs the agent view", async () => {
    const harness = await createTuiHarness({
      initialScene: "newWork",
      workspaceFiles: {
        ".rundown/agent.md": "# Test agent\n\nDo the next unchecked task.\n",
      },
    });

    expect(harness.frame()).toContain("Select agent flow:");

    await harness.press("enter");

    const frame = harness.frame();
    expect(frame).toContain("Main Menu:");
    expect(frame).toContain("New Work session ended.");
    expect(newWorkMockState.helpTaskCalls).toHaveLength(1);
    expect(newWorkMockState.helpTaskCalls[0]?.promptOverride).toContain("# Test agent");
    expect(createApp).toHaveBeenCalled();
  });
});
