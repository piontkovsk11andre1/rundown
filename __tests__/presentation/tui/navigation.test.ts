import { describe, expect, it, vi } from "vitest";

const releaseAppMock = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../../src/presentation/tui/output-bridge.ts", async () => {
  const actual = await vi.importActual<typeof import("../../../src/presentation/tui/output-bridge.ts")>(
    "../../../src/presentation/tui/output-bridge.ts",
  );
  return {
    ...actual,
    releaseApp: releaseAppMock,
  };
});

import { createTuiHarness } from "./harness.ts";

describe("tui navigation integration", () => {
  it("navigates main -> Workers -> Health -> Esc -> Workers -> Esc -> main", async () => {
    const harness = await createTuiHarness();

    expect(harness.sceneStack()).toEqual(["mainMenu"]);
    expect(harness.frame()).toContain("Main Menu:");

    await harness.press(["3", "enter"]);
    expect(harness.sceneStack()).toEqual(["mainMenu", "workers"]);
    expect(harness.frame()).toContain("Workers");

    const healthHarness = await createTuiHarness({ initialScene: "health" });
    expect(healthHarness.sceneStack()).toEqual(["mainMenu", "workers", "health"]);
    expect(healthHarness.frame()).toContain("Health");

    await healthHarness.press("esc");
    expect(healthHarness.sceneStack()).toEqual(["mainMenu", "workers"]);
    expect(healthHarness.frame()).toContain("Workers");

    await healthHarness.press("esc");
    expect(healthHarness.sceneStack()).toEqual(["mainMenu"]);
    expect(healthHarness.frame()).toContain("Main Menu:");
  });

  it("returns from nested stacks predictably at arbitrary depth", async () => {
    const harness = await createTuiHarness({ initialScene: "health" });

    expect(harness.sceneStack()).toEqual(["mainMenu", "workers", "health"]);

    await harness.press("esc");
    expect(harness.sceneStack()).toEqual(["mainMenu", "workers"]);

    await harness.press("T");
    expect(harness.sceneStack()).toEqual(["mainMenu", "workers", "tools"]);
    expect(harness.frame()).toContain("Tools");

    await harness.press("esc");
    expect(harness.sceneStack()).toEqual(["mainMenu", "workers"]);

    await harness.press("esc");
    expect(harness.sceneStack()).toEqual(["mainMenu"]);
    expect(harness.frame()).toContain("Main Menu:");

    await harness.press("esc");
    expect(harness.sceneStack()).toEqual(["mainMenu"]);
  });

  it("quits from every scene", async () => {
    const scenes = [
      "mainMenu",
      "continue",
      "newWork",
      "workers",
      "profiles",
      "settings",
      "help",
      "tools",
      "health",
    ] as const;

    for (const scene of scenes) {
      const harness = await createTuiHarness({ initialScene: scene });
      const callCountBefore = releaseAppMock.mock.calls.length;
      await harness.press("q");
      expect(releaseAppMock.mock.calls.length).toBe(callCountBefore + 1);
      expect(harness.sceneStack().length).toBeGreaterThan(0);
    }
  });
});
