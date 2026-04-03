import { describe, expect, it } from "vitest";
import { requiresWorkerCommand, resolveRunBehavior } from "../../src/domain/run-options.js";

describe("resolveRunBehavior", () => {
  it("implies verification for only-verify mode", () => {
    expect(resolveRunBehavior({
      verify: false,
      onlyVerify: true,
      noRepair: false,
      repairAttempts: 0,
    })).toEqual({
      shouldVerify: true,
      onlyVerify: true,
      allowRepair: false,
      maxRepairAttempts: 0,
    });
  });

  it("disables repair when no-repair is set", () => {
    expect(resolveRunBehavior({
      verify: true,
      onlyVerify: false,
      noRepair: true,
      repairAttempts: 3,
    })).toEqual({
      shouldVerify: true,
      onlyVerify: false,
      allowRepair: false,
      maxRepairAttempts: 3,
    });
  });

  it("enables repair when repair attempts are positive and no-repair is false", () => {
    expect(resolveRunBehavior({
      verify: true,
      onlyVerify: false,
      noRepair: false,
      repairAttempts: 2,
    })).toEqual({
      shouldVerify: true,
      onlyVerify: false,
      allowRepair: true,
      maxRepairAttempts: 2,
    });
  });
});

describe("requiresWorkerCommand", () => {
  it("requires a worker for normal agent tasks", () => {
    expect(requiresWorkerCommand({
      workerCommand: [],
      hasConfigWorker: false,
      isInlineCli: false,
      shouldVerify: false,
      onlyVerify: false,
    })).toBe(true);
  });

  it("does not require a worker for inline cli without validation", () => {
    expect(requiresWorkerCommand({
      workerCommand: [],
      hasConfigWorker: false,
      isInlineCli: true,
      shouldVerify: false,
      onlyVerify: false,
    })).toBe(false);
  });

  it("requires a worker for verify-only mode", () => {
    expect(requiresWorkerCommand({
      workerCommand: [],
      hasConfigWorker: false,
      isInlineCli: true,
      shouldVerify: true,
      onlyVerify: true,
    })).toBe(true);
  });

  it("does not require a worker when one is provided", () => {
    expect(requiresWorkerCommand({
      workerCommand: ["opencode", "run"],
      hasConfigWorker: false,
      isInlineCli: false,
      shouldVerify: true,
      onlyVerify: true,
    })).toBe(false);
  });

  it("does not require a worker when one is available from config", () => {
    expect(requiresWorkerCommand({
      workerCommand: [],
      hasConfigWorker: true,
      isInlineCli: false,
      shouldVerify: true,
      onlyVerify: true,
    })).toBe(false);
  });
});
