import { describe, expect, it } from "vitest";
import {
  createHealthSceneState,
  handleHealthInput,
  renderHealthSceneLines,
  runHealthSceneAction,
} from "../../../src/presentation/tui/scenes/health.ts";

function stripAnsi(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, "");
}

function baseStateWithFailingEntry() {
  return {
    ...createHealthSceneState(),
    loading: false,
    healthStatus: {
      generatedAt: "2026-05-02T00:00:00.000Z",
      filePath: ".rundown/worker-health.json",
      configDir: ".rundown",
      entries: [
        {
          source: "worker",
          key: "worker:[\"codex\"]",
          identity: "codex",
          status: "cooling_down",
          lastFailureClass: "usage_limit",
          lastFailureAt: "2026-05-02T03:30:00.000Z",
          cooldownUntil: "2026-05-02T03:47:00.000Z",
          failureCountWindow: 3,
        },
      ],
    },
    config: {},
    configPath: ".rundown/config.json",
    selectedIndex: 0,
  };
}

function baseStateWithReadyEntry() {
  return {
    ...createHealthSceneState(),
    loading: false,
    healthStatus: {
      generatedAt: "2026-05-02T00:00:00.000Z",
      filePath: ".rundown/worker-health.json",
      configDir: ".rundown",
      entries: [
        {
          source: "worker",
          key: "worker:[\"opencode\"]",
          identity: "opencode",
          status: "ready",
          lastSuccessAt: "2026-05-02T02:00:00.000Z",
        },
      ],
    },
    config: {},
    configPath: ".rundown/config.json",
    selectedIndex: 0,
  };
}

describe("health scene recent-failures pager", () => {
  it("[Enter] on a selected entry produces a view-recent-failures action", () => {
    const state = baseStateWithFailingEntry();
    const result = handleHealthInput({ rawInput: "\r", state });
    expect(result.handled).toBe(true);
    expect(result.action).toEqual({
      type: "view-recent-failures",
      index: 0,
      key: "worker:[\"codex\"]",
    });
  });

  it("view-recent-failures action enters the pager sub-view with title and entry context", async () => {
    const state = baseStateWithFailingEntry();
    const next = await runHealthSceneAction({
      action: { type: "view-recent-failures", index: 0, key: "worker:[\"codex\"]" },
      state,
    });
    expect(next.view).toBe("recent-failures");
    expect(next.pagerState).not.toBeNull();
    expect(next.pagerState.title).toContain("Recent failures");
    expect(next.pagerState.title).toContain("codex");
    expect(next.pagerEntryKey).toBe("worker:[\"codex\"]");
    expect(next.pagerState.filePath).toBe(".rundown/worker-health.json");
  });

  it("renders the pager content (last failure class, timestamp, future-history note) when in the recent-failures view", async () => {
    const state = baseStateWithFailingEntry();
    const next = await runHealthSceneAction({
      action: { type: "view-recent-failures", index: 0, key: "worker:[\"codex\"]" },
      state,
    });
    const rendered = renderHealthSceneLines({ state: next }).map(stripAnsi);
    expect(rendered.some((line) => line.includes("Recent failures"))).toBe(true);
    expect(rendered.some((line) => line.includes("usage_limit"))).toBe(true);
    expect(rendered.some((line) => line.includes("2026-05-02"))).toBe(true);
    expect(rendered.some((line) => line.includes("recentFailures"))).toBe(true);
    expect(rendered.some((line) => line.includes("[q/Esc] close"))).toBe(true);
  });

  it("shows '(none recorded)' when the selected entry has no failure history", async () => {
    const state = baseStateWithReadyEntry();
    const next = await runHealthSceneAction({
      action: { type: "view-recent-failures", index: 0, key: "worker:[\"opencode\"]" },
      state,
    });
    const rendered = renderHealthSceneLines({ state: next }).map(stripAnsi);
    expect(rendered.some((line) => line.includes("Last failure: (none recorded)"))).toBe(true);
    expect(rendered.some((line) => line.includes("Last success"))).toBe(true);
  });

  it("scrolls within the pager via j/k without leaving the sub-view", async () => {
    const state = baseStateWithFailingEntry();
    const opened = await runHealthSceneAction({
      action: { type: "view-recent-failures", index: 0, key: "worker:[\"codex\"]", viewportHeight: 5 },
      state,
    });
    const downResult = handleHealthInput({ rawInput: "j", state: opened });
    expect(downResult.handled).toBe(true);
    expect(downResult.backToParent).toBe(false);
    expect(downResult.state.view).toBe("recent-failures");
    expect(downResult.state.pagerState.offset).toBe(1);

    const upResult = handleHealthInput({ rawInput: "k", state: downResult.state });
    expect(upResult.state.pagerState.offset).toBe(0);
  });

  it("[q] in the pager returns to the main health view, not the parent scene", async () => {
    const state = baseStateWithFailingEntry();
    const opened = await runHealthSceneAction({
      action: { type: "view-recent-failures", index: 0, key: "worker:[\"codex\"]" },
      state,
    });
    const closed = handleHealthInput({ rawInput: "q", state: opened });
    expect(closed.handled).toBe(true);
    expect(closed.backToParent).toBe(false);
    expect(closed.state.view).toBe("main");
    expect(closed.state.pagerState).toBeNull();
    expect(closed.state.pagerEntryKey).toBe("");
  });

  it("[Esc] in the pager returns to the main health view, not the parent scene", async () => {
    const state = baseStateWithFailingEntry();
    const opened = await runHealthSceneAction({
      action: { type: "view-recent-failures", index: 0, key: "worker:[\"codex\"]" },
      state,
    });
    const closed = handleHealthInput({ rawInput: "\u001b", state: opened });
    expect(closed.handled).toBe(true);
    expect(closed.backToParent).toBe(false);
    expect(closed.state.view).toBe("main");
  });

  it("after closing the pager the main scene re-renders with Workers and Policy sections", async () => {
    const state = baseStateWithFailingEntry();
    const opened = await runHealthSceneAction({
      action: { type: "view-recent-failures", index: 0, key: "worker:[\"codex\"]" },
      state,
    });
    const closed = handleHealthInput({ rawInput: "q", state: opened });
    const rendered = renderHealthSceneLines({ state: closed.state }).map(stripAnsi);
    expect(rendered.some((line) => line.includes("Workers"))).toBe(true);
    expect(rendered.some((line) => line.includes("Policy"))).toBe(true);
    expect(rendered.some((line) => line.includes("[↵] view recent failures"))).toBe(true);
  });

  it("returns 'No entry selected.' when the action index is out of range", async () => {
    const state = baseStateWithFailingEntry();
    const next = await runHealthSceneAction({
      action: { type: "view-recent-failures", index: 99, key: "missing" },
      state,
    });
    expect(next.banner).toBe("No entry selected.");
    expect(next.view).toBe("main");
  });
});
