import { describe, expect, it, vi } from "vitest";
import {
  createMainMenuSceneState,
  getMainMenuRows,
  handleMainMenuInput,
  refreshMainMenuStatusProbe,
} from "../../../src/presentation/tui/scenes/main-menu.ts";

describe("main menu scene", () => {
  it("refreshes a single status probe by id", async () => {
    const refreshProbe = vi.fn(async () => ({ text: "ok", tone: "ok" }));

    await refreshMainMenuStatusProbe("continue", {
      probeRegistry: { refreshProbe },
    });

    expect(refreshProbe).toHaveBeenCalledTimes(1);
    expect(refreshProbe).toHaveBeenCalledWith("continue");
  });

  it("ignores empty probe ids", async () => {
    const refreshProbe = vi.fn(async () => ({ text: "ok", tone: "ok" }));

    await refreshMainMenuStatusProbe("", {
      probeRegistry: { refreshProbe },
    });

    expect(refreshProbe).not.toHaveBeenCalled();
  });

  it("renders bootstrap menu rows for empty workspace variant", () => {
    const state = createMainMenuSceneState({ variant: "emptyBootstrap" });
    const probeRegistry = {
      getProbeStatus: vi.fn(() => ({ text: "status", tone: "muted" })),
    };

    const rows = getMainMenuRows(state, { probeRegistry });

    expect(rows.map((row) => row.label)).toEqual(["Start", "Workers", "Help"]);
  });

  it("keeps navigation grammar scoped to visible rows", () => {
    let state = createMainMenuSceneState({ variant: "emptyBootstrap" });

    const moved = handleMainMenuInput(state, "k");
    expect(moved.state.selectedIndex).toBe(2);

    state = moved.state;
    const jumped = handleMainMenuInput(state, "3");
    expect(jumped.state.selectedIndex).toBe(2);

    const selected = handleMainMenuInput(jumped.state, "\r");
    expect(selected.routeTo).toBe("help");
  });

  it("ignores numeric jump targets outside visible bootstrap rows", () => {
    const state = createMainMenuSceneState({ variant: "emptyBootstrap" });

    const result = handleMainMenuInput(state, "4");

    expect(result.state.selectedIndex).toBe(0);
    const selected = handleMainMenuInput(result.state, "\r");
    expect(selected.routeTo).toBe("start");
  });
});
