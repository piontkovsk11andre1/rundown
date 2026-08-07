import { describe, expect, it, vi } from "vitest";
import { createResetWorkerHealthEntry } from "../../src/application/reset-worker-health.js";
import {
  WORKER_HEALTH_STATUS_COOLING_DOWN,
  buildWorkerHealthWorkerKey,
} from "../../src/domain/worker-health.js";
import type {
  ApplicationOutputEvent,
  WorkerHealthSnapshot,
  WorkerHealthStore,
} from "../../src/domain/ports/index.js";

describe("reset-worker-health", () => {
  it("removes the matching entry through the port and reports removed=true in JSON", () => {
    const targetKey = buildWorkerHealthWorkerKey(["primary", "worker"]);
    const initial: WorkerHealthSnapshot = {
      schemaVersion: 1,
      updatedAt: "2026-04-12T09:59:00.000Z",
      entries: [
        {
          key: targetKey,
          source: "worker",
          status: WORKER_HEALTH_STATUS_COOLING_DOWN,
          cooldownUntil: "2026-04-12T10:05:00.000Z",
        },
      ],
    };

    const after: WorkerHealthSnapshot = {
      schemaVersion: 1,
      updatedAt: "2026-04-12T10:00:00.000Z",
      entries: [],
    };

    const events: ApplicationOutputEvent[] = [];
    const removeEntry = vi.fn(() => after);
    const store: WorkerHealthStore = {
      read: vi.fn(() => initial),
      write: vi.fn(),
      removeEntry,
      filePath: vi.fn(() => "/workspace/.rundown/worker-health.json"),
    };

    const resetWorkerHealthEntry = createResetWorkerHealthEntry({
      workerHealthStore: store,
      configDir: { configDir: "/workspace/.rundown", isExplicit: false },
      output: { emit: (event) => events.push(event) },
    });

    const code = resetWorkerHealthEntry({ key: targetKey, json: true });

    expect(code).toBe(0);
    expect(removeEntry).toHaveBeenCalledWith(targetKey, "/workspace/.rundown");
    const textEvent = events.find(
      (event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text",
    );
    expect(textEvent).toBeDefined();
    const payload = JSON.parse(textEvent?.text ?? "{}");
    expect(payload).toMatchObject({
      removedKey: targetKey,
      removed: true,
      filePath: "/workspace/.rundown/worker-health.json",
      configDir: "/workspace/.rundown",
      generatedAt: "2026-04-12T10:00:00.000Z",
    });
  });

  it("reports removed=false when the key is unknown but still succeeds (idempotent)", () => {
    const after: WorkerHealthSnapshot = {
      schemaVersion: 1,
      updatedAt: "2026-04-12T10:00:00.000Z",
      entries: [],
    };
    const events: ApplicationOutputEvent[] = [];
    const store: WorkerHealthStore = {
      read: vi.fn(() => ({ schemaVersion: 1, updatedAt: "x", entries: [] })),
      write: vi.fn(),
      removeEntry: vi.fn(() => after),
      filePath: vi.fn(() => "/workspace/.rundown/worker-health.json"),
    };

    const resetWorkerHealthEntry = createResetWorkerHealthEntry({
      workerHealthStore: store,
      configDir: { configDir: "/workspace/.rundown", isExplicit: false },
      output: { emit: (event) => events.push(event) },
    });

    const code = resetWorkerHealthEntry({ key: "worker:[\"missing\"]", json: true });

    expect(code).toBe(0);
    const textEvent = events.find(
      (event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text",
    );
    const payload = JSON.parse(textEvent?.text ?? "{}");
    expect(payload.removed).toBe(false);
    expect(payload.removedKey).toBe("worker:[\"missing\"]");
  });

  it("returns failure when the key is empty", () => {
    const events: ApplicationOutputEvent[] = [];
    const store: WorkerHealthStore = {
      read: vi.fn(),
      write: vi.fn(),
      removeEntry: vi.fn(),
      filePath: vi.fn(() => "/workspace/.rundown/worker-health.json"),
    };

    const resetWorkerHealthEntry = createResetWorkerHealthEntry({
      workerHealthStore: store,
      configDir: { configDir: "/workspace/.rundown", isExplicit: false },
      output: { emit: (event) => events.push(event) },
    });

    const code = resetWorkerHealthEntry({ key: "", json: true });

    expect(code).not.toBe(0);
    expect(store.removeEntry).not.toHaveBeenCalled();
  });

  it("returns failure when the store does not support removeEntry", () => {
    const events: ApplicationOutputEvent[] = [];
    const store: WorkerHealthStore = {
      read: vi.fn(() => ({ schemaVersion: 1, updatedAt: "x", entries: [] })),
      write: vi.fn(),
      filePath: vi.fn(() => "/workspace/.rundown/worker-health.json"),
    };

    const resetWorkerHealthEntry = createResetWorkerHealthEntry({
      workerHealthStore: store,
      configDir: { configDir: "/workspace/.rundown", isExplicit: false },
      output: { emit: (event) => events.push(event) },
    });

    const code = resetWorkerHealthEntry({ key: "worker:[\"x\"]", json: true });

    expect(code).not.toBe(0);
  });
});
