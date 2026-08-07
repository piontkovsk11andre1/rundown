import { describe, expect, it, vi } from "vitest";
import { createTuiHarness } from "./harness.ts";
import {
  createMainMenuSceneState,
  getMainMenuRows,
  refreshVisibleMainMenuStatuses,
} from "../../../src/presentation/tui/scenes/main-menu.ts";
import { ROW_IDS, createStatusProbeRegistry } from "../../../src/presentation/tui/status-probes.ts";

function expectSelectedRow(frame: string, label: string): void {
  expect(frame).toContain(`> ${label}`);
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("tui main menu integration", () => {
  it("renders all six menu rows", async () => {
    const harness = await createTuiHarness();
    expect(harness.frame()).toMatchSnapshot();
  });

  it("renders bootstrap menu in an empty workspace", async () => {
    const harness = await createTuiHarness({ emptyWorkspace: true });
    const frame = harness.frame();

    expect(frame).toContain("1. Start");
    expect(frame).toContain("2. Workers");
    expect(frame).toContain("3. Help");
    expect(frame).not.toContain("Continue");
    expect(frame).not.toContain("New Work");
  });

  it("wraps navigation from first row to last and back", async () => {
    const harness = await createTuiHarness();

    expectSelectedRow(harness.frame(), "1. Continue");

    await harness.press("up");
    expectSelectedRow(harness.frame(), "6. Help");

    await harness.press("down");
    expectSelectedRow(harness.frame(), "1. Continue");
  });

  it("refreshes each status probe once on entry", async () => {
    const probeCalls = Object.fromEntries(
      ROW_IDS.map((rowId) => [rowId, vi.fn(async () => ({ text: `${rowId}-ok`, tone: "ok" }))]),
    ) as Record<string, ReturnType<typeof vi.fn>>;
    const initializedRowIds = ["continue", "newWork", "workers", "profiles", "settings", "help"];

    const probeRegistry = createStatusProbeRegistry({
      probes: probeCalls,
      now: () => 100_000,
    });

    const state = createMainMenuSceneState();

    getMainMenuRows(state, { probeRegistry });
    await flushMicrotasks();
    getMainMenuRows(state, { probeRegistry });
    await flushMicrotasks();

    for (const rowId of initializedRowIds) {
      expect(probeCalls[rowId]).toHaveBeenCalledTimes(1);
      expect(probeCalls[rowId]).toHaveBeenCalledWith();
    }

    expect(probeCalls.start).not.toHaveBeenCalled();
  });

  it("refreshes only visible probes for empty bootstrap menu", async () => {
    const probeCalls = Object.fromEntries(
      ROW_IDS.map((rowId) => [rowId, vi.fn(async () => ({ text: `${rowId}-ok`, tone: "ok" }))]),
    ) as Record<string, ReturnType<typeof vi.fn>>;

    const probeRegistry = createStatusProbeRegistry({
      probes: probeCalls,
      now: () => 100_000,
    });

    const state = createMainMenuSceneState({ variant: "emptyBootstrap" });
    await refreshVisibleMainMenuStatuses(state, { probeRegistry });

    expect(probeCalls.start).toHaveBeenCalledTimes(1);
    expect(probeCalls.workers).toHaveBeenCalledTimes(1);
    expect(probeCalls.help).toHaveBeenCalledTimes(1);
    expect(probeCalls.continue).not.toHaveBeenCalled();
    expect(probeCalls.newWork).not.toHaveBeenCalled();
    expect(probeCalls.profiles).not.toHaveBeenCalled();
    expect(probeCalls.settings).not.toHaveBeenCalled();
  });
});
