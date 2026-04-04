import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runVerifyRepairLoop } from "../../src/application/verify-repair-loop.js";
import type { Task } from "../../src/domain/parser.js";
import { createArtifactVerificationStore } from "../../src/infrastructure/adapters/artifact-verification-store.js";
import {
  beginRuntimePhase,
  completeRuntimePhase,
  createRuntimeArtifactsContext,
  type RuntimeArtifactsContext,
} from "../../src/infrastructure/runtime-artifacts.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("verify-repair-loop trace metrics", () => {
  it("emits verification.efficiency on first-pass success", async () => {
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => ({ valid: true })),
      },
      taskRepair: {
        repair: vi.fn(async () => ({ valid: false, attempts: 0 })),
      },
      verificationStore: {
        write: vi.fn(),
        read: vi.fn(() => null),
        remove: vi.fn(),
      },
      traceWriter,
      output: {
        emit: vi.fn(),
      },
    }, {
      task: createTask(),
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 2,
      allowRepair: true,
      templateVars: {},
      artifactContext: { runId: "run-1" },
      trace: true,
    });

    expect(result).toEqual({
      valid: true,
      failureReason: null,
    });
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "verification.efficiency",
      payload: {
        first_pass_success: true,
        total_verify_attempts: 1,
        total_repair_attempts: 0,
        verification_to_execution_ratio: null,
        cumulative_failure_reasons: [],
      },
    }));
  });

  it("emits verification.efficiency with retries and cumulative failure reasons", async () => {
    const traceWriter = {
      write: vi.fn(),
      flush: vi.fn(),
    };

    const verificationStoreRead = vi.fn()
      .mockReturnValueOnce("missing test coverage")
      .mockReturnValueOnce("missing test coverage")
      .mockReturnValueOnce("missing test coverage")
      .mockReturnValueOnce("still failing assertions");

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => ({ valid: false })),
      },
      taskRepair: {
        repair: vi.fn()
          .mockResolvedValueOnce({ valid: false, attempts: 1 })
          .mockResolvedValueOnce({ valid: true, attempts: 1 }),
      },
      verificationStore: {
        write: vi.fn(),
        read: verificationStoreRead,
        remove: vi.fn(),
      },
      traceWriter,
      output: {
        emit: vi.fn(),
      },
    }, {
      task: createTask(),
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 3,
      allowRepair: true,
      templateVars: {},
      artifactContext: { runId: "run-2" },
      trace: true,
    });

    expect(result).toEqual({
      valid: true,
      failureReason: null,
    });
    expect(traceWriter.write).toHaveBeenCalledWith(expect.objectContaining({
      event_type: "verification.efficiency",
      payload: expect.objectContaining({
        first_pass_success: false,
        total_verify_attempts: 3,
        total_repair_attempts: 2,
        cumulative_failure_reasons: ["missing test coverage", "still failing assertions"],
      }),
    }));

    const efficiencyEvent = traceWriter.write.mock.calls
      .map((call) => call[0])
      .find((event) => event?.event_type === "verification.efficiency");

    const ratio = efficiencyEvent?.payload.verification_to_execution_ratio;
    if (ratio !== null) {
      expect(typeof ratio).toBe("number");
      expect(ratio).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("verify-repair-loop output", () => {
  it("does not emit a failure-reason error when verification passes", async () => {
    const output = {
      emit: vi.fn(),
    };

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => ({ valid: true })),
      },
      taskRepair: {
        repair: vi.fn(async () => ({ valid: false, attempts: 0 })),
      },
      verificationStore: {
        write: vi.fn(),
        read: vi.fn(() => "should not be emitted"),
        remove: vi.fn(),
      },
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      output,
    }, {
      task: createTask(),
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 2,
      allowRepair: false,
      templateVars: {},
      artifactContext: { runId: "run-5" },
      trace: false,
    });

    expect(result).toEqual({
      valid: true,
      failureReason: null,
    });
    expect(output.emit).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("Last validation error:"),
    }));
  });

  it("emits the last failure reason when verification fails without repair", async () => {
    const output = {
      emit: vi.fn(),
    };

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => ({ valid: false })),
      },
      taskRepair: {
        repair: vi.fn(async () => ({ valid: false, attempts: 0 })),
      },
      verificationStore: {
        write: vi.fn(),
        read: vi.fn(() => "schema mismatch on metadata.version"),
        remove: vi.fn(),
      },
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      output,
    }, {
      task: createTask(),
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 2,
      allowRepair: false,
      templateVars: {},
      artifactContext: { runId: "run-3" },
      trace: false,
    });

    expect(result).toEqual({
      valid: false,
      failureReason: "schema mismatch on metadata.version",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "error",
      message: "Last validation error: schema mismatch on metadata.version",
    });
  });

  it("emits the last failure reason when all repair attempts are exhausted", async () => {
    const output = {
      emit: vi.fn(),
    };

    const verificationStoreRead = vi.fn()
      .mockReturnValueOnce("missing integration test")
      .mockReturnValueOnce("missing integration test")
      .mockReturnValueOnce("assertion failed in attempt 1")
      .mockReturnValueOnce("type mismatch in payload.id");

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => ({ valid: false })),
      },
      taskRepair: {
        repair: vi.fn()
          .mockResolvedValueOnce({ valid: false, attempts: 1 })
          .mockResolvedValueOnce({ valid: false, attempts: 1 }),
      },
      verificationStore: {
        write: vi.fn(),
        read: verificationStoreRead,
        remove: vi.fn(),
      },
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      output,
    }, {
      task: createTask(),
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 2,
      allowRepair: true,
      templateVars: {},
      artifactContext: { runId: "run-4" },
      trace: false,
    });

    expect(result).toEqual({
      valid: false,
      failureReason: "type mismatch in payload.id",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Verification failed: missing integration test. Running repair (2 attempt(s))...",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Repair attempt 1 failed: assertion failed in attempt 1",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Repair attempt 2 failed: type mismatch in payload.id",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "error",
      message: "Last validation error: type mismatch in payload.id",
    });
  });

  it("emits per-attempt failure reasons for each failed repair before success", async () => {
    const output = {
      emit: vi.fn(),
    };

    const verificationStoreRead = vi.fn()
      .mockReturnValueOnce("missing integration test")
      .mockReturnValueOnce("missing integration test")
      .mockReturnValueOnce("attempt 1 failed: lint errors")
      .mockReturnValueOnce("attempt 2 failed: type mismatch");

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => ({ valid: false })),
      },
      taskRepair: {
        repair: vi.fn()
          .mockResolvedValueOnce({ valid: false, attempts: 1 })
          .mockResolvedValueOnce({ valid: false, attempts: 1 })
          .mockResolvedValueOnce({ valid: true, attempts: 1 }),
      },
      verificationStore: {
        write: vi.fn(),
        read: verificationStoreRead,
        remove: vi.fn(),
      },
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      output,
    }, {
      task: createTask(),
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 3,
      allowRepair: true,
      templateVars: {},
      artifactContext: { runId: "run-6" },
      trace: false,
    });

    expect(result).toEqual({
      valid: true,
      failureReason: null,
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Repair attempt 1 failed: attempt 1 failed: lint errors",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Repair attempt 2 failed: attempt 2 failed: type mismatch",
    });
    expect(output.emit).not.toHaveBeenCalledWith({
      kind: "warn",
      message: expect.stringContaining("Repair attempt 3 failed:"),
    });
  });

  it("reads failure reasons from artifact-backed verification store", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-loop-artifact-store-"));
    tempDirs.push(root);

    const task = createTask(path.join(root, "tasks.md"));
    fs.writeFileSync(task.file, "- [ ] Ship release\n", "utf-8");

    const artifactContext = createRuntimeArtifactsContext({
      cwd: root,
      commandName: "run",
      task: {
        text: task.text,
        file: task.file,
        line: task.line,
        index: task.index,
        source: "- [ ] Ship release",
      },
      keepArtifacts: true,
    });
    const verificationStore = createArtifactVerificationStore(path.join(root, ".rundown"));
    const output = {
      emit: vi.fn(),
    };

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => {
          persistVerifyResult(artifactContext, task, verificationStore, "missing integration test", false);
          return { valid: false };
        }),
      },
      taskRepair: {
        repair: vi.fn(async () => {
          persistVerifyResult(artifactContext, task, verificationStore, "type mismatch in payload.id", false);
          return { valid: false, attempts: 1 };
        }),
      },
      verificationStore,
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      output,
    }, {
      task,
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 1,
      allowRepair: true,
      templateVars: {},
      artifactContext,
      trace: false,
    });

    expect(result).toEqual({
      valid: false,
      failureReason: "type mismatch in payload.id",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Verification failed: missing integration test. Running repair (1 attempt(s))...",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Repair attempt 1 failed: type mismatch in payload.id",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "error",
      message: "Last validation error: type mismatch in payload.id",
    });
  });

  it("keeps verification artifacts when loop calls remove on success", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-loop-artifact-store-"));
    tempDirs.push(root);

    const task = createTask(path.join(root, "tasks.md"));
    fs.writeFileSync(task.file, "- [ ] Ship release\n", "utf-8");

    const artifactContext = createRuntimeArtifactsContext({
      cwd: root,
      commandName: "run",
      task: {
        text: task.text,
        file: task.file,
        line: task.line,
        index: task.index,
        source: "- [ ] Ship release",
      },
      keepArtifacts: true,
    });
    const verificationStore = createArtifactVerificationStore(path.join(root, ".rundown"));

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => {
          persistVerifyResult(artifactContext, task, verificationStore, "OK", true);
          return { valid: true };
        }),
      },
      taskRepair: {
        repair: vi.fn(async () => ({ valid: false, attempts: 0 })),
      },
      verificationStore,
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      output: {
        emit: vi.fn(),
      },
    }, {
      task,
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 1,
      allowRepair: true,
      templateVars: {},
      artifactContext,
      trace: false,
    });

    expect(result).toEqual({
      valid: true,
      failureReason: null,
    });
    expect(verificationStore.read(task)).toBe("OK");
  });

  it("passes verification failure to repair via in-memory store when artifacts are not persisted", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-loop-artifact-store-"));
    tempDirs.push(root);

    const task = createTask(path.join(root, "tasks.md"));
    fs.writeFileSync(task.file, "- [ ] Ship release\n", "utf-8");

    const verificationStore = createArtifactVerificationStore(path.join(root, ".rundown"));
    const output = {
      emit: vi.fn(),
    };
    const repairReadReasons: string[] = [];

    const result = await runVerifyRepairLoop({
      taskVerification: {
        verify: vi.fn(async () => {
          verificationStore.write(task, "  missing migration rollback  ");
          return { valid: false };
        }),
      },
      taskRepair: {
        repair: vi.fn(async () => {
          repairReadReasons.push(
            verificationStore.read(task) ?? "<missing>",
          );
          verificationStore.write(task, "still failing post-repair");
          return { valid: false, attempts: 1 };
        }),
      },
      verificationStore,
      traceWriter: {
        write: vi.fn(),
        flush: vi.fn(),
      },
      output,
    }, {
      task,
      source: "- [ ] ship release",
      contextBefore: "",
      verifyTemplate: "{{task}}",
      repairTemplate: "{{task}}",
      workerCommand: ["opencode", "run"],
      transport: "file",
      maxRepairAttempts: 1,
      allowRepair: true,
      templateVars: {},
      artifactContext: undefined,
      trace: false,
    });

    expect(result).toEqual({
      valid: false,
      failureReason: "still failing post-repair",
    });
    expect(repairReadReasons).toEqual(["missing migration rollback"]);
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Verification failed: missing migration rollback. Running repair (1 attempt(s))...",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "warn",
      message: "Repair attempt 1 failed: still failing post-repair",
    });
    expect(output.emit).toHaveBeenCalledWith({
      kind: "error",
      message: "Last validation error: still failing post-repair",
    });
  });
});

function persistVerifyResult(
  artifactContext: RuntimeArtifactsContext,
  task: Task,
  verificationStore: ReturnType<typeof createArtifactVerificationStore>,
  verificationResult: string,
  ok: boolean,
): void {
  const phase = beginRuntimePhase(artifactContext, {
    phase: "verify",
    prompt: "verify",
    command: ["worker"],
    mode: "wait",
    transport: "file",
  });
  completeRuntimePhase(phase, {
    exitCode: ok ? 0 : 1,
    stdout: verificationResult,
    stderr: "",
    outputCaptured: true,
  });

  verificationStore.write(task, verificationResult);
}

function createTask(file = "tasks.md"): Task {
  return {
    text: "Ship release",
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: 12,
    file,
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}
