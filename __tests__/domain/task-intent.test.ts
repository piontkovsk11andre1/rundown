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

  it("matches verify-only aliases case-insensitively with colon spacing", () => {
    expect(classifyTaskIntent("VeRiFy : release checks").intent).toBe("verify-only");
    expect(classifyTaskIntent("  CONFIRM   : changelog entries").intent).toBe("verify-only");
    expect(classifyTaskIntent("cHeCk:\tci status").intent).toBe("verify-only");
  });

  it("preserves normalized task text for verify-only prefixes", () => {
    const decision = classifyTaskIntent("  verify:   release docs are aligned  ");
    expect(decision.intent).toBe("verify-only");
    expect(decision.normalizedTaskText).toBe("verify:   release docs are aligned");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("keeps verify-only behavior when payload mentions memory aliases", () => {
    const decision = classifyTaskIntent("confirm: memory: capture incident timeline");
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("classifies memory: prefix as memory-capture", () => {
    const decision = classifyTaskIntent("memory: capture architecture notes");
    expect(decision.intent).toBe("memory-capture");
    expect(decision.reason).toContain("memory");
    expect(decision.memoryCapturePrefix).toBe("memory");
    expect(decision.normalizedTaskText).toBe("capture architecture notes");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("classifies memory prefix aliases as memory-capture", () => {
    const memorizeDecision = classifyTaskIntent("memorize: capture release notes");
    expect(memorizeDecision.intent).toBe("memory-capture");
    expect(memorizeDecision.memoryCapturePrefix).toBe("memorize");

    const rememberDecision = classifyTaskIntent("remember: capture migration caveats");
    expect(rememberDecision.intent).toBe("memory-capture");
    expect(rememberDecision.memoryCapturePrefix).toBe("remember");

    const inventoryDecision = classifyTaskIntent("inventory: capture task context");
    expect(inventoryDecision.intent).toBe("memory-capture");
    expect(inventoryDecision.memoryCapturePrefix).toBe("inventory");
  });

  it("matches memory prefixes case-insensitively and with colon spacing", () => {
    expect(classifyTaskIntent("MeMoRy : keep this context").intent).toBe("memory-capture");
    expect(classifyTaskIntent("  INVENTORY   : map current state").intent).toBe("memory-capture");
  });

  it("extracts normalized payload text for memory capture aliases", () => {
    expect(classifyTaskIntent("memory:   keep deploy checklist").normalizedTaskText).toBe("keep deploy checklist");
    expect(classifyTaskIntent("memorize :   release caveats").normalizedTaskText).toBe("release caveats");
    expect(classifyTaskIntent("remember:\tincident timeline").normalizedTaskText).toBe("incident timeline");
    expect(classifyTaskIntent("inventory:\n  service boundaries").normalizedTaskText).toBe("service boundaries");
  });

  it("flags empty memory payloads after prefix normalization", () => {
    expect(classifyTaskIntent("memory:").hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("memorize:   ").hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("remember :\n\t").hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("inventory: \r\n ").hasEmptyPayload).toBe(true);
  });

  it("does not classify non-prefix memory words as memory-capture", () => {
    const decision = classifyTaskIntent("Document memory:pressure behavior in scheduler");
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
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
    expect(decision.normalizedTaskText).toBe("Implement API schema validation and verify fixtures");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("defaults to execute-and-verify for rundown delegate tasks", () => {
    const decision = classifyTaskIntent("rundown: Test.md --optional arg-val");
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });
});
