import { describe, expect, it, vi } from "vitest";
import { resolveIterationVerificationMode } from "../../src/application/iteration-mode.js";
import type { Task } from "../../src/domain/parser.js";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import type { ToolResolverPort } from "../../src/domain/ports/tool-resolver-port.js";
import {
  FAST_PREFIX_ALIASES,
  MEMORY_PREFIX_ALIASES,
  VERIFY_PREFIX_ALIASES,
} from "../helpers/prefix-aliases.js";

const builtinToolResolver: ToolResolverPort = {
  resolve: (toolName) => resolveBuiltinTool(toolName),
  listKnownToolNames: () => listBuiltinToolNames(),
};

function createTask(text: string): Task {
  return {
    text,
    checked: false,
    index: 0,
    line: 1,
    column: 1,
    offsetStart: 0,
    offsetEnd: text.length,
    file: "tasks.md",
    isInlineCli: false,
    depth: 0,
    children: [],
    subItems: [],
  };
}

describe("resolveIterationVerificationMode", () => {
  it.each(["fast", "raw", "quick"])("suppresses verification for %s tasks when configuredShouldVerify is enabled", (prefix) => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: true,
      forceExecute: false,
      task: createTask(`${prefix}: ship release notes`),
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("fast-execution");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task uses fast/raw/quick intent (explicit fast marker); skipping verification.",
    });
  });

  it.each(["fast", "raw", "quick"])("treats empty-payload %s prefixes as fast-execution and still skips verification", (prefix) => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: true,
      forceExecute: false,
      task: createTask(`${prefix}:   `),
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("fast-execution");
    expect(mode.taskIntentDecision.hasEmptyPayload).toBe(true);
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task uses fast/raw/quick intent (explicit fast marker); skipping verification.",
    });
  });

  it("suppresses verification for fast tasks when configuredOnlyVerify is enabled", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: true,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("fast: ship release notes"),
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("fast-execution");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task uses fast/raw/quick intent (explicit fast marker); skipping verification.",
    });
  });

  it("suppresses verification for tasks with inherited fast-execution directive intent", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: true,
      forceExecute: false,
      task: {
        ...createTask("Ship release notes"),
        intent: "fast-execution",
      },
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("fast-execution");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task uses fast/raw/quick intent (inherited directive intent); skipping verification.",
    });
  });

  it("keeps verify-only behavior unchanged for verify-prefixed tasks", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("verify: confirm changelog is complete"),
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("verify-only");
    expect(mode.onlyVerify).toBe(true);
    expect(mode.shouldVerify).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task classified as verify-only (explicit marker); skipping execution.",
    });
  });

  it("respects force-execute for verify-only tasks and reports the override", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: true,
      task: createTask("check: confirm changelog is complete"),
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("verify-only");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task classified as verify-only (explicit marker), but --force-execute is enabled; running execution.",
    });
  });

  it("keeps memory-prefixed tasks in execute mode unless verification is configured", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("memory: capture release summary"),
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("memory-capture");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("keeps non-prefixed tasks on default execute path", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("Ship release notes"),
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("execute-and-verify");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("normalizes localized memory prefix before classification", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("记忆: capture release summary"),
      localeAliases: {
        "记忆:": "memory:",
      },
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("memory-capture");
    expect(mode.taskIntentDecision.normalizedTaskText).toBe("capture release summary");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("normalizes localized verify prefix before classification", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("验证: confirm changelog is complete"),
      localeAliases: {
        "验证:": "verify:",
      },
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("verify-only");
    expect(mode.onlyVerify).toBe(true);
    expect(mode.shouldVerify).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task classified as verify-only (explicit marker); skipping execution.",
    });
  });

  it("does not classify localized prefixes when locale aliases are not provided", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("记忆: capture release summary"),
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("execute-and-verify");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).not.toHaveBeenCalled();
  });

  it("applies verify-only mode for composed chains routed by prefix handler metadata", () => {
    const emit = vi.fn();

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("profile=release, verify: confirm changelog is complete"),
      toolResolver: builtinToolResolver,
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("execute-and-verify");
    expect(mode.prefixChain.modifiers).toHaveLength(1);
    expect(mode.prefixChain.modifiers[0]?.tool.name).toBe("profile");
    expect(mode.prefixChain.handler?.tool.name).toBe("verify");
    expect(mode.onlyVerify).toBe(true);
    expect(mode.shouldVerify).toBe(true);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task classified as verify-only (default); skipping execution.",
    });
  });

  it("preserves explicit prefix precedence for verify: quick and quick: verify forms", () => {
    const emitVerifyThenQuick = vi.fn();
    const verifyThenQuickMode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("verify: quick: run smoke checks"),
      emit: emitVerifyThenQuick,
    });
    expect(verifyThenQuickMode.taskIntentDecision.intent).toBe("verify-only");
    expect(verifyThenQuickMode.onlyVerify).toBe(true);
    expect(verifyThenQuickMode.shouldVerify).toBe(true);

    const emitQuickThenVerify = vi.fn();
    const quickThenVerifyMode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task: createTask("quick: verify: run smoke checks"),
      emit: emitQuickThenVerify,
    });
    expect(quickThenVerifyMode.taskIntentDecision.intent).toBe("fast-execution");
    expect(quickThenVerifyMode.onlyVerify).toBe(false);
    expect(quickThenVerifyMode.shouldVerify).toBe(false);
  });

  it("keeps explicit prefix behavior stable when resolver exposes same-name tools", () => {
    const allAliases = new Set<string>([
      ...VERIFY_PREFIX_ALIASES,
      ...MEMORY_PREFIX_ALIASES,
      ...FAST_PREFIX_ALIASES,
    ]);
    const sameNameResolver: ToolResolverPort = {
      resolve: (toolName) => {
        const normalized = toolName.trim().toLowerCase();
        return allAliases.has(normalized)
          ? {
            name: normalized,
            kind: "handler",
            frontmatter: { skipExecution: false, shouldVerify: false },
          }
          : undefined;
      },
      listKnownToolNames: () => Array.from(allAliases),
    };

    for (const alias of VERIFY_PREFIX_ALIASES) {
      const mode = resolveIterationVerificationMode({
        configuredOnlyVerify: false,
        configuredShouldVerify: false,
        forceExecute: false,
        task: createTask(`${alias}: check release notes`),
        toolResolver: sameNameResolver,
        emit: vi.fn(),
      });
      expect(mode.taskIntentDecision.intent).toBe("verify-only");
      expect(mode.onlyVerify).toBe(true);
      expect(mode.shouldVerify).toBe(true);
    }

    for (const alias of MEMORY_PREFIX_ALIASES) {
      const mode = resolveIterationVerificationMode({
        configuredOnlyVerify: false,
        configuredShouldVerify: false,
        forceExecute: false,
        task: createTask(`${alias}: capture release context`),
        toolResolver: sameNameResolver,
        emit: vi.fn(),
      });
      expect(mode.taskIntentDecision.intent).toBe("memory-capture");
      expect(mode.onlyVerify).toBe(false);
      expect(mode.shouldVerify).toBe(false);
    }

    for (const alias of FAST_PREFIX_ALIASES) {
      const mode = resolveIterationVerificationMode({
        configuredOnlyVerify: false,
        configuredShouldVerify: true,
        forceExecute: false,
        task: createTask(`${alias}: ship release notes`),
        toolResolver: sameNameResolver,
        emit: vi.fn(),
      });
      expect(mode.taskIntentDecision.intent).toBe("fast-execution");
      expect(mode.onlyVerify).toBe(false);
      expect(mode.shouldVerify).toBe(false);
    }
  });

  it("keeps verify, memory, and fast alias groups behaviorally equivalent", () => {
    const run = (taskText: string, configuredShouldVerify: boolean) => {
      const emit = vi.fn();
      const mode = resolveIterationVerificationMode({
        configuredOnlyVerify: false,
        configuredShouldVerify,
        forceExecute: false,
        task: createTask(taskText),
        emit,
      });
      return { mode, emit };
    };

    const verifyCanonical = run(`${VERIFY_PREFIX_ALIASES[0]}: confirm release notes`, false);
    for (const alias of VERIFY_PREFIX_ALIASES) {
      const { mode, emit } = run(`${alias}: confirm release notes`, false);
      expect(mode.taskIntentDecision.intent).toBe(verifyCanonical.mode.taskIntentDecision.intent);
      expect(mode.onlyVerify).toBe(verifyCanonical.mode.onlyVerify);
      expect(mode.shouldVerify).toBe(verifyCanonical.mode.shouldVerify);
      expect(emit).toHaveBeenCalledWith({
        kind: "info",
        message: "Task classified as verify-only (explicit marker); skipping execution.",
      });
    }

    const memoryCanonical = run(`${MEMORY_PREFIX_ALIASES[0]}: capture release summary`, false);
    for (const alias of MEMORY_PREFIX_ALIASES) {
      const { mode, emit } = run(`${alias}: capture release summary`, false);
      expect(mode.taskIntentDecision.intent).toBe(memoryCanonical.mode.taskIntentDecision.intent);
      expect(mode.onlyVerify).toBe(memoryCanonical.mode.onlyVerify);
      expect(mode.shouldVerify).toBe(memoryCanonical.mode.shouldVerify);
      expect(emit).not.toHaveBeenCalled();
    }

    const fastCanonical = run(`${FAST_PREFIX_ALIASES[0]}: ship release notes`, true);
    for (const alias of FAST_PREFIX_ALIASES) {
      const { mode, emit } = run(`${alias}: ship release notes`, true);
      expect(mode.taskIntentDecision.intent).toBe(fastCanonical.mode.taskIntentDecision.intent);
      expect(mode.onlyVerify).toBe(fastCanonical.mode.onlyVerify);
      expect(mode.shouldVerify).toBe(fastCanonical.mode.shouldVerify);
      expect(emit).toHaveBeenCalledWith({
        kind: "info",
        message: "Task uses fast/raw/quick intent (explicit fast marker); skipping verification.",
      });
    }
  });
});
