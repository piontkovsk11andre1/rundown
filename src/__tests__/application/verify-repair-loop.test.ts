import { describe, it, expect, vi } from "vitest";
import { runVerifyRepairLoop } from "../verify-repair-loop.ts";
import type { VerifyRepairLoopDependencies, VerifyRepairLoopInput } from "../verify-repair-loop.ts";

describe("runVerifyRepairLoop", () => {
  describe("usage limit detection", () => {
    it("does not trigger detection for short/trivial outputs (e.g. 'Done')", async () => {
      const mockTaskVerification = {
        verify: vi.fn().mockResolvedValue({
          valid: false,
          formatWarning: null,
          stdout: "Done",
        }),
      };
      const mockTaskRepair = {
        repair: vi.fn(),
      };
      const mockVerificationStore = {
        read: vi.fn().mockReturnValue("Verification failed"),
        remove: vi.fn(),
      };
      const mockTraceWriter = {
        write: vi.fn(),
      };
      const mockOutput = {
        emit: vi.fn(),
      };

      const dependencies: VerifyRepairLoopDependencies = {
        taskVerification: mockTaskVerification,
        taskRepair: mockTaskRepair,
        verificationStore: mockVerificationStore,
        traceWriter: mockTraceWriter,
        output: mockOutput,
      };

      const input: VerifyRepairLoopInput = {
        task: { id: "test-task", content: "Test task" } as any,
        source: "test source",
        contextBefore: "test context",
        verifyTemplate: "test verify",
        repairTemplate: "test repair",
        executionStdout: "Done",
        workerPattern: { command: ["test"], vars: {} } as any,
        maxRepairAttempts: 1,
        allowRepair: false,
        templateVars: {},
        trace: false,
        runMode: "tui",
        executionOutputCaptured: true,
        isInlineCliTask: false,
        isToolExpansionTask: false,
        artifactContext: {},
      };

      const result = await runVerifyRepairLoop(dependencies, input);

      expect(result.valid).toBe(false);
      expect(result.usageLimitDetected).toBeUndefined();
      expect(mockOutput.emit).toHaveBeenCalledWith({
        kind: "error",
        message: expect.stringContaining("Last validation error"),
      });
    });
  });
});