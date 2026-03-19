import { describe, expect, it } from "vitest";
import { requiresWorkerCommand, resolveRunBehavior } from "../../src/domain/run-options.js";

describe("resolveRunBehavior", () => {
  it("implies validation for only-validate mode", () => {
    expect(resolveRunBehavior({
      validate: false,
      onlyValidate: true,
      noCorrect: false,
      retries: 0,
    })).toEqual({
      shouldValidate: true,
      onlyValidate: true,
      allowCorrection: false,
      maxRetries: 0,
    });
  });

  it("disables correction when no-correct is set", () => {
    expect(resolveRunBehavior({
      validate: true,
      onlyValidate: false,
      noCorrect: true,
      retries: 3,
    })).toEqual({
      shouldValidate: true,
      onlyValidate: false,
      allowCorrection: false,
      maxRetries: 3,
    });
  });

  it("enables correction when retries are positive and no-correct is false", () => {
    expect(resolveRunBehavior({
      validate: true,
      onlyValidate: false,
      noCorrect: false,
      retries: 2,
    })).toEqual({
      shouldValidate: true,
      onlyValidate: false,
      allowCorrection: true,
      maxRetries: 2,
    });
  });
});

describe("requiresWorkerCommand", () => {
  it("requires a worker for normal agent tasks", () => {
    expect(requiresWorkerCommand({
      workerCommand: [],
      isInlineCli: false,
      shouldValidate: false,
      onlyValidate: false,
    })).toBe(true);
  });

  it("does not require a worker for inline cli without validation", () => {
    expect(requiresWorkerCommand({
      workerCommand: [],
      isInlineCli: true,
      shouldValidate: false,
      onlyValidate: false,
    })).toBe(false);
  });

  it("requires a worker for validate-only mode", () => {
    expect(requiresWorkerCommand({
      workerCommand: [],
      isInlineCli: true,
      shouldValidate: true,
      onlyValidate: true,
    })).toBe(true);
  });

  it("does not require a worker when one is provided", () => {
    expect(requiresWorkerCommand({
      workerCommand: ["opencode", "run"],
      isInlineCli: false,
      shouldValidate: true,
      onlyValidate: true,
    })).toBe(false);
  });
});
