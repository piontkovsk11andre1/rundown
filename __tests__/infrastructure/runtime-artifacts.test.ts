import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  displayArtifactsPath,
  findSavedRuntimeArtifact,
  finalizeRuntimeArtifacts,
  isFailedRuntimeArtifactStatus,
  latestSavedRuntimeArtifact,
  listFailedRuntimeArtifacts,
  listSavedRuntimeArtifacts,
  removeFailedRuntimeArtifacts,
  removeSavedRuntimeArtifacts,
  runtimeArtifactsRootDir,
} from "../../src/infrastructure/runtime-artifacts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runtime-artifacts", () => {
  it("creates context, persists run metadata, records phase output, and removes non-preserved runs on finalize", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({
      cwd,
      commandName: "run",
      workerCommand: ["opencode", "run"],
      mode: "wait",
      transport: "file",
      source: "tasks.md",
      task: {
        text: "Build release",
        file: path.join(cwd, "tasks.md"),
        line: 3,
        index: 1,
        source: "tasks.md",
      },
    });

    const runJson = path.join(context.rootDir, "run.json");
    expect(fs.existsSync(runJson)).toBe(true);

    const phase = beginRuntimePhase(context, {
      phase: "verify",
      prompt: "verify this",
      command: ["opencode", "run"],
      mode: "wait",
      transport: "file",
      notes: "phase-start",
      extra: { attempt: 1 },
    });

    completeRuntimePhase(phase, {
      exitCode: 2,
      stdout: "not ok",
      stderr: "details",
      outputCaptured: true,
      notes: "phase-end",
      extra: { repaired: false },
    });

    const metadata = JSON.parse(fs.readFileSync(phase.metadataFile, "utf-8")) as {
      promptFile: string | null;
      stdoutFile: string | null;
      stderrFile: string | null;
      exitCode: number | null;
      notes?: string;
      extra?: Record<string, unknown>;
      completedAt?: string;
    };

    expect(metadata.promptFile).toBe("prompt.md");
    expect(metadata.stdoutFile).toBe("stdout.log");
    expect(metadata.stderrFile).toBe("stderr.log");
    expect(metadata.exitCode).toBe(2);
    expect(metadata.notes).toBe("phase-end");
    expect(metadata.extra).toEqual({ attempt: 1, repaired: false });
    expect(typeof metadata.completedAt).toBe("string");
    expect(fs.readFileSync(path.join(phase.dir, "prompt.md"), "utf-8")).toBe("verify this");
    expect(fs.readFileSync(path.join(phase.dir, "stdout.log"), "utf-8")).toBe("not ok");
    expect(fs.readFileSync(path.join(phase.dir, "stderr.log"), "utf-8")).toBe("details");

    finalizeRuntimeArtifacts(context, { status: "verification-failed", preserve: false });
    expect(fs.existsSync(context.rootDir)).toBe(false);
  });

  it("keeps preserved runs and lists metadata including failed-only view", () => {
    const cwd = createWorkspace();
    const first = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });
    finalizeRuntimeArtifacts(first, { status: "completed", preserve: true });

    const second = createRuntimeArtifactsContext({ cwd, commandName: "reverify", keepArtifacts: true });
    finalizeRuntimeArtifacts(second, { status: "reverify-failed", preserve: true });

    const saved = listSavedRuntimeArtifacts(cwd);
    const failed = listFailedRuntimeArtifacts(cwd);

    expect(saved).toHaveLength(2);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.runId).toBe(second.runId);
    expect(latestSavedRuntimeArtifact(cwd)?.runId).toBe(second.runId);
    expect(isFailedRuntimeArtifactStatus("reverify-failed")).toBe(true);
    expect(isFailedRuntimeArtifactStatus("completed")).toBe(false);
    expect(isFailedRuntimeArtifactStatus(undefined)).toBe(false);
  });

  it("handles directories with missing metadata and supports prefix lookup", () => {
    const cwd = createWorkspace();
    const root = runtimeArtifactsRootDir(cwd);
    fs.mkdirSync(root, { recursive: true });

    const missingDir = path.join(root, "run-missing");
    fs.mkdirSync(missingDir, { recursive: true });

    const valid = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });
    finalizeRuntimeArtifacts(valid, { status: "completed", preserve: true });

    const saved = listSavedRuntimeArtifacts(cwd);
    const missing = saved.find((entry) => entry.runId === "run-missing");

    expect(missing?.status).toBe("metadata-missing");
    expect(missing?.commandName).toBe("unknown");
    expect(findSavedRuntimeArtifact(valid.runId, cwd)?.runId).toBe(valid.runId);
    expect(findSavedRuntimeArtifact(valid.runId.slice(0, 12), cwd)?.runId).toBe(valid.runId);
    expect(findSavedRuntimeArtifact("run-", cwd)).toBeNull();
  });

  it("removes failed runs separately from saved runs", () => {
    const cwd = createWorkspace();
    const completed = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });
    finalizeRuntimeArtifacts(completed, { status: "completed", preserve: true });

    const failed = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });
    finalizeRuntimeArtifacts(failed, { status: "failed", preserve: true });

    expect(removeFailedRuntimeArtifacts(cwd)).toBe(1);
    expect(listSavedRuntimeArtifacts(cwd).map((entry) => entry.runId)).toEqual([completed.runId]);
    expect(removeSavedRuntimeArtifacts(cwd)).toBe(1);
    expect(listSavedRuntimeArtifacts(cwd)).toHaveLength(0);
  });

  it("recreates preserved metadata when root directory was deleted before finalize", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "plan", keepArtifacts: true });

    fs.rmSync(context.rootDir, { recursive: true, force: true });
    finalizeRuntimeArtifacts(context, { status: "completed", preserve: true });

    const runJson = path.join(context.rootDir, "run.json");
    expect(fs.existsSync(runJson)).toBe(true);
    const metadata = JSON.parse(fs.readFileSync(runJson, "utf-8")) as { status?: string };
    expect(metadata.status).toBe("completed");
  });

  it("returns display path relative to cwd", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    expect(displayArtifactsPath(context)).toMatch(/^\.rundown\/runs\/run-/);
  });
});

function createWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-artifacts-"));
  tempDirs.push(workspace);
  return workspace;
}
