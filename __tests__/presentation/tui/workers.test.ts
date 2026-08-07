import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTuiHarness } from "./harness.ts";
import { createApp } from "../../../src/create-app.js";
import { handleWorkersInput } from "../../../src/presentation/tui/scenes/workers.ts";

const workersMockData = vi.hoisted(() => ({
  defaultWorker: ["opencode", "run", "--model", "gpt-5"],
  tuiWorker: ["opencode", "run", "--model", "gpt-5-mini"],
  fallbackWorker: ["opencode", "run", "--model", "gpt-4.1-mini"],
  toolWorker: ["opencode", "run", "--model", "gpt-5.3-mini", "--no-approval"],
}));

function workerKey(tokens: string[]): string {
  return `worker:${JSON.stringify(tokens)}`;
}

describe("tui workers integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders pool, per-command overrides, routing summary, and health states", async () => {
    const harness = await createTuiHarness({
      initialScene: "workers",
    });

    expect(harness.frame()).toMatchSnapshot();
    expect(createApp).toHaveBeenCalled();
  });

  it("maps [H] to open-health and Esc from Health returns to Workers", async () => {
    const inputResult = handleWorkersInput({ rawInput: "H" });
    expect(inputResult.action?.type).toBe("open-health");

    const harness = await createTuiHarness({
      initialScene: "health",
    });

    expect(harness.sceneStack()).toEqual(["mainMenu", "workers", "health"]);
    expect(harness.frame()).toContain("Health");
    expect(harness.frame()).toContain("Policy");

    await harness.press("esc");

    expect(harness.sceneStack()).toEqual(["mainMenu", "workers"]);
    expect(harness.frame()).toContain("Workers");
    expect(harness.frame()).toContain("[Esc] Back to menu");
  });
});

vi.mock("../../../src/create-app.js", () => ({
  createApp: vi.fn((options?: { ports?: { output?: { emit?: (event: unknown) => void } } }) => {
    const emit = options?.ports?.output?.emit;
    const { defaultWorker, tuiWorker, fallbackWorker, toolWorker } = workersMockData;
    return {
      configList: vi.fn(async (args?: { scope?: string; showSource?: boolean }) => {
        if (args?.scope === "effective" && args?.showSource === false) {
          emit?.({
            kind: "text",
            text: JSON.stringify({
              config: {
                workers: {
                  default: defaultWorker,
                  tui: tuiWorker,
                  fallbacks: [fallbackWorker],
                },
                workerTimeoutMs: 45000,
                commands: {
                  run: defaultWorker,
                  verify: fallbackWorker,
                  "tools.post-on-gitea": toolWorker,
                },
                run: {
                  workerRouting: {
                    repair: {
                      attempts: [{ worker: defaultWorker }, { worker: fallbackWorker }],
                    },
                    resolveRepair: {
                      attempts: [{ worker: tuiWorker }],
                    },
                  },
                },
              },
            }),
          });
        } else {
          emit?.({ kind: "text", text: JSON.stringify({ config: {} }) });
        }
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
            generatedAt: "2026-05-03T11:06:52.274Z",
            filePath: "C:\\Work\\md-todo\\.rundown\\worker-health.json",
            configDir: "C:\\Work\\md-todo\\.rundown",
            entries: [
              {
                source: "worker",
                key: workerKey(defaultWorker),
                identity: defaultWorker.join(" "),
                status: "ready",
              },
              {
                source: "worker",
                key: workerKey(tuiWorker),
                identity: tuiWorker.join(" "),
                status: "cooling_down",
                cooldownUntil: "2026-05-03T11:30:00.000Z",
                lastFailureClass: "usage_limit",
              },
              {
                source: "worker",
                key: workerKey(fallbackWorker),
                identity: fallbackWorker.join(" "),
                status: "unavailable",
              },
              {
                source: "worker",
                key: workerKey(toolWorker),
                identity: toolWorker.join(" "),
                status: "ready",
              },
            ],
          }),
        });
        return 0;
      }),
      releaseAllLocks: vi.fn(),
      awaitShutdown: vi.fn(async () => {}),
    };
  }),
}));
