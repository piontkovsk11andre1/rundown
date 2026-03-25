import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFsArtifactStore } from "../../../src/infrastructure/adapters/fs-artifact-store.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createFsArtifactStore", () => {
  it("creates, finalizes, lists, finds, and removes saved runs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-store-"));
    tempDirs.push(cwd);

    const store = createFsArtifactStore();
    const context = store.createContext({ cwd, commandName: "run", keepArtifacts: true });

    const phase = store.beginPhase(context, { phase: "worker", prompt: "do work" });
    store.completePhase(phase, { exitCode: 0, stdout: "ok", stderr: "", outputCaptured: true });
    store.finalize(context, { status: "completed", preserve: true });

    expect(store.displayPath(context)).toMatch(/^\.rundown\/runs\/run-/);
    expect(store.rootDir(cwd)).toBe(path.join(cwd, ".rundown", "runs"));
    expect(store.latest(cwd)?.runId).toBe(context.runId);
    expect(store.find(context.runId, cwd)?.runId).toBe(context.runId);
    expect(store.listSaved(cwd)).toHaveLength(1);
    expect(store.listFailed(cwd)).toHaveLength(0);
    expect(store.isFailedStatus("failed")).toBe(true);
    expect(store.removeSaved(cwd)).toBe(1);
    expect(store.listSaved(cwd)).toHaveLength(0);
  });

  it("filters and removes failed runs", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-store-"));
    tempDirs.push(cwd);

    const store = createFsArtifactStore();
    const ok = store.createContext({ cwd, commandName: "run", keepArtifacts: true });
    store.finalize(ok, { status: "completed", preserve: true });

    const failed = store.createContext({ cwd, commandName: "run", keepArtifacts: true });
    store.finalize(failed, { status: "verification-failed", preserve: true });

    expect(store.listFailed(cwd).map((entry) => entry.runId)).toEqual([failed.runId]);
    expect(store.removeFailed(cwd)).toBe(1);
    expect(store.listSaved(cwd).map((entry) => entry.runId)).toEqual([ok.runId]);
  });
});
