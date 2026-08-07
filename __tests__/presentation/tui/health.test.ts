import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTuiHarness } from "./harness.ts";
import { createApp } from "../../../src/create-app.js";

const healthMockState = vi.hoisted(() => ({
  entries: [] as Array<Record<string, unknown>>,
  filePath: "",
  configDir: "",
  generatedAt: "2026-05-03T11:06:52.274Z",
  resetCalls: [] as string[],
}));

vi.mock("../../../src/create-app.js", () => ({
  createApp: vi.fn((options?: { ports?: { output?: { emit?: (event: unknown) => void } } }) => {
    const emit = options?.ports?.output?.emit;
    return {
      configList: vi.fn(async () => {
        emit?.({
          kind: "text",
          text: JSON.stringify({
            config: {
              workers: {
                default: ["opencode", "run", "--model", "gpt-5"],
              },
              healthPolicy: {
                unavailableReevaluation: {
                  mode: "manual",
                },
              },
            },
          }),
        });
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
      viewWorkerHealthStatus: vi.fn(async () => {
        emit?.({
          kind: "text",
          text: JSON.stringify({
            generatedAt: healthMockState.generatedAt,
            filePath: healthMockState.filePath,
            configDir: healthMockState.configDir,
            entries: healthMockState.entries,
          }),
        });
        return 0;
      }),
      resetWorkerHealthEntry: vi.fn(async ({ key }: { key: string }) => {
        healthMockState.resetCalls.push(key);
        healthMockState.entries = healthMockState.entries.filter((entry) => entry.key !== key);
        emit?.({
          kind: "text",
          text: JSON.stringify({
            removedKey: key,
            removed: true,
            filePath: healthMockState.filePath,
            configDir: healthMockState.configDir,
            generatedAt: healthMockState.generatedAt,
          }),
        });
        return 0;
      }),
      releaseAllLocks: vi.fn(),
      awaitShutdown: vi.fn(async () => {}),
    };
  }),
}));

describe("tui health integration", () => {
  beforeEach(() => {
    healthMockState.entries = [];
    healthMockState.filePath = "";
    healthMockState.configDir = "";
    healthMockState.generatedAt = "2026-05-03T11:06:52.274Z";
    healthMockState.resetCalls.length = 0;
    vi.clearAllMocks();
  });

  it("renders health entries", async () => {
    healthMockState.entries = [
      {
        source: "worker",
        key: "worker:[\"opencode\",\"run\",\"--model\",\"gpt-5\"]",
        identity: "opencode run --model gpt-5",
        status: "ready",
      },
    ];

    const harness = await createTuiHarness({ initialScene: "health" });
    const frame = harness.frame();

    expect(frame).toContain("Health");
    expect(frame).toContain("Workers");
    expect(frame).toContain("default");
    expect(frame).toContain("opencode run --model gpt-5");
    expect(frame).toContain("ready");
    expect(frame).toContain("[↵] view recent failures   [r] reset entry   [p] probe now");
    expect(createApp).toHaveBeenCalled();
  });

  it("resets selected entry on [r]", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "tui-health-reset-"));
    try {
      const configDir = path.join(tmpRoot, ".rundown");
      mkdirSync(configDir, { recursive: true });
      const filePath = path.join(configDir, "worker-health.json");
      writeFileSync(filePath, JSON.stringify({ entries: [] }), "utf8");

      healthMockState.configDir = configDir;
      healthMockState.filePath = filePath;
      healthMockState.entries = [
        {
          source: "worker",
          key: "worker:[\"opencode\",\"run\",\"--model\",\"gpt-5\"]",
          identity: "opencode run --model gpt-5",
          status: "ready",
        },
      ];

      const harness = await createTuiHarness({ initialScene: "health" });
      expect(harness.frame()).toContain("opencode run --model gpt-5");

      await harness.press("r");

      expect(healthMockState.resetCalls).toHaveLength(1);
      expect(harness.frame()).toContain("No worker-health entries recorded.");
      expect(harness.frame()).toContain(`Snapshot: ${filePath}`);
      expect(harness.frame()).not.toContain("opencode run --model gpt-5");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("renders gracefully when worker-health file exists but has no entries", async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "tui-health-empty-"));
    try {
      const configDir = path.join(tmpRoot, ".rundown");
      mkdirSync(configDir, { recursive: true });
      const filePath = path.join(configDir, "worker-health.json");
      writeFileSync(filePath, JSON.stringify({ schemaVersion: 1, entries: [] }), "utf8");

      healthMockState.configDir = configDir;
      healthMockState.filePath = filePath;
      healthMockState.entries = [];

      const harness = await createTuiHarness({ initialScene: "health" });
      const frame = harness.frame();

      expect(frame).toContain("Health");
      expect(frame).toContain("Workers");
      expect(frame).toContain("No worker-health entries recorded.");
      expect(frame).toContain(`Snapshot: ${filePath}`);
      expect(frame).toContain("[e] edit healthPolicy in config.json");
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
