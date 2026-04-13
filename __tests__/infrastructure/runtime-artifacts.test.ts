import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  scanRuntimeArtifactPhases,
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
      verificationResult: "schema mismatch on metadata.version",
      outputCaptured: true,
      notes: "phase-end",
      extra: { repaired: false },
    });

    const metadata = JSON.parse(fs.readFileSync(phase.metadataFile, "utf-8")) as {
      promptFile: string | null;
      stdoutFile: string | null;
      stderrFile: string | null;
      verificationResult?: string;
      exitCode: number | null;
      notes?: string;
      extra?: Record<string, unknown>;
      completedAt?: string;
    };

    expect(metadata.promptFile).toBe("prompt.md");
    expect(metadata.stdoutFile).toBe("stdout.log");
    expect(metadata.stderrFile).toBe("stderr.log");
    expect(metadata.verificationResult).toBe("schema mismatch on metadata.version");
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

  it("returns null or zero for empty artifact stores", () => {
    const cwd = createWorkspace();

    expect(latestSavedRuntimeArtifact(cwd)).toBeNull();
    expect(removeFailedRuntimeArtifacts(cwd)).toBe(0);
    expect(removeSavedRuntimeArtifacts(cwd)).toBe(0);
  });

  it("records phases without prompt or captured output files", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    const phase = beginRuntimePhase(context, {
      phase: "worker",
      command: ["node", "worker.js"],
      mode: "wait",
      transport: "arg",
    });

    completeRuntimePhase(phase, {
      exitCode: 0,
      outputCaptured: false,
    });

    const metadata = JSON.parse(fs.readFileSync(phase.metadataFile, "utf-8")) as {
      promptFile: string | null;
      stdoutFile: string | null;
      stderrFile: string | null;
      completedAt?: string;
    };

    expect(metadata.promptFile).toBeNull();
    expect(metadata.stdoutFile).toBeNull();
    expect(metadata.stderrFile).toBeNull();
    expect(typeof metadata.completedAt).toBe("string");
    expect(fs.existsSync(path.join(phase.dir, "prompt.md"))).toBe(false);
    expect(fs.existsSync(path.join(phase.dir, "stdout.log"))).toBe(false);
    expect(fs.existsSync(path.join(phase.dir, "stderr.log"))).toBe(false);
  });

  it("sanitizes captured stdout/stderr logs for deterministic artifacts", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    const phase = beginRuntimePhase(context, {
      phase: "execute",
      command: ["node", "worker.js"],
      mode: "wait",
      transport: "arg",
    });

    completeRuntimePhase(phase, {
      exitCode: 1,
      stdout: "step 1\rstep 2\u0007\nline\u001b[32m ok\u001b[0m",
      stderr: "warn\r\nerr\u0008or",
      outputCaptured: true,
    });

    expect(fs.readFileSync(path.join(phase.dir, "stdout.log"), "utf-8")).toBe("step 2\nline ok");
    expect(fs.readFileSync(path.join(phase.dir, "stderr.log"), "utf-8")).toBe("warn\nerror");
  });

  it("supports scan-style phase labels in directory names and metadata", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "plan", keepArtifacts: true });

    const phase = beginRuntimePhase(context, {
      phase: "plan",
      phaseLabel: "plan-scan-01",
      command: ["opencode", "run"],
      mode: "wait",
      transport: "arg",
    });

    completeRuntimePhase(phase, {
      exitCode: 0,
      outputCaptured: false,
    });

    expect(path.basename(phase.dir)).toBe("01-plan-scan-01");
    const metadata = JSON.parse(fs.readFileSync(phase.metadataFile, "utf-8")) as {
      phase: string;
      phaseLabel?: string;
    };
    expect(metadata.phase).toBe("plan");
    expect(metadata.phaseLabel).toBe("plan-scan-01");
  });

  it("returns early when finalizing a deleted non-preserved run", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: false });

    fs.rmSync(context.rootDir, { recursive: true, force: true });

    expect(() => finalizeRuntimeArtifacts(context, { status: "completed", preserve: false })).not.toThrow();
    expect(fs.existsSync(context.rootDir)).toBe(false);
  });

  it("retries finalization after an ENOENT write error when preserving artifacts", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "reverify", keepArtifacts: true });
    const originalWriteFileSync = fs.writeFileSync;
    let threwEnoent = false;

    vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
      if (!threwEnoent && typeof filePath === "string" && filePath.endsWith("run.json")) {
        threwEnoent = true;
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }

      return originalWriteFileSync(filePath, data as string, "utf-8");
    }) as typeof fs.writeFileSync);

    finalizeRuntimeArtifacts(context, { status: "reverify-completed", preserve: true });

    const metadata = JSON.parse(fs.readFileSync(path.join(context.rootDir, "run.json"), "utf-8")) as {
      status?: string;
    };
    expect(metadata.status).toBe("reverify-completed");
  });

  it("returns when ENOENT happens during non-preserved finalization", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: false });
    const originalWriteFileSync = fs.writeFileSync;
    let threwEnoent = false;

    vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
      if (!threwEnoent && typeof filePath === "string" && filePath.endsWith("run.json")) {
        threwEnoent = true;
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      }

      return originalWriteFileSync(filePath, data as string, "utf-8");
    }) as typeof fs.writeFileSync);

    expect(() => finalizeRuntimeArtifacts(context, { status: "completed", preserve: false })).not.toThrow();
    expect(fs.existsSync(context.rootDir)).toBe(true);
  });

  it("rethrows non-ENOENT finalization write errors", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });
    const originalWriteFileSync = fs.writeFileSync;
    let threwGeneric = false;

    vi.spyOn(fs, "writeFileSync").mockImplementation(((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView) => {
      if (!threwGeneric && typeof filePath === "string" && filePath.endsWith("run.json")) {
        threwGeneric = true;
        throw new Error("disk full");
      }

      return originalWriteFileSync(filePath, data as string, "utf-8");
    }) as typeof fs.writeFileSync);

    expect(() => finalizeRuntimeArtifacts(context, { status: "completed", preserve: true })).toThrow("disk full");
  });

  it("returns display path relative to cwd", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    expect(displayArtifactsPath(context)).toMatch(/^\.rundown\/runs\/run-/);
  });

  it("falls back to the run directory name when display path is relative to itself", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    expect(displayArtifactsPath({ ...context, cwd: context.rootDir })).toBe(path.basename(context.rootDir));
  });

  it("scans and categorizes execute/verify/repair phases with artifact presence", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    const executePhase = beginRuntimePhase(context, {
      phase: "execute",
      phaseLabel: "execute-main",
      prompt: "execute prompt",
    });
    completeRuntimePhase(executePhase, {
      exitCode: 0,
      stdout: "execution output",
      outputCaptured: true,
    });

    const verifyPhase = beginRuntimePhase(context, {
      phase: "verify",
      phaseLabel: "verify-01",
      prompt: "verify prompt",
    });
    completeRuntimePhase(verifyPhase, {
      exitCode: 1,
      stderr: "verification failed",
      verificationResult: "NOT_OK: mismatch",
      outputCaptured: true,
    });

    const repairPhase = beginRuntimePhase(context, {
      phase: "repair",
      phaseLabel: "repair-01",
    });
    completeRuntimePhase(repairPhase, {
      exitCode: 0,
      outputCaptured: false,
    });

    const scanned = scanRuntimeArtifactPhases(context.rootDir);

    expect(scanned.execute).toHaveLength(1);
    expect(scanned.verify).toHaveLength(1);
    expect(scanned.repair).toHaveLength(1);
    expect(scanned.all.map((phase) => phase.phase)).toEqual(["execute", "verify", "repair"]);

    expect(scanned.execute[0]).toMatchObject({
      phase: "execute",
      phaseLabel: "execute-main",
      exitCode: 0,
      stdoutPresent: true,
      stderrPresent: false,
    });
    expect(scanned.execute[0]?.promptFilePath).toBe(path.join(executePhase.dir, "prompt.md"));

    expect(scanned.verify[0]).toMatchObject({
      phase: "verify",
      phaseLabel: "verify-01",
      exitCode: 1,
      verificationResult: "NOT_OK: mismatch",
      stdoutPresent: false,
      stderrPresent: true,
    });
    expect(scanned.verify[0]?.promptFilePath).toBe(path.join(verifyPhase.dir, "prompt.md"));

    expect(scanned.repair[0]).toMatchObject({
      phase: "repair",
      phaseLabel: "repair-01",
      exitCode: 0,
      verificationResult: undefined,
      stdoutPresent: false,
      stderrPresent: false,
      promptFilePath: null,
    });
  });

  it("scans a run with only a single execute phase", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    const executePhase = beginRuntimePhase(context, {
      phase: "execute",
      phaseLabel: "execute-only",
      prompt: "execute prompt",
    });
    completeRuntimePhase(executePhase, {
      exitCode: 0,
      stdout: "done",
      outputCaptured: true,
    });

    const scanned = scanRuntimeArtifactPhases(context.rootDir);

    expect(scanned.execute).toHaveLength(1);
    expect(scanned.verify).toHaveLength(0);
    expect(scanned.repair).toHaveLength(0);
    expect(scanned.resolve).toHaveLength(0);
    expect(scanned.all).toHaveLength(1);
    expect(scanned.execute[0]).toMatchObject({
      phase: "execute",
      phaseLabel: "execute-only",
      sequence: 1,
      exitCode: 0,
      stdoutPresent: true,
      stderrPresent: false,
    });
  });

  it("scans multiple verify/repair cycles in sequence order", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    const executePhase = beginRuntimePhase(context, {
      phase: "execute",
      phaseLabel: "execute-main",
      prompt: "execute prompt",
    });
    completeRuntimePhase(executePhase, {
      exitCode: 0,
      outputCaptured: false,
    });

    const verify1 = beginRuntimePhase(context, {
      phase: "verify",
      phaseLabel: "verify-01",
      prompt: "verify 1",
    });
    completeRuntimePhase(verify1, {
      exitCode: 1,
      verificationResult: "NOT_OK: first failure",
      outputCaptured: false,
    });

    const repair1 = beginRuntimePhase(context, {
      phase: "repair",
      phaseLabel: "repair-01",
      prompt: "repair 1",
    });
    completeRuntimePhase(repair1, {
      exitCode: 0,
      outputCaptured: false,
    });

    const verify2 = beginRuntimePhase(context, {
      phase: "verify",
      phaseLabel: "verify-02",
      prompt: "verify 2",
    });
    completeRuntimePhase(verify2, {
      exitCode: 1,
      verificationResult: "NOT_OK: second failure",
      outputCaptured: false,
    });

    const repair2 = beginRuntimePhase(context, {
      phase: "repair",
      phaseLabel: "repair-02",
      prompt: "repair 2",
    });
    completeRuntimePhase(repair2, {
      exitCode: 0,
      outputCaptured: false,
    });

    const verify3 = beginRuntimePhase(context, {
      phase: "verify",
      phaseLabel: "verify-03",
      prompt: "verify 3",
    });
    completeRuntimePhase(verify3, {
      exitCode: 0,
      verificationResult: "OK",
      outputCaptured: false,
    });

    const scanned = scanRuntimeArtifactPhases(context.rootDir);

    expect(scanned.execute).toHaveLength(1);
    expect(scanned.verify).toHaveLength(3);
    expect(scanned.repair).toHaveLength(2);
    expect(scanned.all.map((phase) => phase.phaseLabel)).toEqual([
      "execute-main",
      "verify-01",
      "repair-01",
      "verify-02",
      "repair-02",
      "verify-03",
    ]);
    expect(scanned.verify.map((phase) => phase.verificationResult)).toEqual([
      "NOT_OK: first failure",
      "NOT_OK: second failure",
      "OK",
    ]);
  });

  it("marks stdout/stderr as absent when metadata references missing files", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    const executePhase = beginRuntimePhase(context, {
      phase: "execute",
      phaseLabel: "execute-missing-streams",
      prompt: "execute prompt",
    });
    completeRuntimePhase(executePhase, {
      exitCode: 0,
      stdout: "temporary output",
      stderr: "temporary error",
      outputCaptured: true,
    });

    fs.rmSync(path.join(executePhase.dir, "stdout.log"));
    fs.rmSync(path.join(executePhase.dir, "stderr.log"));

    const scanned = scanRuntimeArtifactPhases(context.rootDir);

    expect(scanned.execute).toHaveLength(1);
    expect(scanned.execute[0]).toMatchObject({
      phase: "execute",
      stdoutPresent: false,
      stderrPresent: false,
    });
  });

  it("ignores non-target phases and missing metadata when scanning", () => {
    const cwd = createWorkspace();
    const context = createRuntimeArtifactsContext({ cwd, commandName: "run", keepArtifacts: true });

    const workerPhase = beginRuntimePhase(context, {
      phase: "worker",
      prompt: "worker prompt",
    });
    completeRuntimePhase(workerPhase, {
      exitCode: 0,
      outputCaptured: false,
    });

    const executePhase = beginRuntimePhase(context, {
      phase: "execute",
      prompt: "execute prompt",
    });
    completeRuntimePhase(executePhase, {
      exitCode: 0,
      outputCaptured: false,
    });

    const orphanPhaseDir = path.join(context.rootDir, "99-repair-orphan");
    fs.mkdirSync(orphanPhaseDir, { recursive: true });

    const scanned = scanRuntimeArtifactPhases(context.rootDir);
    expect(scanned.execute).toHaveLength(1);
    expect(scanned.verify).toHaveLength(0);
    expect(scanned.repair).toHaveLength(0);
    expect(scanned.all).toHaveLength(1);
    expect(scanned.all[0]?.phase).toBe("execute");
  });

  it("returns empty phase groups for missing run directories", () => {
    const cwd = createWorkspace();
    const missingRunDir = path.join(cwd, "does-not-exist");

    expect(scanRuntimeArtifactPhases(missingRunDir)).toEqual({
      execute: [],
      verify: [],
      repair: [],
      resolve: [],
      all: [],
    });
  });

  it("returns empty phase groups for an empty run directory", () => {
    const cwd = createWorkspace();
    const emptyRunDir = path.join(cwd, "empty-run");
    fs.mkdirSync(emptyRunDir, { recursive: true });

    expect(scanRuntimeArtifactPhases(emptyRunDir)).toEqual({
      execute: [],
      verify: [],
      repair: [],
      resolve: [],
      all: [],
    });
  });
});

function createWorkspace(): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-artifacts-"));
  tempDirs.push(workspace);
  return workspace;
}
