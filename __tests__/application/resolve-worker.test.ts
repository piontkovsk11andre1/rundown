import { describe, expect, it } from "vitest";
import {
  resolveWorkerForInvocation,
  resolveWorkerPatternForInvocation,
} from "../../src/application/resolve-worker.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";
import {
  WORKER_HEALTH_STATUS_COOLING_DOWN,
  WORKER_HEALTH_STATUS_UNAVAILABLE,
  buildWorkerHealthProfileKey,
  buildWorkerHealthWorkerKey,
} from "../../src/domain/worker-health.js";

describe("resolve-worker", () => {
  it("resolves worker from config layers and warns on ignored profile sub-item", () => {
    const events: ApplicationOutputEvent[] = [];

    const command = resolveWorkerForInvocation({
      commandName: "discuss",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
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

  it("applies tool-expansion profile precedence — last override wins", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "--from-defaults", "1"],
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

  it("emits workers.interactive source for interactive commands when verbose", () => {
    const events: ApplicationOutputEvent[] = [];

    resolveWorkerForInvocation({
      commandName: "discuss",
      workerConfig: {
        workers: {
          default: ["opencode", "run", "$bootstrap"],
          interactive: ["opencode", "$bootstrap"],
        },
      },
      source: "- [ ] some task\n",
      cliWorkerCommand: [],
      emit: (event) => events.push(event),
      verbose: true,
    });

    expect(events.some((event) => event.kind === "info"
      && event.message === "opencode $bootstrap (from config workers.interactive)")).toBe(true);
  });

  it.each(["run", "all", "materialize", "plan", "make", "do", "add", "reverify", "undo"])(
    "routes retained command %s to workers.default even in tui mode",
    (commandName) => {
      const command = resolveWorkerForInvocation({
        commandName,
        workerConfig: {
          workers: {
            default: ["default", "worker"],
            interactive: ["interactive", "worker"],
          },
        },
        source: "- [ ] task\n",
        cliWorkerCommand: [],
        mode: "tui",
      });

      expect(command).toEqual(["default", "worker"]);
    },
  );

  it.each(["repair", "discuss"])(
    "routes %s to workers.interactive and falls back to workers.default when interactive is ineligible",
    (commandName) => {
      const command = resolveWorkerForInvocation({
        commandName,
        workerConfig: {
          workers: {
            default: ["default", "worker"],
            interactive: ["interactive", "worker"],
          },
          fallbacks: {
            default: [["configured", "fallback"]],
          },
        },
        source: "- [ ] task\n",
        cliWorkerCommand: [],
        workerHealthEntries: [
          {
            key: buildWorkerHealthWorkerKey(["interactive", "worker"]),
            source: "worker",
            status: WORKER_HEALTH_STATUS_UNAVAILABLE,
          },
        ],
      });

      expect(command).toEqual(["default", "worker"]);
    },
  );

  it("routes profile modifiers through profiles instead of command defaults", () => {
    const command = resolveWorkerForInvocation({
      commandName: "discuss",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
          interactive: ["interactive", "worker"],
        },
        profiles: {
          fast: ["profile", "worker"],
        },
      },
      source: "- [ ] task\n",
      modifierProfile: "fast",
      cliWorkerCommand: [],
      mode: "tui",
    });

    expect(command).toEqual(["profile", "worker"]);
  });

  it("resolves help worker pattern with no source or task", () => {
    const resolved = resolveWorkerPatternForInvocation({
      commandName: "help",
      workerConfig: {
        workers: {
          default: ["opencode", "run"],
          interactive: ["opencode", "$bootstrap"],
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

  it("selects first eligible configured fallback when primary is cooling down", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["primary", "worker"],
        },
        fallbacks: {
          default: [
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
        },
        fallbacks: {
          default: [
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
        },
        fallbacks: {
          default: [
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
        },
        fallbacks: {
          default: [
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

  it("uses configured fallbacks for default worker resolution", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
        },
        fallbacks: {
          default: [["fallback", "one"]],
        },
      },
      source: "- [ ] task\n",
      cliWorkerCommand: [],
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

  it("uses profile-specific configured fallbacks when a profile is active", () => {
    const nowIso = "2026-04-12T09:32:38.339Z";
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        workers: {
          default: ["default", "worker"],
        },
        profiles: {
          fast: ["fast", "worker"],
        },
        fallbacks: {
          default: [["default", "fallback"]],
          fast: [["fast", "fallback"]],
        },
      },
      source: "---\nprofile: fast\n---\n\n- [ ] task\n",
      cliWorkerCommand: [],
      workerHealthEntries: [
        {
          key: buildWorkerHealthWorkerKey(["fast", "worker"]),
          source: "worker",
          status: WORKER_HEALTH_STATUS_UNAVAILABLE,
        },
      ],
      evaluateWorkerHealthAtMs: Date.parse(nowIso),
    });

    expect(command).toEqual(["fast", "fallback"]);
  });
});
