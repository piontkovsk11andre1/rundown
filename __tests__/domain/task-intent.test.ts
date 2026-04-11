import { describe, expect, it } from "vitest";
import { classifyTaskIntent } from "../../src/domain/task-intent.js";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import type { ToolResolverPort } from "../../src/domain/ports/tool-resolver-port.js";

const noToolResolver: ToolResolverPort = {
  resolve: () => undefined,
  listKnownToolNames: () => [],
};

const builtinToolResolver: ToolResolverPort = {
  resolve: (toolName) => resolveBuiltinTool(toolName),
  listKnownToolNames: () => listBuiltinToolNames(),
};

describe("classifyTaskIntent", () => {
  it("classifies explicit verify: prefix as verify-only", () => {
    const decision = classifyTaskIntent("verify: release notes are accurate", noToolResolver);
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("classifies confirm: prefix as verify-only", () => {
    const decision = classifyTaskIntent("confirm: changelog includes migration note", noToolResolver);
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("classifies check: prefix as verify-only", () => {
    const decision = classifyTaskIntent("check: all tests pass", noToolResolver);
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("matches verify-only aliases case-insensitively with colon spacing", () => {
    expect(classifyTaskIntent("VeRiFy : release checks", noToolResolver).intent).toBe("verify-only");
    expect(classifyTaskIntent("  CONFIRM   : changelog entries", noToolResolver).intent).toBe("verify-only");
    expect(classifyTaskIntent("cHeCk:\tci status", noToolResolver).intent).toBe("verify-only");
  });

  it("preserves normalized task text for verify-only prefixes", () => {
    const decision = classifyTaskIntent("  verify:   release docs are aligned  ", noToolResolver);
    expect(decision.intent).toBe("verify-only");
    expect(decision.normalizedTaskText).toBe("verify:   release docs are aligned");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("keeps verify-only behavior when payload mentions memory aliases", () => {
    const decision = classifyTaskIntent("confirm: memory: capture incident timeline", noToolResolver);
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("classifies memory: prefix as memory-capture", () => {
    const decision = classifyTaskIntent("memory: capture architecture notes", noToolResolver);
    expect(decision.intent).toBe("memory-capture");
    expect(decision.reason).toContain("memory");
    expect(decision.memoryCapturePrefix).toBe("memory");
    expect(decision.normalizedTaskText).toBe("capture architecture notes");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("classifies memory prefix aliases as memory-capture", () => {
    const memorizeDecision = classifyTaskIntent("memorize: capture release notes", noToolResolver);
    expect(memorizeDecision.intent).toBe("memory-capture");
    expect(memorizeDecision.memoryCapturePrefix).toBe("memorize");

    const rememberDecision = classifyTaskIntent("remember: capture migration caveats", noToolResolver);
    expect(rememberDecision.intent).toBe("memory-capture");
    expect(rememberDecision.memoryCapturePrefix).toBe("remember");

    const inventoryDecision = classifyTaskIntent("inventory: capture task context", noToolResolver);
    expect(inventoryDecision.intent).toBe("memory-capture");
    expect(inventoryDecision.memoryCapturePrefix).toBe("inventory");
  });

  it("matches memory prefixes case-insensitively and with colon spacing", () => {
    expect(classifyTaskIntent("MeMoRy : keep this context", noToolResolver).intent).toBe("memory-capture");
    expect(classifyTaskIntent("  INVENTORY   : map current state", noToolResolver).intent).toBe("memory-capture");
  });

  it("extracts normalized payload text for memory capture aliases", () => {
    expect(classifyTaskIntent("memory:   keep deploy checklist", noToolResolver).normalizedTaskText).toBe("keep deploy checklist");
    expect(classifyTaskIntent("memorize :   release caveats", noToolResolver).normalizedTaskText).toBe("release caveats");
    expect(classifyTaskIntent("remember:\tincident timeline", noToolResolver).normalizedTaskText).toBe("incident timeline");
    expect(classifyTaskIntent("inventory:\n  service boundaries", noToolResolver).normalizedTaskText).toBe("service boundaries");
  });

  it("flags empty memory payloads after prefix normalization", () => {
    expect(classifyTaskIntent("memory:", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("memorize:   ", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("remember :\n\t", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("inventory: \r\n ", noToolResolver).hasEmptyPayload).toBe(true);
  });

  it("classifies parallel aliases as parallel-group", () => {
    const parallelDecision = classifyTaskIntent("parallel: setup all services", noToolResolver);
    expect(parallelDecision.intent).toBe("parallel-group");
    expect(parallelDecision.reason).toBe("explicit parallel marker");
    expect(parallelDecision.normalizedTaskText).toBe("setup all services");
    expect(parallelDecision.hasEmptyPayload).toBe(false);

    const concurrentDecision = classifyTaskIntent("concurrent: preflight checks", noToolResolver);
    expect(concurrentDecision.intent).toBe("parallel-group");
    expect(concurrentDecision.normalizedTaskText).toBe("preflight checks");

    const shortAliasDecision = classifyTaskIntent("par: prep artifacts", noToolResolver);
    expect(shortAliasDecision.intent).toBe("parallel-group");
    expect(shortAliasDecision.normalizedTaskText).toBe("prep artifacts");
  });

  it("matches parallel aliases case-insensitively with colon spacing", () => {
    expect(classifyTaskIntent("PARALLEL : run setup", noToolResolver).intent).toBe("parallel-group");
    expect(classifyTaskIntent("  ConCurRent   : configure deps", noToolResolver).intent).toBe("parallel-group");
    expect(classifyTaskIntent("pAr:\tprepare cache", noToolResolver).intent).toBe("parallel-group");
  });

  it("trims parallel payload text and flags empty payloads", () => {
    expect(classifyTaskIntent("  parallel:   setup workers  ", noToolResolver).normalizedTaskText).toBe("setup workers");
    expect(classifyTaskIntent("concurrent:\n  warm caches", noToolResolver).normalizedTaskText).toBe("warm caches");

    expect(classifyTaskIntent("parallel:", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("concurrent:   ", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("par :\n\t", noToolResolver).hasEmptyPayload).toBe(true);
  });

  it("does not classify non-prefix parallel text as parallel-group", () => {
    expect(classifyTaskIntent("Run setup tasks in parallel across services", noToolResolver).intent).toBe("execute-and-verify");
    expect(classifyTaskIntent("Use concurrent workers for preflight checks", noToolResolver).intent).toBe("execute-and-verify");
    expect(classifyTaskIntent("Update parser output formatting", noToolResolver).intent).toBe("execute-and-verify");
  });

  it("classifies fast: and raw: prefixes as fast-execution", () => {
    const fastDecision = classifyTaskIntent("fast: run release script", noToolResolver);
    expect(fastDecision.intent).toBe("fast-execution");
    expect(fastDecision.reason).toBe("explicit fast marker");
    expect(fastDecision.normalizedTaskText).toBe("run release script");

    const rawDecision = classifyTaskIntent("raw: run release script", noToolResolver);
    expect(rawDecision.intent).toBe("fast-execution");
    expect(rawDecision.reason).toBe("explicit fast marker");
    expect(rawDecision.normalizedTaskText).toBe("run release script");
  });

  it("matches fast aliases case-insensitively with colon spacing", () => {
    expect(classifyTaskIntent("FAST: compile docs", noToolResolver).intent).toBe("fast-execution");
    expect(classifyTaskIntent("Raw : refresh fixtures", noToolResolver).intent).toBe("fast-execution");
    expect(classifyTaskIntent("fAsT:\tdeploy preview", noToolResolver).intent).toBe("fast-execution");
  });

  it("trims fast payload text and flags empty payloads", () => {
    expect(classifyTaskIntent("  fast:   run smoke tests  ", noToolResolver).normalizedTaskText).toBe("run smoke tests");
    expect(classifyTaskIntent("raw:\n  collect logs", noToolResolver).normalizedTaskText).toBe("collect logs");

    expect(classifyTaskIntent("fast:", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("raw:   ", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("FAST :\n\t", noToolResolver).hasEmptyPayload).toBe(true);
  });

  it("does not classify plain text containing fast/raw words as fast-execution", () => {
    expect(classifyTaskIntent("fast forward these docs", noToolResolver).intent).toBe("execute-and-verify");
    expect(classifyTaskIntent("raw logs were truncated", noToolResolver).intent).toBe("execute-and-verify");
  });

  it("does not classify non-prefix memory words as memory-capture", () => {
    const decision = classifyTaskIntent("Document memory:pressure behavior in scheduler", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });

  it("treats [verify] bracket prefix as execute-and-verify", () => {
    const decision = classifyTaskIntent("[verify] docs are up to date", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });

  it("does not guess intent from verification verbs alone", () => {
    const decision = classifyTaskIntent("Confirm all docs links resolve", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
  });

  it("treats tasks mentioning verify without explicit prefix as execute-and-verify", () => {
    const decision = classifyTaskIntent("Instrument verify-repair-loop to emit verification.result", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
  });

  it("defaults to execute-and-verify for implementation tasks", () => {
    const decision = classifyTaskIntent("Implement API schema validation and verify fixtures", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.normalizedTaskText).toBe("Implement API schema validation and verify fixtures");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("defaults to execute-and-verify for rundown delegate tasks", () => {
    const decision = classifyTaskIntent("rundown: Test.md --optional arg-val", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });

  it("classifies dynamic tool prefixes when resolver matches", () => {
    const toolResolver: ToolResolverPort = {
      resolve: (toolName) => toolName === "post-on-gitea"
        ? {
          name: "post-on-gitea",
          kind: "handler",
          templatePath: "/workspace/.rundown/tools/post-on-gitea.md",
          template: "Request: {{payload}}",
        }
        : undefined,
      listKnownToolNames: () => ["post-on-gitea"],
    };

    const decision = classifyTaskIntent("post-on-gitea: file auth issue", toolResolver);
    expect(decision.intent).toBe("tool-expansion");
    expect(decision.toolName).toBe("post-on-gitea");
    expect(decision.toolPayload).toBe("file auth issue");
    expect(decision.normalizedTaskText).toBe("file auth issue");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("flags empty payload for matched tool prefixes", () => {
    const toolResolver: ToolResolverPort = {
      resolve: () => ({
        name: "summarize",
        kind: "handler",
        templatePath: "/workspace/.rundown/tools/summarize.md",
        template: "{{payload}}",
      }),
      listKnownToolNames: () => ["summarize"],
    };

    const decision = classifyTaskIntent("summarize:   ", toolResolver);
    expect(decision.intent).toBe("tool-expansion");
    expect(decision.toolName).toBe("summarize");
    expect(decision.toolPayload).toBe("");
    expect(decision.hasEmptyPayload).toBe(true);
  });

  it("falls through to execute-and-verify when tool prefix is unknown", () => {
    const decision = classifyTaskIntent("unknown-tool: payload", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });

  it("classifies end: prefix as tool-expansion via built-in tool resolver", () => {
    const decision = classifyTaskIntent("end: no more output to process", builtinToolResolver);
    expect(decision.intent).toBe("tool-expansion");
    expect(decision.toolName).toBe("end");
    expect(decision.toolPayload).toBe("no more output to process");
    expect(decision.normalizedTaskText).toBe("no more output to process");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("classifies end control-flow prefixes through generic tool resolution", () => {
    const toolResolver: ToolResolverPort = {
      resolve: (toolName) => ["end", "return", "skip", "quit", "break"].includes(toolName)
        ? {
          name: toolName,
          kind: "handler",
          templatePath: `/workspace/.rundown/tools/${toolName}.md`,
          template: "{{payload}}",
        }
        : undefined,
      listKnownToolNames: () => ["end", "return", "skip", "quit", "break"],
    };

    const canonicalEnd = classifyTaskIntent("end: no more output to process", toolResolver);
    expect(canonicalEnd.intent).toBe("tool-expansion");
    expect(canonicalEnd.toolName).toBe("end");
    expect(canonicalEnd.toolPayload).toBe("no more output to process");

    const aliasReturn = classifyTaskIntent("return: stop sibling execution", toolResolver);
    expect(aliasReturn.intent).toBe("tool-expansion");
    expect(aliasReturn.toolName).toBe("return");

    const aliasSkip = classifyTaskIntent("skip: branch already satisfied", toolResolver);
    expect(aliasSkip.intent).toBe("tool-expansion");
    expect(aliasSkip.toolName).toBe("skip");

    const aliasQuit = classifyTaskIntent("quit: condition reached", toolResolver);
    expect(aliasQuit.intent).toBe("tool-expansion");
    expect(aliasQuit.toolName).toBe("quit");

    const aliasBreak = classifyTaskIntent("break: loop exit condition", toolResolver);
    expect(aliasBreak.intent).toBe("tool-expansion");
    expect(aliasBreak.toolName).toBe("break");
  });

  it("keeps built-in verify prefix precedence over tool resolver", () => {
    const toolResolver: ToolResolverPort = {
      resolve: () => ({
        name: "verify",
        kind: "handler",
        templatePath: "/workspace/.rundown/tools/verify.md",
        template: "{{payload}}",
      }),
      listKnownToolNames: () => ["verify"],
    };

    const decision = classifyTaskIntent("verify: confirm release", toolResolver);
    expect(decision.intent).toBe("verify-only");
    expect(decision.reason).toContain("explicit");
  });

  it("keeps built-in memory prefix precedence over tool resolver", () => {
    const toolResolver: ToolResolverPort = {
      resolve: () => ({
        name: "memory",
        kind: "handler",
        templatePath: "/workspace/.rundown/tools/memory.md",
        template: "{{payload}}",
      }),
      listKnownToolNames: () => ["memory"],
    };

    const decision = classifyTaskIntent("memory: capture context", toolResolver);
    expect(decision.intent).toBe("memory-capture");
    expect(decision.memoryCapturePrefix).toBe("memory");
  });

  it("applies intent precedence in order: verify -> memory -> fast -> tool -> default", () => {
    const toolResolver: ToolResolverPort = {
      resolve: (toolName) => toolName === "fast" || toolName === "deploy"
        ? {
          name: toolName,
          kind: "handler",
          templatePath: `/workspace/.rundown/tools/${toolName}.md`,
          template: "{{payload}}",
        }
        : undefined,
      listKnownToolNames: () => ["fast", "deploy"],
    };

    expect(classifyTaskIntent("verify: fast: check output", toolResolver).intent).toBe("verify-only");
    expect(classifyTaskIntent("memory: fast: capture context", toolResolver).intent).toBe("memory-capture");
    expect(classifyTaskIntent("fast: deploy to prod", toolResolver).intent).toBe("fast-execution");
    expect(classifyTaskIntent("deploy: release candidate", toolResolver).intent).toBe("tool-expansion");
    expect(classifyTaskIntent("just implement the feature", toolResolver).intent).toBe("execute-and-verify");
  });

  it("uses the first recognized intent prefix for mixed-prefix inputs", () => {
    const verifyFirst = classifyTaskIntent("verify: fast: run smoke checks", noToolResolver);
    expect(verifyFirst.intent).toBe("verify-only");
    expect(verifyFirst.normalizedTaskText).toBe("verify: fast: run smoke checks");

    const fastFirst = classifyTaskIntent("fast: verify: run smoke checks", noToolResolver);
    expect(fastFirst.intent).toBe("fast-execution");
    expect(fastFirst.normalizedTaskText).toBe("verify: run smoke checks");

    const memoryFirst = classifyTaskIntent("memory: fast: capture release notes", noToolResolver);
    expect(memoryFirst.intent).toBe("memory-capture");
    expect(memoryFirst.normalizedTaskText).toBe("fast: capture release notes");
  });

  it("parses parallel aliases in composed-prefix forms", () => {
    const parallelThenFast = classifyTaskIntent("parallel: fast: run smoke checks", noToolResolver);
    expect(parallelThenFast.intent).toBe("parallel-group");
    expect(parallelThenFast.normalizedTaskText).toBe("fast: run smoke checks");

    const verifyThenParallel = classifyTaskIntent("verify: parallel: run smoke checks", noToolResolver);
    expect(verifyThenParallel.intent).toBe("verify-only");
    expect(verifyThenParallel.normalizedTaskText).toBe("verify: parallel: run smoke checks");

    const memoryThenParallel = classifyTaskIntent("memory: parallel: capture release notes", noToolResolver);
    expect(memoryThenParallel.intent).toBe("memory-capture");
    expect(memoryThenParallel.normalizedTaskText).toBe("parallel: capture release notes");
  });
});
