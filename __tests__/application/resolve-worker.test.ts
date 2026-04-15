import { describe, expect, it } from "vitest";
import {
  resolveWorkerForInvocation,
  resolveWorkerPatternForInvocation,
} from "../../src/application/resolve-worker.js";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import { classifyTaskIntent } from "../../src/domain/task-intent.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";
import type { ToolResolverPort } from "../../src/domain/ports/tool-resolver-port.js";
import {
  WORKER_HEALTH_STATUS_COOLING_DOWN,
  WORKER_HEALTH_STATUS_UNAVAILABLE,
  buildWorkerHealthProfileKey,
  buildWorkerHealthWorkerKey,
} from "../../src/domain/worker-health.js";

const builtinToolResolver: ToolResolverPort = {
  resolve: (toolName) => resolveBuiltinTool(toolName),
  listKnownToolNames: () => listBuiltinToolNames(),
};

describe("resolve-worker", () => {
  it("resolves worker from config layers and warns on ignored profile sub-item", () => {
    const events: ApplicationOutputEvent[] = [];

    const command = resolveWorkerForInvocation({
      commandName: "discuss",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
        },
        commands: {
          discuss: ["opencode", "discuss", "--base", "1"],
        },
        profiles: {
          complex: ["opencode", "run", "--model", "opus-4.6"],
          fast: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
      },
      source: "---\nprofile: complex\n---\n\n- [ ] discuss item\n",
      task: {
        directiveProfile: "fast",
        subItems: [{ text: "profile=ignored", line: 2, depth: 1 }],
      },
      cliWorkerCommand: [],
      emit: (event) => events.push(event),
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--model",
      "gpt-5.3-codex",
    ]);
    expect(events.some((event) => event.kind === "warn"
      && event.message === "\"profile=ignored\" as a task sub-item is not supported — use it as a parent list item or in file frontmatter.")).toBe(true);
  });

  it("emits worker source description only when verbose is true", () => {
    const events: ApplicationOutputEvent[] = [];

    resolveWorkerForInvocation({
      commandName: "discuss",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
        },
      },
      source: "- [ ] discuss item\n",
      cliWorkerCommand: [],
      emit: (event) => events.push(event),
      verbose: true,
    });

    expect(events.some((event) => event.kind === "info"
      && event.message === "opencode run (from config workers.default)")).toBe(true);
  });

  it("does not emit config worker resolution feedback when CLI worker is provided", () => {
    const events: ApplicationOutputEvent[] = [];

    const command = resolveWorkerForInvocation({
      commandName: "plan",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
        },
      },
      source: "- [ ] draft plan\n",
      cliWorkerCommand: ["custom", "worker"],
      emit: (event) => events.push(event),
    });

    expect(command).toEqual(["custom", "worker"]);
    expect(events.some((event) => event.kind === "info")).toBe(false);
  });

  it("uses fallback worker command when config and CLI resolve to empty", () => {
    const command = resolveWorkerForInvocation({
      commandName: "reverify",
      workerConfig: undefined,
      source: "- [ ] sample\n",
      cliWorkerCommand: [],
      fallbackWorkerCommand: ["opencode", "run", "--model", "gpt-5.3-codex"],
    });

    expect(command).toEqual(["opencode", "run", "--model", "gpt-5.3-codex"]);
  });

  it("uses commands.tools.{toolName} override for tool-expansion tasks", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
        commands: {
          run: ["opencode", "run", "--effort", "medium"],
          "tools.post-on-gitea": ["opencode", "run", "--model", "gpt-5.3-mini", "--no-approval"],
        },
      },
      source: "- [ ] post-on-gitea: payload\n",
      cliWorkerCommand: [],
      taskIntent: "tool-expansion",
      toolName: "post-on-gitea",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--model",
      "gpt-5.3-mini",
      "--no-approval",
    ]);
  });

  it("derives commands.verify override key from verify alias prefixes", () => {
    const intent = classifyTaskIntent("check: release checklist", builtinToolResolver);
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
          verify: ["opencode", "run", "--from-commands-verify", "1"],
        },
      },
      source: "- [ ] check: release checklist\n",
      cliWorkerCommand: [],
      taskIntent: intent.intent,
      toolName: intent.toolName,
    });

    expect(intent.intent).toBe("verify-only");
    expect(command).toEqual(["opencode", "run", "--from-commands-verify", "1"]);
  });

  it("derives commands.memory override key from memory alias prefixes", () => {
    const intent = classifyTaskIntent("remember: capture release context", builtinToolResolver);
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
          memory: ["opencode", "run", "--from-commands-memory", "1"],
        },
      },
      source: "- [ ] remember: capture release context\n",
      cliWorkerCommand: [],
      taskIntent: intent.intent,
      toolName: intent.toolName,
    });

    expect(intent.intent).toBe("memory-capture");
    expect(command).toEqual(["opencode", "run", "--from-commands-memory", "1"]);
  });

  it("derives commands.tools.<canonicalName> override key from tool aliases", () => {
    const intent = classifyTaskIntent("each: item in releaseFiles => verify: item", builtinToolResolver);
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
          "tools.for": ["opencode", "run", "--from-commands-tools-for", "1"],
        },
      },
      source: "- [ ] each: item in releaseFiles => verify: item\n",
      cliWorkerCommand: [],
      taskIntent: intent.intent,
      toolName: intent.toolName,
    });

    expect(intent.intent).toBe("tool-expansion");
    expect(intent.toolName).toBe("for");
    expect(command).toEqual(["opencode", "run", "--from-commands-tools-for", "1"]);
  });

  it("applies tool-expansion profile precedence — last override wins", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
          "tools.post-on-gitea": ["opencode", "run", "--from-commands-tools", "1"],
        },
        profiles: {
          fileProfile: ["opencode", "run", "--from-frontmatter", "1"],
          directiveProfile: ["opencode", "run", "--from-directive", "1"],
          taskProfile: ["opencode", "run", "--from-task-inline", "1"],
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] post-on-gitea: payload\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile=taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "tool-expansion",
      toolName: "post-on-gitea",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-task-inline",
      "1",
    ]);
  });

  it("uses CLI worker for tool-expansion tasks over all config sources", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
        },
        commands: {
          "tools.post-on-gitea": ["opencode", "run", "--from-commands-tools", "1"],
        },
      },
      source: "- [ ] post-on-gitea: payload\n",
      task: {
        directiveProfile: undefined,
        taskProfile: undefined,
        subItems: [],
      },
      cliWorkerCommand: ["custom", "worker", "--model", "gpt-5.3-codex"],
      taskIntent: "tool-expansion",
      toolName: "post-on-gitea",
    });

    expect(command).toEqual(["custom", "worker", "--model", "gpt-5.3-codex"]);
  });

  it("applies taskProfile after directiveProfile for verify-only prefix tasks", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
        },
        profiles: {
          fast: ["opencode", "run", "--model", "gpt-5.3-mini"],
          slow: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
      },
      source: "- [ ] verify: release checklist\n",
      task: {
        directiveProfile: "slow",
        taskProfile: "fast",
        subItems: [{ text: "profile=fast", line: 2, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "verify-only",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--model",
      "gpt-5.3-mini",
    ]);
  });

  it("applies verify-only profile precedence — last override wins", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          verify: ["opencode", "run", "--from-commands-verify", "1"],
        },
        profiles: {
          fileProfile: ["opencode", "run", "--from-frontmatter", "1"],
          directiveProfile: ["opencode", "run", "--from-directive", "1"],
          taskProfile: ["opencode", "run", "--from-task-inline", "1"],
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] verify: release checklist\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile=taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "verify-only",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-task-inline",
      "1",
    ]);
  });

  it("uses CLI worker for verify-only tasks over all config sources", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
        },
        commands: {
          verify: ["opencode", "run", "--from-commands-verify", "1"],
        },
      },
      source: "- [ ] verify: release checklist\n",
      task: {
        directiveProfile: undefined,
        taskProfile: undefined,
        subItems: [],
      },
      cliWorkerCommand: ["custom", "worker", "--model", "gpt-5.3-codex"],
      taskIntent: "verify-only",
    });

    expect(command).toEqual(["custom", "worker", "--model", "gpt-5.3-codex"]);
  });

  it("applies memory-capture profile precedence — last override wins", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          memory: ["opencode", "run", "--from-commands-memory", "1"],
        },
        profiles: {
          fileProfile: ["opencode", "run", "--from-frontmatter", "1"],
          directiveProfile: ["opencode", "run", "--from-directive", "1"],
          taskProfile: ["opencode", "run", "--from-task-inline", "1"],
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] memory: capture release context\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile=taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "memory-capture",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-task-inline",
      "1",
    ]);
  });

  it("uses CLI worker for memory-capture tasks over all config sources", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
        },
        commands: {
          memory: ["opencode", "run", "--from-commands-memory", "1"],
        },
      },
      source: "- [ ] memory: capture release context\n",
      task: {
        directiveProfile: undefined,
        taskProfile: undefined,
        subItems: [],
      },
      cliWorkerCommand: ["custom", "worker", "--model", "gpt-5.3-codex"],
      taskIntent: "memory-capture",
    });

    expect(command).toEqual(["custom", "worker", "--model", "gpt-5.3-codex"]);
  });

  it("keeps verify-only tasks on run command override when commands.verify is not configured", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
        },
      },
      source: "- [ ] verify: release checklist\n",
      task: {
        directiveProfile: undefined,
        taskProfile: undefined,
        subItems: [],
      },
      cliWorkerCommand: [],
      taskIntent: "verify-only",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-commands-run",
      "1",
    ]);
  });

  it("keeps memory-capture tasks on run command override when commands.memory is not configured", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
        },
      },
      source: "- [ ] memory: capture release context\n",
      task: {
        directiveProfile: undefined,
        taskProfile: undefined,
        subItems: [],
      },
      cliWorkerCommand: [],
      taskIntent: "memory-capture",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-commands-run",
      "1",
    ]);
  });

  it("keeps tool-expansion tasks on run command override when commands.tools.{toolName} is not configured", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
        },
      },
      source: "- [ ] post-on-gitea: payload\n",
      task: {
        directiveProfile: undefined,
        taskProfile: undefined,
        subItems: [],
      },
      cliWorkerCommand: [],
      taskIntent: "tool-expansion",
      toolName: "post-on-gitea",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-commands-run",
      "1",
    ]);
  });

  it("keeps verify alias tasks on commands.run override when commands.verify is not configured", () => {
    const intent = classifyTaskIntent("confirm: release checklist", builtinToolResolver);
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
        },
      },
      source: "- [ ] confirm: release checklist\n",
      cliWorkerCommand: [],
      taskIntent: intent.intent,
      toolName: intent.toolName,
    });

    expect(intent.intent).toBe("verify-only");
    expect(command).toEqual(["opencode", "run", "--from-commands-run", "1"]);
  });

  it("keeps memory alias tasks on commands.run override when commands.memory is not configured", () => {
    const intent = classifyTaskIntent("inventory: capture release context", builtinToolResolver);
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
        },
      },
      source: "- [ ] inventory: capture release context\n",
      cliWorkerCommand: [],
      taskIntent: intent.intent,
      toolName: intent.toolName,
    });

    expect(intent.intent).toBe("memory-capture");
    expect(command).toEqual(["opencode", "run", "--from-commands-run", "1"]);
  });

  it("keeps tool alias tasks on commands.run override when commands.tools.<toolName> is not configured", () => {
    const intent = classifyTaskIntent("foreach: item in releaseFiles => verify: item", builtinToolResolver);
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
        },
        commands: {
          run: ["opencode", "run", "--from-commands-run", "1"],
        },
      },
      source: "- [ ] foreach: item in releaseFiles => verify: item\n",
      cliWorkerCommand: [],
      taskIntent: intent.intent,
      toolName: intent.toolName,
    });

    expect(intent.intent).toBe("tool-expansion");
    expect(intent.toolName).toBe("for");
    expect(command).toEqual(["opencode", "run", "--from-commands-run", "1"]);
  });

  it("does not warn on profile sub-item for supported prefix intents", () => {
    const events: ApplicationOutputEvent[] = [];

    resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
        },
      },
      source: "- [ ] memory: release context\n",
      task: {
        subItems: [{ text: "profile=fast", line: 2, depth: 1 }],
      },
      cliWorkerCommand: [],
      emit: (event) => events.push(event),
      taskIntent: "memory-capture",
    });

    expect(events.some((event) => event.kind === "warn")).toBe(false);
  });

  it("emits workers.tui source when mode is tui and verbose", () => {
    const events: ApplicationOutputEvent[] = [];

    resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "$bootstrap"],
          tui: ["opencode", "$bootstrap"],
        },
      },
      source: "- [ ] some task\n",
      cliWorkerCommand: [],
      emit: (event) => events.push(event),
      verbose: true,
      mode: "tui",
    });

    expect(events.some((event) => event.kind === "info"
      && event.message === "opencode $bootstrap (from config workers.tui)")).toBe(true);
  });

  it("resolves help worker pattern with no source or task", () => {
    const resolved = resolveWorkerPatternForInvocation({
      commandName: "help",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
          tui: ["opencode", "$bootstrap"],
        },
      },
      mode: "tui",
    });

    expect(resolved.workerCommand).toEqual(["opencode", "$bootstrap"]);
    expect(resolved.workerPattern).toEqual({
      command: ["opencode", "$bootstrap"],
      usesBootstrap: true,
      usesFile: false,
      appendFile: false,
    });
  });

  it("resolves commands.migrate-slug override for migration slug generation", () => {
    const resolved = resolveWorkerPatternForInvocation({
      commandName: "migrate-slug",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
        commands: {
          "migrate-slug": ["opencode", "run", "--model", "gpt-5.3-mini"],
        },
      },
      mode: "wait",
    });

    expect(resolved.workerCommand).toEqual(["opencode", "run", "--model", "gpt-5.3-mini"]);
    expect(resolved.workerPattern.command).toEqual(["opencode", "run", "--model", "gpt-5.3-mini"]);
  });

  it("selects first eligible configured fallback when primary is cooling down", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [
            ["fallback", "one"],
            ["fallback", "two"],
          ],
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      workerHealthEntries: [
        {
          key: buildWorkerHealthWorkerKey(["primary", "worker"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_COOLING_DOWN,
          cooldownUntil: "2026-04-12T10:32:38.339Z",
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual(["fallback", "one"]);
  });

  it("skips ineligible fallback candidates and picks next eligible deterministically", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [
            ["fallback", "one"],
            ["fallback", "two"],
            ["fallback", "three"],
          ],
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      workerHealthEntries: [
        {
          key: buildWorkerHealthWorkerKey(["primary", "worker"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_COOLING_DOWN,
          cooldownUntil: "2026-04-12T10:32:38.339Z",
        },
        {
          key: buildWorkerHealthWorkerKey(["fallback", "one"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_UNAVAILABLE,
        },
        {
          key: buildWorkerHealthWorkerKey(["fallback", "two"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_COOLING_DOWN,
          cooldownUntil: "2026-04-12T11:32:38.339Z",
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual(["fallback", "three"]);
  });

  it("returns empty command when all primary and fallbacks are ineligible", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [
            ["fallback", "one"],
          ],
        },
        profiles: {
          fast: ["primary", "worker"],
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      workerHealthEntries: [
        {
          key: buildWorkerHealthWorkerKey(["primary", "worker"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_UNAVAILABLE,
        },
        {
          key: buildWorkerHealthWorkerKey(["fallback", "one"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_COOLING_DOWN,
          cooldownUntil: "2026-04-12T10:32:38.339Z",
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual([]);
  });

  it("applies profile-level ineligibility when evaluating fallback candidates", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
          fallbacks: [
            ["fallback", "one"],
          ],
        },
        profiles: {
          fast: ["primary", "worker"],
        },
      },
      source: "---\nprofile: fast\n---\n\n- [ ] task\n",
      cliWorkerCommand: [],
      workerHealthEntries: [
        {
          key: buildWorkerHealthProfileKey("fast"),
          source: "profile",
          status: WORKER_HEALTH_STATUS_COOLING_DOWN,
          cooldownUntil: "2026-04-12T10:32:38.339Z",
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual([]);
  });

  it("resolves explicit verify phase worker from run.workerRouting", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
          fallbacks: [["fallback", "worker"]],
        },
        run: {
          workerRouting: {
            verify: {
              worker: ["verify", "worker"],
            },
          },
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      runWorkerPhase: "verify",
    });

    expect(command).toEqual(["verify", "worker"]);
  });

  it("resolves attempt-scoped repair route before default route", () => {
    const secondAttemptCommand = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
        },
        run: {
          workerRouting: {
            repair: {
              default: {
                worker: ["repair", "default"],
              },
              attempts: [
                {
                  selector: {
                    attempt: 2,
                  },
                  worker: ["repair", "attempt-2"],
                },
              ],
            },
          },
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      runWorkerPhase: "repair",
      runWorkerAttempt: 2,
    });
    const firstAttemptCommand = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
        },
        run: {
          workerRouting: {
            repair: {
              default: {
                worker: ["repair", "default"],
              },
              attempts: [
                {
                  selector: {
                    attempt: 2,
                  },
                  worker: ["repair", "attempt-2"],
                },
              ],
            },
          },
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      runWorkerPhase: "repair",
      runWorkerAttempt: 1,
    });

    expect(secondAttemptCommand).toEqual(["repair", "attempt-2"]);
    expect(firstAttemptCommand).toEqual(["repair", "default"]);
  });

  it("does not use configured fallbacks for explicit phase route by default", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
          fallbacks: [["fallback", "one"]],
        },
        run: {
          workerRouting: {
            resolve: {
              worker: ["phase", "explicit"],
            },
          },
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      runWorkerPhase: "resolve",
      workerHealthEntries: [
        {
          key: buildWorkerHealthWorkerKey(["phase", "explicit"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_UNAVAILABLE,
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual(["phase", "explicit"]);
  });

  it("uses configured fallbacks for explicit phase route when useFallbacks is true", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
          fallbacks: [["fallback", "one"]],
        },
        run: {
          workerRouting: {
            resolve: {
              worker: ["phase", "explicit"],
              useFallbacks: true,
            },
          },
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      runWorkerPhase: "resolve",
      workerHealthEntries: [
        {
          key: buildWorkerHealthWorkerKey(["phase", "explicit"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_UNAVAILABLE,
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual(["fallback", "one"]);
  });

  it("keeps health failover for inherited phase routing when no explicit phase worker is configured", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
          fallbacks: [["fallback", "one"]],
        },
        run: {
          workerRouting: {
            verify: {
              useFallbacks: false,
              worker: ["verify", "explicit"],
            },
          },
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
      runWorkerPhase: "repair",
      workerHealthEntries: [
        {
          key: buildWorkerHealthWorkerKey(["default", "worker"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_UNAVAILABLE,
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual(["fallback", "one"]);
  });

  it("treats CLI worker as inherited routing even when phase has explicit worker configured", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
          fallbacks: [["fallback", "one"]],
        },
        run: {
          workerRouting: {
            resolve: {
              worker: ["phase", "explicit"],
            },
          },
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: ["cli", "worker"],
      runWorkerPhase: "resolve",
      workerHealthEntries: [
        {
          key: buildWorkerHealthWorkerKey(["cli", "worker"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_UNAVAILABLE,
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual(["fallback", "one"]);
  });
});
