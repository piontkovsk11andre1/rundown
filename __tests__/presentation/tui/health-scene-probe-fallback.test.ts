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

function baseStateWithEntry() {
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
        },
      ],
    },
    config: {},
    configPath: ".rundown/config.json",
    selectedIndex: 0,
  };
}

describe("health scene probe fallback", () => {
  it("[p] on a selected entry produces a probe-entry action", () => {
    const state = baseStateWithEntry();
    const result = handleHealthInput({ rawInput: "p", state });
    expect(result.handled).toBe(true);
    expect(result.action).toEqual({
      type: "probe-entry",
      index: 0,
      key: "worker:[\"opencode\"]",
    });
  });

  it("falls back to a `probe not yet supported` banner when bridge has no probeEntry", async () => {
    const state = baseStateWithEntry();
    const next = await runHealthSceneAction({
      action: { type: "probe-entry", index: 0, key: "worker:[\"opencode\"]" },
      state,
      bridges: { healthBridge: {} },
    });
    expect(next.banner).toBe("probe not yet supported");
    // Rest of the scene state remains intact.
    expect(next.healthStatus).toBe(state.healthStatus);
    expect(next.selectedIndex).toBe(state.selectedIndex);
    expect(next.config).toBe(state.config);
  });

  it("uses the bridge `reason` when probeEntry returns supported:false", async () => {
    const state = baseStateWithEntry();
    const next = await runHealthSceneAction({
      action: { type: "probe-entry", index: 0, key: "worker:[\"opencode\"]" },
      state,
      bridges: {
        healthBridge: {
          async probeEntry() {
            return { supported: false, reason: "probe API not yet implemented" };
          },
        },
      },
    });
    expect(next.banner).toBe("probe API not yet implemented");
    expect(next.healthStatus).toBe(state.healthStatus);
  });

  it("surfaces the bridge thrown error via a Probe failed banner without losing scene state", async () => {
    const state = baseStateWithEntry();
    const next = await runHealthSceneAction({
      action: { type: "probe-entry", index: 0, key: "worker:[\"opencode\"]" },
      state,
      bridges: {
        healthBridge: {
          async probeEntry() {
            throw new Error("kaboom");
          },
        },
      },
    });
    expect(next.banner).toBe("Probe failed: kaboom");
    expect(next.healthStatus).toBe(state.healthStatus);
    expect(next.selectedIndex).toBe(state.selectedIndex);
  });

  it("renders the rest of the scene (Workers, Policy, hint footer) after a probe fallback", async () => {
    const state = baseStateWithEntry();
    const next = await runHealthSceneAction({
      action: { type: "probe-entry", index: 0, key: "worker:[\"opencode\"]" },
      state,
      bridges: { healthBridge: {} },
    });
    const rendered = renderHealthSceneLines({ state: next }).map(stripAnsi);
    expect(rendered.some((line) => line.includes("Workers"))).toBe(true);
    expect(rendered.some((line) => line.includes("Policy"))).toBe(true);
    expect(
      rendered.some((line) =>
        line.includes("[r] reset entry") && line.includes("[p] probe now"),
      ),
    ).toBe(true);
    expect(rendered.some((line) => line.includes("probe not yet supported"))).toBe(true);
  });
});
