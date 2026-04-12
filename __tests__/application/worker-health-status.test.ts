import { afterEach, describe, expect, it, vi } from "vitest";
import { createViewWorkerHealthStatus } from "../../src/application/worker-health-status.js";
import {
  WORKER_HEALTH_STATUS_COOLING_DOWN,
  WORKER_HEALTH_STATUS_UNAVAILABLE,
  buildWorkerHealthWorkerKey,
} from "../../src/domain/worker-health.js";
import type {
  ApplicationOutputEvent,
  WorkerHealthSnapshot,
  WorkerHealthStore,
} from "../../src/domain/ports/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("worker-health-status", () => {
  it("prints machine-readable JSON health status with fallback snapshots", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-12T10:00:00.000Z"));

    const { viewWorkerHealthStatus, events } = createDependencies({
      snapshot: {
        schemaVersion: 1,
        updatedAt: "2026-04-12T09:59:00.000Z",
        entries: [
          {
            key: buildWorkerHealthWorkerKey(["primary", "worker"]),
            source: "worker",
            status: WORKER_HEALTH_STATUS_COOLING_DOWN,
            cooldownUntil: "2026-04-12T10:05:00.000Z",
            lastFailureClass: "usage_limit",
            lastFailureAt: "2026-04-12T09:58:00.000Z",
          },
          {
            key: buildWorkerHealthWorkerKey(["fallback", "one"]),
            source: "worker",
            status: WORKER_HEALTH_STATUS_UNAVAILABLE,
            lastFailureClass: "transport_unavailable",
          },
        ],
      },
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [
            ["fallback", "one"],
            ["fallback", "two"],
          ],
        },
      },
    });

    const code = viewWorkerHealthStatus({ json: true });

    expect(code).toBe(0);
    const textEvent = events.find((event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text");
    expect(textEvent).toBeDefined();
    const payload = JSON.parse(textEvent?.text ?? "{}");

    expect(payload.filePath).toBe("/workspace/.rundown/worker-health.json");
    expect(payload.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "worker",
        identity: "primary worker",
        status: "cooling_down",
        eligible: false,
        cooldownUntil: "2026-04-12T10:05:00.000Z",
        cooldownRemainingSeconds: 300,
      }),
      expect.objectContaining({
        source: "worker",
        identity: "fallback one",
        status: "unavailable",
        eligible: false,
      }),
    ]));

    const runSnapshot = (payload.fallbackOrderSnapshots as Array<Record<string, unknown>>)
      .find((entry) => entry.commandName === "run");
    expect(runSnapshot).toBeDefined();
    expect(runSnapshot?.["selectedWorkerLabel"]).toBe("fallback two");
  });

  it("prints human-readable status output", () => {
    const { viewWorkerHealthStatus, events } = createDependencies({
      snapshot: {
        schemaVersion: 1,
        updatedAt: "2026-04-12T09:59:00.000Z",
        entries: [
          {
            key: buildWorkerHealthWorkerKey(["primary", "worker"]),
            source: "worker",
            status: WORKER_HEALTH_STATUS_COOLING_DOWN,
            cooldownUntil: "2026-04-12T10:05:00.000Z",
          },
        ],
      },
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [["fallback", "one"]],
        },
      },
    });

    const code = viewWorkerHealthStatus({ json: false });

    expect(code).toBe(0);
    const lines = events
      .filter((event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text")
      .map((event) => event.text);
    expect(lines).toContain("Worker health status");
    expect(lines).toContain("Entries");
    expect(lines.some((line) => line.includes("primary worker | status=cooling_down"))).toBe(true);
    expect(lines).toContain("Fallback order snapshots");
    expect(lines.some((line) => line.includes("[fallback#1] fallback one"))).toBe(true);
  });
});

function createDependencies(options: {
  snapshot: WorkerHealthSnapshot;
  workerConfig: {
    workers?: {
      default?: string[];
      fallbacks?: string[][];
    };
  };
}): {
  viewWorkerHealthStatus: ReturnType<typeof createViewWorkerHealthStatus>;
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];
  const workerHealthStore: WorkerHealthStore = {
    read: vi.fn(() => options.snapshot),
    write: vi.fn(),
    filePath: vi.fn(() => "/workspace/.rundown/worker-health.json"),
  };

  const viewWorkerHealthStatus = createViewWorkerHealthStatus({
    workerHealthStore,
    workerConfigPort: {
      load: vi.fn(() => options.workerConfig),
    },
    configDir: {
      configDir: "/workspace/.rundown",
      isExplicit: false,
    },
    output: {
      emit: (event) => events.push(event),
    },
  });

  return {
    viewWorkerHealthStatus,
    events,
  };
}
