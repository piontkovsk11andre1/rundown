import { describe, expect, it } from "vitest";
import { classifyTaskIntent, normalizeLocaleKeyword } from "../../src/domain/task-intent.js";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import type { ToolResolverPort } from "../../src/domain/ports/tool-resolver-port.js";
import {
  FAST_PREFIX_ALIASES,
  MEMORY_PREFIX_ALIASES,
  PARALLEL_PREFIX_ALIASES,
  VERIFY_PREFIX_ALIASES,
} from "../helpers/prefix-aliases.js";

const noToolResolver: ToolResolverPort = {
  resolve: () => undefined,
  listKnownToolNames: () => [],
};

const builtinToolResolver: ToolResolverPort = {
  resolve: (toolName) => resolveBuiltinTool(toolName),
  listKnownToolNames: () => listBuiltinToolNames(),
};

describe("classifyTaskIntent", () => {
  const verifyAliases = VERIFY_PREFIX_ALIASES;
  const memoryAliases = MEMORY_PREFIX_ALIASES;
  const fastAliases = FAST_PREFIX_ALIASES;
  const parallelAliases = PARALLEL_PREFIX_ALIASES;

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

  it("classifies fast:/raw:/quick: prefixes as fast-execution", () => {
    const fastDecision = classifyTaskIntent("fast: run release script", noToolResolver);
    expect(fastDecision.intent).toBe("fast-execution");
    expect(fastDecision.reason).toBe("explicit fast marker");
    expect(fastDecision.normalizedTaskText).toBe("run release script");

    const rawDecision = classifyTaskIntent("raw: run release script", noToolResolver);
    expect(rawDecision.intent).toBe("fast-execution");
    expect(rawDecision.reason).toBe("explicit fast marker");
    expect(rawDecision.normalizedTaskText).toBe("run release script");

    const quickDecision = classifyTaskIntent("quick: run release script", noToolResolver);
    expect(quickDecision.intent).toBe("fast-execution");
    expect(quickDecision.reason).toBe("explicit fast marker");
    expect(quickDecision.normalizedTaskText).toBe("run release script");
  });

  it("matches fast aliases case-insensitively with colon spacing", () => {
    expect(classifyTaskIntent("FAST: compile docs", noToolResolver).intent).toBe("fast-execution");
    expect(classifyTaskIntent("Raw : refresh fixtures", noToolResolver).intent).toBe("fast-execution");
    expect(classifyTaskIntent("Quick : refresh fixtures", noToolResolver).intent).toBe("fast-execution");
    expect(classifyTaskIntent("fAsT:\tdeploy preview", noToolResolver).intent).toBe("fast-execution");
  });

  it("trims fast payload text and flags empty payloads", () => {
    expect(classifyTaskIntent("  fast:   run smoke tests  ", noToolResolver).normalizedTaskText).toBe("run smoke tests");
    expect(classifyTaskIntent("raw:\n  collect logs", noToolResolver).normalizedTaskText).toBe("collect logs");
    expect(classifyTaskIntent("quick:\n  collect logs", noToolResolver).normalizedTaskText).toBe("collect logs");

    expect(classifyTaskIntent("fast:", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("raw:   ", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("quick:   ", noToolResolver).hasEmptyPayload).toBe(true);
    expect(classifyTaskIntent("FAST :\n\t", noToolResolver).hasEmptyPayload).toBe(true);
  });

  it("does not classify plain text containing fast/raw/quick words as fast-execution", () => {
    expect(classifyTaskIntent("fast forward these docs", noToolResolver).intent).toBe("execute-and-verify");
    expect(classifyTaskIntent("raw logs were truncated", noToolResolver).intent).toBe("execute-and-verify");
    expect(classifyTaskIntent("quick wins are documented", noToolResolver).intent).toBe("execute-and-verify");
  });

  it("does not classify non-prefix memory words as memory-capture", () => {
    const decision = classifyTaskIntent("Document memory:pressure behavior in scheduler", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });

  it.each([
    "Please verify the migration checklist before merge",
    "The memory footprint regressed after parser changes",
    "Need to move fast when triaging flaky tests",
    "We should run setup in parallel after dependencies install",
  ])("treats plain sentence '%s' as execute-and-verify", (taskText) => {
    const decision = classifyTaskIntent(taskText, noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
    expect(decision.normalizedTaskText).toBe(taskText);
    expect(decision.hasEmptyPayload).toBe(false);
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

  it("classifies empty-payload tool prefixes as tool-expansion when resolver matches", () => {
    const toolResolver: ToolResolverPort = {
      resolve: (toolName) => toolName.trim().toLowerCase() === "deploy"
        ? {
          name: "deploy",
          kind: "handler",
          templatePath: "/workspace/.rundown/tools/deploy.md",
          template: "{{payload}}",
        }
        : undefined,
      listKnownToolNames: () => ["deploy"],
    };

    const canonical = classifyTaskIntent("deploy:", toolResolver);
    expect(canonical.intent).toBe("tool-expansion");
    expect(canonical.toolName).toBe("deploy");
    expect(canonical.toolPayload).toBe("");
    expect(canonical.normalizedTaskText).toBe("");
    expect(canonical.hasEmptyPayload).toBe(true);

    const spaced = classifyTaskIntent("  Deploy :   ", toolResolver);
    expect(spaced.intent).toBe("tool-expansion");
    expect(spaced.toolName).toBe("deploy");
    expect(spaced.toolPayload).toBe("");
    expect(spaced.normalizedTaskText).toBe("");
    expect(spaced.hasEmptyPayload).toBe(true);
  });

  it("falls through to execute-and-verify when tool prefix is unknown", () => {
    const decision = classifyTaskIntent("unknown-tool: payload", noToolResolver);
    expect(decision.intent).toBe("execute-and-verify");
    expect(decision.reason).toBe("default");
  });

  it("classifies optional: prefix as tool-expansion via built-in tool resolver", () => {
    const decision = classifyTaskIntent("optional: no more output to process", builtinToolResolver);
    expect(decision.intent).toBe("tool-expansion");
    expect(decision.toolName).toBe("optional");
    expect(decision.toolPayload).toBe("no more output to process");
    expect(decision.normalizedTaskText).toBe("no more output to process");
    expect(decision.hasEmptyPayload).toBe(false);
  });

  it("classifies optional/skip control-flow prefixes and legacy aliases through generic tool resolution", () => {
    const toolResolver: ToolResolverPort = {
      resolve: (toolName) => ["optional", "skip", "end", "return", "quit", "break"].includes(toolName)
        ? {
          name: toolName,
          kind: "handler",
          templatePath: `/workspace/.rundown/tools/${toolName}.md`,
          template: "{{payload}}",
        }
        : undefined,
      listKnownToolNames: () => ["optional", "skip", "end", "return", "quit", "break"],
    };

    const canonicalOptional = classifyTaskIntent("optional: no more output to process", toolResolver);
    expect(canonicalOptional.intent).toBe("tool-expansion");
    expect(canonicalOptional.toolName).toBe("optional");
    expect(canonicalOptional.toolPayload).toBe("no more output to process");

    const preferredAliasSkip = classifyTaskIntent("skip: branch already satisfied", toolResolver);
    expect(preferredAliasSkip.intent).toBe("tool-expansion");
    expect(preferredAliasSkip.toolName).toBe("skip");

    const aliasReturn = classifyTaskIntent("return: stop sibling execution", toolResolver);
    expect(aliasReturn.intent).toBe("tool-expansion");
    expect(aliasReturn.toolName).toBe("return");

    const aliasEnd = classifyTaskIntent("end: no more output to process", toolResolver);
    expect(aliasEnd.intent).toBe("tool-expansion");
    expect(aliasEnd.toolName).toBe("end");

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

  it("keeps explicit prefix alias handling stable when resolver exposes same-name tools", () => {
    const sameNamePrefixes = [...verifyAliases, ...memoryAliases, ...fastAliases, ...parallelAliases];
    const toolResolver: ToolResolverPort = {
      resolve: (toolName) => {
        const normalized = toolName.trim().toLowerCase();
        return sameNamePrefixes.includes(normalized as (typeof sameNamePrefixes)[number])
          ? {
            name: normalized,
            kind: "handler",
            templatePath: `/workspace/.rundown/tools/${normalized}.md`,
            template: "{{payload}}",
            frontmatter: { skipExecution: false, shouldVerify: false },
          }
          : undefined;
      },
      listKnownToolNames: () => sameNamePrefixes,
    };

    for (const alias of verifyAliases) {
      const decision = classifyTaskIntent(`${alias}: validate release notes`, toolResolver);
      expect(decision.intent).toBe("verify-only");
      expect(decision.reason).toBe("explicit marker");
      expect(decision.toolName).toBeUndefined();
      expect(decision.toolPayload).toBeUndefined();
    }

    for (const alias of memoryAliases) {
      const decision = classifyTaskIntent(`${alias}: capture release notes`, toolResolver);
      expect(decision.intent).toBe("memory-capture");
      expect(decision.reason).toBe("explicit memory marker");
      expect(decision.memoryCapturePrefix).toBe(alias);
      expect(decision.toolName).toBeUndefined();
      expect(decision.toolPayload).toBeUndefined();
    }

    for (const alias of fastAliases) {
      const decision = classifyTaskIntent(`${alias}: run release checks`, toolResolver);
      expect(decision.intent).toBe("fast-execution");
      expect(decision.reason).toBe("explicit fast marker");
      expect(decision.toolName).toBeUndefined();
      expect(decision.toolPayload).toBeUndefined();
    }

    for (const alias of parallelAliases) {
      const decision = classifyTaskIntent(`${alias}: run child tasks`, toolResolver);
      expect(decision.intent).toBe("parallel-group");
      expect(decision.reason).toBe("explicit parallel marker");
      expect(decision.toolName).toBeUndefined();
      expect(decision.toolPayload).toBeUndefined();
    }
  });

  it("applies intent precedence in order: verify -> memory -> fast aliases -> tool -> default", () => {
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
    expect(classifyTaskIntent("quick: deploy to prod", toolResolver).intent).toBe("fast-execution");
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

    const quickFirst = classifyTaskIntent("quick: verify: run smoke checks", noToolResolver);
    expect(quickFirst.intent).toBe("fast-execution");
    expect(quickFirst.normalizedTaskText).toBe("verify: run smoke checks");

    const memoryFirst = classifyTaskIntent("memory: fast: capture release notes", noToolResolver);
    expect(memoryFirst.intent).toBe("memory-capture");
    expect(memoryFirst.normalizedTaskText).toBe("fast: capture release notes");
  });

  it("locks explicit precedence for verify: quick and quick: verify chains", () => {
    const verifyThenQuick = classifyTaskIntent("verify: quick: run smoke checks", noToolResolver);
    expect(verifyThenQuick.intent).toBe("verify-only");
    expect(verifyThenQuick.reason).toBe("explicit marker");
    expect(verifyThenQuick.normalizedTaskText).toBe("verify: quick: run smoke checks");
    expect(verifyThenQuick.hasEmptyPayload).toBe(false);

    const quickThenVerify = classifyTaskIntent("quick: verify: run smoke checks", noToolResolver);
    expect(quickThenVerify.intent).toBe("fast-execution");
    expect(quickThenVerify.reason).toBe("explicit fast marker");
    expect(quickThenVerify.normalizedTaskText).toBe("verify: run smoke checks");
    expect(quickThenVerify.hasEmptyPayload).toBe(false);
  });

  it("keeps alias behavior in parity with canonical prefixes", () => {
    for (const alias of verifyAliases) {
      const decision = classifyTaskIntent(`${alias}: release checklist`, noToolResolver);
      expect(decision.intent).toBe("verify-only");
      expect(decision.reason).toContain("explicit");
      expect(decision.hasEmptyPayload).toBe(false);
    }

    for (const alias of memoryAliases) {
      const decision = classifyTaskIntent(`${alias}: capture release checklist`, noToolResolver);
      expect(decision.intent).toBe("memory-capture");
      expect(decision.normalizedTaskText).toBe("capture release checklist");
      expect(decision.hasEmptyPayload).toBe(false);
      expect(decision.memoryCapturePrefix).toBe(alias);
    }

    for (const alias of fastAliases) {
      const decision = classifyTaskIntent(`${alias}: run release checklist`, noToolResolver);
      expect(decision.intent).toBe("fast-execution");
      expect(decision.reason).toBe("explicit fast marker");
      expect(decision.normalizedTaskText).toBe("run release checklist");
      expect(decision.hasEmptyPayload).toBe(false);
    }

    for (const alias of parallelAliases) {
      const decision = classifyTaskIntent(`${alias}: run release checklist`, noToolResolver);
      expect(decision.intent).toBe("parallel-group");
      expect(decision.reason).toBe("explicit parallel marker");
      expect(decision.normalizedTaskText).toBe("run release checklist");
      expect(decision.hasEmptyPayload).toBe(false);
    }
  });

  it("normalizes case and spacing consistently across alias groups", () => {
    for (const alias of verifyAliases) {
      const decision = classifyTaskIntent(`  ${alias.toUpperCase()}   :\tverify output`, noToolResolver);
      expect(decision.intent).toBe("verify-only");
      expect(decision.normalizedTaskText).toContain(":\tverify output");
    }

    for (const alias of memoryAliases) {
      const decision = classifyTaskIntent(`  ${alias.toUpperCase()}   :\n  persist output`, noToolResolver);
      expect(decision.intent).toBe("memory-capture");
      expect(decision.normalizedTaskText).toBe("persist output");
    }

    for (const alias of fastAliases) {
      const decision = classifyTaskIntent(`  ${alias.toUpperCase()}   :\n  skip verify`, noToolResolver);
      expect(decision.intent).toBe("fast-execution");
      expect(decision.normalizedTaskText).toBe("skip verify");
    }

    for (const alias of parallelAliases) {
      const decision = classifyTaskIntent(`  ${alias.toUpperCase()}   :\n  run siblings`, noToolResolver);
      expect(decision.intent).toBe("parallel-group");
      expect(decision.normalizedTaskText).toBe("run siblings");
    }
  });

  it("handles empty payloads consistently for all prefix groups", () => {
    for (const alias of verifyAliases) {
      const decision = classifyTaskIntent(`${alias}:   `, noToolResolver);
      expect(decision.intent).toBe("verify-only");
      expect(decision.normalizedTaskText).toBe(`${alias}:`);
      expect(decision.hasEmptyPayload).toBe(false);
    }

    for (const alias of memoryAliases) {
      const decision = classifyTaskIntent(`${alias}:   `, noToolResolver);
      expect(decision.intent).toBe("memory-capture");
      expect(decision.normalizedTaskText).toBe("");
      expect(decision.hasEmptyPayload).toBe(true);
    }

    for (const alias of fastAliases) {
      const decision = classifyTaskIntent(`${alias}:   `, noToolResolver);
      expect(decision.intent).toBe("fast-execution");
      expect(decision.normalizedTaskText).toBe("");
      expect(decision.hasEmptyPayload).toBe(true);
    }

    for (const alias of parallelAliases) {
      const decision = classifyTaskIntent(`${alias}:   `, noToolResolver);
      expect(decision.intent).toBe("parallel-group");
      expect(decision.normalizedTaskText).toBe("");
      expect(decision.hasEmptyPayload).toBe(true);
    }
  });

  it("uses the first recognized prefix when multiple alias groups are chained", () => {
    const verifyThenQuick = classifyTaskIntent("confirm: quick: run smoke checks", noToolResolver);
    expect(verifyThenQuick.intent).toBe("verify-only");

    const quickThenVerify = classifyTaskIntent("quick: check: run smoke checks", noToolResolver);
    expect(quickThenVerify.intent).toBe("fast-execution");
    expect(quickThenVerify.normalizedTaskText).toBe("check: run smoke checks");

    const memoryThenParallel = classifyTaskIntent("remember: parallel: capture release notes", noToolResolver);
    expect(memoryThenParallel.intent).toBe("memory-capture");
    expect(memoryThenParallel.normalizedTaskText).toBe("parallel: capture release notes");

    const parallelThenMemory = classifyTaskIntent("concurrent: memory: capture release notes", noToolResolver);
    expect(parallelThenMemory.intent).toBe("parallel-group");
    expect(parallelThenMemory.normalizedTaskText).toBe("memory: capture release notes");
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

describe("normalizeLocaleKeyword", () => {
  it("replaces a localized prefix alias with a canonical prefix", () => {
    const normalized = normalizeLocaleKeyword("记忆: capture this context", {
      "记忆:": "memory:",
    });

    expect(normalized).toBe("memory: capture this context");
  });

  it("matches aliases case-insensitively and preserves leading whitespace", () => {
    const normalized = normalizeLocaleKeyword("  FASTO: run this quickly", {
      "fasto:": "fast:",
    });

    expect(normalized).toBe("  fast: run this quickly");
  });

  it("uses the longest matching alias when prefixes overlap", () => {
    const normalized = normalizeLocaleKeyword("pref-long: payload", {
      "pref:": "fast:",
      "pref-long:": "memory:",
    });

    expect(normalized).toBe("memory: payload");
  });

  it("returns the original text when no alias matches", () => {
    const normalized = normalizeLocaleKeyword("verify: release checklist", {
      "记忆:": "memory:",
    });

    expect(normalized).toBe("verify: release checklist");
  });

  it("ignores empty aliases and empty canonical targets", () => {
    const normalized = normalizeLocaleKeyword("记忆: capture this context", {
      "": "memory:",
      "记忆:": "",
    });

    expect(normalized).toBe("记忆: capture this context");
  });
});
