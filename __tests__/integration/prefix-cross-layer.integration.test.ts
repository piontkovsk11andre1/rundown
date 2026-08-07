import { describe, expect, it, vi } from "vitest";
import { resolveIterationVerificationMode } from "../../src/application/iteration-mode.js";
import { resolveWorkerForInvocation } from "../../src/application/resolve-worker.js";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import { parseTasks, type Task } from "../../src/domain/parser.js";
import type { ToolResolverPort } from "../../src/domain/ports/tool-resolver-port.js";
import { parsePrefixChain } from "../../src/domain/prefix-chain.js";
import { classifyTaskIntent } from "../../src/domain/task-intent.js";

const builtinToolResolver: ToolResolverPort = {
  resolve: (toolName) => resolveBuiltinTool(toolName),
  listKnownToolNames: () => listBuiltinToolNames(),
};

function parseSingleTask(source: string): Task {
  const tasks = parseTasks(source, "tasks.md");
  expect(tasks).toHaveLength(1);
  return tasks[0]!;
}

describe("prefix behavior cross-layer integration", () => {
  it("keeps verify alias behavior stable from parser through iteration and worker routing", () => {
    const source = "- [ ] confirm: quick: release checklist\n";
    const task = parseSingleTask(source);

    const intent = classifyTaskIntent(task.text, builtinToolResolver);
    expect(intent.intent).toBe("verify-only");

    const chain = parsePrefixChain(task.text, builtinToolResolver);
    expect(chain.handler?.tool.name).toBe("confirm");
    expect(chain.handler?.payload).toBe("quick: release checklist");

    const emit = vi.fn();
    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task,
      toolResolver: builtinToolResolver,
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("verify-only");
    expect(mode.onlyVerify).toBe(true);
    expect(mode.shouldVerify).toBe(true);

    const workerCommand = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-default", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-run", "1"],
          verify: ["opencode", "run", "--from-verify", "1"],
        },
      },
      source,
      task,
      cliWorkerCommand: [],
      taskIntent: mode.taskIntentDecision.intent,
      toolName: mode.taskIntentDecision.toolName ?? mode.prefixChain.handler?.tool.name,
    });

    expect(workerCommand).toEqual(["opencode", "run", "--from-verify", "1"]);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task classified as verify-only (explicit marker); skipping execution.",
    });
  });

  it("keeps quick: verify precedence fast-first across classifier, mode, and worker selection", () => {
    const source = "- [ ] quick: verify: run smoke checks\n";
    const task = parseSingleTask(source);

    const intent = classifyTaskIntent(task.text, builtinToolResolver);
    expect(intent.intent).toBe("fast-execution");
    expect(intent.normalizedTaskText).toBe("verify: run smoke checks");

    const chain = parsePrefixChain(task.text, builtinToolResolver);
    expect(chain.handler).toBeUndefined();
    expect(chain.remainingText).toBe("quick: verify: run smoke checks");

    const emit = vi.fn();
    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: true,
      forceExecute: false,
      task,
      toolResolver: builtinToolResolver,
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("fast-execution");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);

    const workerCommand = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-default", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-run", "1"],
          verify: ["opencode", "run", "--from-verify", "1"],
        },
      },
      source,
      task,
      cliWorkerCommand: [],
      taskIntent: mode.taskIntentDecision.intent,
      toolName: mode.taskIntentDecision.toolName ?? mode.prefixChain.handler?.tool.name,
    });

    expect(workerCommand).toEqual(["opencode", "run", "--from-run", "1"]);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task uses fast/raw/quick intent (explicit fast marker); skipping verification.",
    });
  });

  it("routes each/foreach aliases through canonical for tool identity end-to-end", () => {
    const source = "- [ ] each: API endpoints\n";
    const task = parseSingleTask(source);

    const intent = classifyTaskIntent(task.text, builtinToolResolver);
    expect(intent.intent).toBe("tool-expansion");
    expect(intent.toolName).toBe("for");
    expect(intent.toolPayload).toBe("API endpoints");

    const chain = parsePrefixChain(task.text, builtinToolResolver);
    expect(chain.handler?.tool.name).toBe("for");
    expect(chain.handler?.payload).toBe("API endpoints");

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: false,
      forceExecute: false,
      task,
      toolResolver: builtinToolResolver,
      emit: vi.fn(),
    });

    expect(mode.taskIntentDecision.intent).toBe("tool-expansion");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);

    const workerCommand = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-default", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-run", "1"],
          "tools.for": ["opencode", "run", "--from-tools-for", "1"],
        },
      },
      source,
      task,
      cliWorkerCommand: [],
      taskIntent: mode.taskIntentDecision.intent,
      toolName: mode.taskIntentDecision.toolName ?? mode.prefixChain.handler?.tool.name,
    });

    expect(workerCommand).toEqual(["opencode", "run", "--from-tools-for", "1"]);
  });

  it("applies inherited quick directive intent through iteration mode and keeps commands.run routing", () => {
    const source = [
      "- quick:",
      "  - [ ] Publish changelog",
    ].join("\n");
    const task = parseSingleTask(source);

    expect(task.text).toBe("Publish changelog");
    expect(task.intent).toBe("fast-execution");

    const intent = classifyTaskIntent(task.text, builtinToolResolver);
    expect(intent.intent).toBe("execute-and-verify");

    const chain = parsePrefixChain(task.text, builtinToolResolver);
    expect(chain.handler).toBeUndefined();

    const emit = vi.fn();
    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: true,
      forceExecute: false,
      task,
      toolResolver: builtinToolResolver,
      emit,
    });

    expect(mode.taskIntentDecision.intent).toBe("fast-execution");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(false);
    expect(emit).toHaveBeenCalledWith({
      kind: "info",
      message: "Task uses fast/raw/quick intent (inherited directive intent); skipping verification.",
    });

    const workerCommand = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-default", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-run", "1"],
          verify: ["opencode", "run", "--from-verify", "1"],
        },
      },
      source,
      task,
      cliWorkerCommand: [],
      taskIntent: mode.taskIntentDecision.intent,
      toolName: mode.taskIntentDecision.toolName ?? mode.prefixChain.handler?.tool.name,
    });

    expect(workerCommand).toEqual(["opencode", "run", "--from-run", "1"]);
  });

  it("keeps unknown prefix text on execute-and-verify path across all layers", () => {
    const source = "- [ ] unknown-prefix: payload text\n";
    const task = parseSingleTask(source);

    const intent = classifyTaskIntent(task.text, builtinToolResolver);
    expect(intent.intent).toBe("execute-and-verify");
    expect(intent.reason).toBe("default");

    const chain = parsePrefixChain(task.text, builtinToolResolver);
    expect(chain.handler).toBeUndefined();
    expect(chain.modifiers).toEqual([]);

    const mode = resolveIterationVerificationMode({
      configuredOnlyVerify: false,
      configuredShouldVerify: true,
      forceExecute: false,
      task,
      toolResolver: builtinToolResolver,
      emit: vi.fn(),
    });

    expect(mode.taskIntentDecision.intent).toBe("execute-and-verify");
    expect(mode.onlyVerify).toBe(false);
    expect(mode.shouldVerify).toBe(true);

    const workerCommand = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-default", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-run", "1"],
          "tools.unknown-prefix": ["opencode", "run", "--from-tools-unknown", "1"],
        },
      },
      source,
      task,
      cliWorkerCommand: [],
      taskIntent: mode.taskIntentDecision.intent,
      toolName: mode.taskIntentDecision.toolName ?? mode.prefixChain.handler?.tool.name,
    });

    expect(workerCommand).toEqual(["opencode", "run", "--from-run", "1"]);
  });
});
