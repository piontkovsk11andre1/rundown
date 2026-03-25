import { describe, expect, it } from "vitest";
import { classifyTaskIntent } from "../../src/domain/task-intent.js";

describe("classifyTaskIntent", () => {
  it("classifies explicit verify marker as verify-only", () => {
    const decision = classifyTaskIntent("verify: release notes are accurate");
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("classifies bracket verify marker as verify-only", () => {
    const decision = classifyTaskIntent("[confirm] changelog includes migration note");
    expect(decision.intent).toBe("verify-only");
  });

  it("uses conservative fallback for verification verb without implementation verbs", () => {
    const decision = classifyTaskIntent("Confirm all docs links resolve");
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("fallback");
  });

  it("defaults mixed intent to execute-and-verify", () => {
    const decision = classifyTaskIntent("Implement API schema validation and verify fixtures");
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toContain("mixed intent");
  });
});
