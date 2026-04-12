import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsWorkerHealthStore } from "../../src/infrastructure/adapters/fs-worker-health-store.js";
import {
  readWorkerHealthSnapshot,
  workerHealthStoreFilePath,
  writeWorkerHealthSnapshot,
} from "../../src/infrastructure/worker-health-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("worker health store", () => {
  it("resolves store file paths for cwd and explicit config dir", () => {
    const cwd = createWorkspace();
    const configDir = path.join(cwd, ".rundown");

    expect(workerHealthStoreFilePath(cwd)).toBe(path.join(cwd, ".rundown", "worker-health.json"));
    expect(workerHealthStoreFilePath(configDir)).toBe(path.join(configDir, "worker-health.json"));
  });

  it("returns an empty snapshot when the store file is missing", () => {
    const cwd = createWorkspace();

    const snapshot = readWorkerHealthSnapshot(cwd);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.entries).toEqual([]);
    expect(Number.isFinite(Date.parse(snapshot.updatedAt))).toBe(true);
  });

  it("writes and reads a normalized snapshot with schema version", () => {
    const cwd = createWorkspace();

    writeWorkerHealthSnapshot({
      schemaVersion: 999,
      updatedAt: "invalid-date",
      entries: [
        {
          key: " worker:primary ",
          status: "cooling_down",
          source: "worker",
          lastFailureClass: "usage_limit",
          cooldownUntil: "2026-04-12T10:00:00.000Z",
          failureCountWindow: 2,
        },
      ],
    }, cwd);

    const filePath = workerHealthStoreFilePath(cwd);
    const persisted = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      schemaVersion: number;
      updatedAt: string;
      entries: Array<{ key: string }>;
    };

    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.entries[0]?.key).toBe("worker:primary");
    expect(Number.isFinite(Date.parse(persisted.updatedAt))).toBe(true);

    const loaded = readWorkerHealthSnapshot(cwd);
    expect(loaded).toEqual(persisted);
  });

  it("treats corrupt JSON and unsupported schema as empty snapshots", () => {
    const cwd = createWorkspace();
    const filePath = workerHealthStoreFilePath(cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    fs.writeFileSync(filePath, "{broken", "utf-8");
    expect(readWorkerHealthSnapshot(cwd).entries).toEqual([]);

    fs.writeFileSync(filePath, JSON.stringify({ schemaVersion: 2, entries: [] }), "utf-8");
    expect(readWorkerHealthSnapshot(cwd).entries).toEqual([]);
  });

  it("filters invalid entries during tolerant reads", () => {
    const cwd = createWorkspace();
    const filePath = workerHealthStoreFilePath(cwd);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({
      schemaVersion: 1,
      updatedAt: "2026-04-12T09:21:36.000Z",
      entries: [
        {
          key: "worker:ok",
          status: "healthy",
          source: "worker",
          lastFailureClass: "execution_failure_other",
        },
        {
          key: "",
          status: "healthy",
          source: "worker",
        },
        {
          key: "profile:bad",
          status: "unknown",
          source: "profile",
        },
      ],
    }), "utf-8");

    const loaded = readWorkerHealthSnapshot(cwd);
    expect(loaded.entries).toEqual([
      {
        key: "worker:ok",
        status: "healthy",
        source: "worker",
        lastFailureClass: "execution_failure_other",
      },
    ]);
  });

  it("writes atomically without leaving temporary files", () => {
    const cwd = createWorkspace();

    writeWorkerHealthSnapshot({
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      entries: [],
    }, cwd);

    const configDir = path.join(cwd, ".rundown");
    const files = fs.readdirSync(configDir);
    expect(files).toContain("worker-health.json");
    expect(files.some((file) => file.includes("worker-health.json.tmp-"))).toBe(false);
  });
});

describe("createFsWorkerHealthStore", () => {
  it("adapts read/write/filePath operations", () => {
    const cwd = createWorkspace();
    const store = createFsWorkerHealthStore();

    store.write({
      schemaVersion: 1,
      updatedAt: "2026-04-12T10:15:00.000Z",
      entries: [
        {
          key: "profile:fast",
          status: "unavailable",
          source: "profile",
          lastFailureClass: "transport_unavailable",
          lastFailureAt: "2026-04-12T10:14:00.000Z",
        },
      ],
    }, cwd);

    const loaded = store.read(cwd);
    expect(loaded.entries).toEqual([
      {
        key: "profile:fast",
        status: "unavailable",
        source: "profile",
        lastFailureClass: "transport_unavailable",
        lastFailureAt: "2026-04-12T10:14:00.000Z",
      },
    ]);
    expect(store.filePath(cwd)).toBe(path.join(cwd, ".rundown", "worker-health.json"));
  });
});

function createWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-health-"));
  tempDirs.push(workspace);
  return workspace;
}
