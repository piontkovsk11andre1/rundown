import { describe, expect, it, vi } from "vitest";
import { createStartProbe, createWorkersProbe } from "../../../src/presentation/tui/status-probes.ts";

describe("status probes", () => {
  it("returns bootstrap copy for Start", async () => {
    const probe = createStartProbe();

    await expect(probe()).resolves.toEqual({
      text: "scaffold design/ + migrations/",
      tone: "muted",
    });
  });

  it("returns warning for Workers when workspace is not configured", async () => {
    const appFactory = vi.fn(() => {
      throw new Error("workers app probe should not run for unconfigured workspace");
    });

    const probe = createWorkersProbe({
      appFactory,
      detectWorkspaceState: () => ({ isEmptyBootstrap: true, hasWorkersConfigured: false }),
    });

    await expect(probe()).resolves.toEqual({
      text: "no workers configured yet",
      tone: "warn",
    });
    expect(appFactory).not.toHaveBeenCalled();
  });
});
