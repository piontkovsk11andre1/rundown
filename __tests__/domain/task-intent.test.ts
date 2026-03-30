import { describe, expect, it } from "vitest";
import { classifyTaskIntent } from "../../src/domain/task-intent.js";

describe("classifyTaskIntent", () => {
  it("classifies explicit verify: prefix as verify-only", () => {
    const decision = classifyTaskIntent("verify: release notes are accurate");
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("classifies confirm: prefix as verify-only", () => {
    const decision = classifyTaskIntent("confirm: changelog includes migration note");
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("classifies check: prefix as verify-only", () => {
    const decision = classifyTaskIntent("check: all tests pass");
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("treats [verify] bracket prefix as execute-and-verify", () => {
    const decision = classifyTaskIntent("[verify] docs are up to date");
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });

  it("does not guess intent from verification verbs alone", () => {
    const decision = classifyTaskIntent("Confirm all docs links resolve");
    expect(decision.intent).toBe("execute-and-verify");
  });

  it("treats tasks mentioning verify without explicit prefix as execute-and-verify", () => {
    const decision = classifyTaskIntent("Instrument verify-repair-loop to emit verification.result");
    expect(decision.intent).toBe("execute-and-verify");
  });

  it("defaults to execute-and-verify for implementation tasks", () => {
    const decision = classifyTaskIntent("Implement API schema validation and verify fixtures");
    expect(decision.intent).toBe("execute-and-verify");
  });

  it("defaults to execute-and-verify for rundown delegate tasks", () => {
    const decision = classifyTaskIntent("rundown: Test.md --optional arg-val");
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });
});
