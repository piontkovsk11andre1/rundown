import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTuiHarness } from "./harness.ts";

vi.mock("../../../src/create-app.js", () => ({
  createApp: vi.fn((options?: { ports?: { output?: { emit?: (event: unknown) => void } } }) => {
    const emit = options?.ports?.output?.emit;
    return {
      configList: vi.fn(async (args?: { scope?: string; showSource?: boolean }) => {
        if (args?.scope === "effective" && args?.showSource === true) {
          emit?.({
            kind: "text",
            text: JSON.stringify({
              config: {
                alpha: 1,
                beta: true,
              },
              sources: {
                alpha: "local",
                beta: "global",
              },
            }),
          });
          return 0;
        }

        if (args?.scope === "local") {
          emit?.({ kind: "text", text: JSON.stringify({ config: { alpha: 1 } }) });
          return 0;
        }

        if (args?.scope === "global") {
          emit?.({ kind: "text", text: JSON.stringify({ config: { beta: true } }) });
          return 0;
        }

        emit?.({ kind: "text", text: JSON.stringify({ config: {} }) });
        return 0;
      }),
      configPath: vi.fn(async (args?: { scope?: string }) => {
        if (args?.scope === "global") {
          emit?.({ kind: "text", text: JSON.stringify({ path: "C:\\Users\\test\\.rundown\\config.json" }) });
        } else {
          emit?.({ kind: "text", text: JSON.stringify({ path: "C:\\Work\\md-todo\\.rundown\\config.json" }) });
        }
        return 0;
      }),
      releaseAllLocks: vi.fn(),
      awaitShutdown: vi.fn(async () => {}),
    };
  }),
}));

describe("tui settings integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cycles scope effective -> local -> global -> effective", async () => {
    const harness = await createTuiHarness({ initialScene: "settings" });

    expect(harness.frame()).toMatchSnapshot();

    await harness.press("s");
    expect(harness.frame()).toContain("scope: local");
    expect(harness.frame()).not.toContain("provenance shown");
    expect(harness.frame()).not.toContain("◀ local");
    expect(harness.frame()).not.toContain("◀ global");

    await harness.press("s");
    expect(harness.frame()).toContain("scope: global");
    expect(harness.frame()).not.toContain("provenance shown");
    expect(harness.frame()).not.toContain("◀ local");
    expect(harness.frame()).not.toContain("◀ global");

    await harness.press("s");
    expect(harness.frame()).toContain("scope: effective");
    expect(harness.frame()).toContain("provenance shown");
    expect(harness.frame()).toContain("◀ global");
  });

  it("blocks [e] when scope is effective", async () => {
    const harness = await createTuiHarness({ initialScene: "settings" });

    await harness.press("e");

    expect(harness.frame()).toContain("scope: effective");
    expect(harness.frame()).toContain("effective is a merged read-only view; switch to local or global to edit.");
  });
});
