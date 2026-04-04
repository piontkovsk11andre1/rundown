import { describe, expect, it } from "vitest";
import { resolveWorkerForInvocation } from "../../src/application/resolve-worker.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/output-port.js";

describe("resolve-worker", () => {
  it("resolves worker from config layers and warns on ignored profile sub-item", () => {
    const events: ApplicationOutputEvent[] = [];

    const command = resolveWorkerForInvocation({
      commandName: "discuss",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
        },
        commands: {
          discuss: {
            workerArgs: ["--base", "1"],
          },
        },
        profiles: {
          complex: {
            workerArgs: ["--model", "opus-4.6"],
          },
          fast: {
            workerArgs: ["--model", "gpt-5.3-codex"],
          },
        },
      },
      source: "---\nprofile: complex\n---\n\n- [ ] discuss item\n",
      task: {
        directiveProfile: "fast",
        subItems: [{ text: "profile: ignored", line: 2, depth: 1 }],
      },
      cliWorkerCommand: [],
      emit: (event) => events.push(event),
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--base",
      "1",
      "--model",
      "opus-4.6",
      "--model",
      "gpt-5.3-codex",
    ]);
    expect(events.some((event) => event.kind === "warn"
      && event.message === "\"profile: ignored\" as a task sub-item is not supported — use it as a parent list item or in file frontmatter.")).toBe(true);
    expect(events.some((event) => event.kind === "info"
      && event.message
      === "Worker: opencode run --base 1 --model opus-4.6 --model gpt-5.3-codex (profile \"fast\" via directive)")).toBe(true);
  });

  it("does not emit config worker resolution feedback when CLI worker is provided", () => {
    const events: ApplicationOutputEvent[] = [];

    const command = resolveWorkerForInvocation({
      commandName: "plan",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
        },
      },
      source: "- [ ] draft plan\n",
      cliWorkerCommand: ["custom", "worker"],
      emit: (event) => events.push(event),
    });

    expect(command).toEqual(["custom", "worker"]);
    expect(events.some((event) => event.kind === "info" && event.message.startsWith("Worker: "))).toBe(false);
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
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--model", "gpt-5.3-codex"],
        },
        commands: {
          run: {
            workerArgs: ["--effort", "medium"],
          },
          "tools.post-on-gitea": {
            worker: ["opencode", "run"],
            workerArgs: ["--model", "gpt-5.3-mini", "--no-approval"],
          },
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
      "gpt-5.3-codex",
      "--effort",
      "medium",
      "--model",
      "gpt-5.3-mini",
      "--no-approval",
    ]);
  });

  it("applies tool-expansion profile precedence from defaults to task inline", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          run: {
            workerArgs: ["--from-commands-run", "1"],
          },
          "tools.post-on-gitea": {
            workerArgs: ["--from-commands-tools", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] post-on-gitea: payload\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "tool-expansion",
      toolName: "post-on-gitea",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-defaults",
      "1",
      "--from-commands-run",
      "1",
      "--from-commands-tools",
      "1",
      "--from-frontmatter",
      "1",
      "--from-directive",
      "1",
      "--from-task-inline",
      "1",
    ]);
  });

  it("uses CLI worker for tool-expansion tasks over defaults, commands.tools, and profiles", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          run: {
            workerArgs: ["--from-commands-run", "1"],
          },
          "tools.post-on-gitea": {
            workerArgs: ["--from-commands-tools", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] post-on-gitea: payload\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
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
        defaults: {
          worker: ["opencode", "run"],
        },
        profiles: {
          fast: {
            workerArgs: ["--model", "gpt-5.3-mini"],
          },
          slow: {
            workerArgs: ["--model", "gpt-5.3-codex"],
          },
        },
      },
      source: "- [ ] verify: release checklist\n",
      task: {
        directiveProfile: "slow",
        taskProfile: "fast",
        subItems: [{ text: "profile: fast", line: 2, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "verify-only",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--model",
      "gpt-5.3-codex",
      "--model",
      "gpt-5.3-mini",
    ]);
  });

  it("applies verify-only profile precedence from defaults to task inline", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          verify: {
            workerArgs: ["--from-commands-verify", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] verify: release checklist\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "verify-only",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-defaults",
      "1",
      "--from-commands-verify",
      "1",
      "--from-frontmatter",
      "1",
      "--from-directive",
      "1",
      "--from-task-inline",
      "1",
    ]);
  });

  it("uses CLI worker for verify-only tasks over defaults, commands.verify, and profiles", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          verify: {
            workerArgs: ["--from-commands-verify", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] verify: release checklist\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: ["custom", "worker", "--model", "gpt-5.3-codex"],
      taskIntent: "verify-only",
    });

    expect(command).toEqual(["custom", "worker", "--model", "gpt-5.3-codex"]);
  });

  it("applies memory-capture profile precedence from defaults to task inline", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          memory: {
            workerArgs: ["--from-commands-memory", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] memory: capture release context\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "memory-capture",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-defaults",
      "1",
      "--from-commands-memory",
      "1",
      "--from-frontmatter",
      "1",
      "--from-directive",
      "1",
      "--from-task-inline",
      "1",
    ]);
  });

  it("uses CLI worker for memory-capture tasks over defaults, commands.memory, and profiles", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          memory: {
            workerArgs: ["--from-commands-memory", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] memory: capture release context\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: ["custom", "worker", "--model", "gpt-5.3-codex"],
      taskIntent: "memory-capture",
    });

    expect(command).toEqual(["custom", "worker", "--model", "gpt-5.3-codex"]);
  });

  it("keeps verify-only tasks on existing run-worker resolution when commands.verify is not configured", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          run: {
            workerArgs: ["--from-commands-run", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] verify: release checklist\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "verify-only",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-defaults",
      "1",
      "--from-commands-run",
      "1",
      "--from-frontmatter",
      "1",
      "--from-directive",
      "1",
      "--from-task-inline",
      "1",
    ]);
  });

  it("keeps memory-capture tasks on existing run-worker resolution when commands.memory is not configured", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          run: {
            workerArgs: ["--from-commands-run", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] memory: capture release context\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "memory-capture",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-defaults",
      "1",
      "--from-commands-run",
      "1",
      "--from-frontmatter",
      "1",
      "--from-directive",
      "1",
      "--from-task-inline",
      "1",
    ]);
  });

  it("keeps tool-expansion tasks on existing run-worker resolution when commands.tools.{toolName} is not configured", () => {
    const command = resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--from-defaults", "1"],
        },
        commands: {
          run: {
            workerArgs: ["--from-commands-run", "1"],
          },
        },
        profiles: {
          fileProfile: {
            workerArgs: ["--from-frontmatter", "1"],
          },
          directiveProfile: {
            workerArgs: ["--from-directive", "1"],
          },
          taskProfile: {
            workerArgs: ["--from-task-inline", "1"],
          },
        },
      },
      source: "---\nprofile: fileProfile\n---\n\n- [ ] post-on-gitea: payload\n",
      task: {
        directiveProfile: "directiveProfile",
        taskProfile: "taskProfile",
        subItems: [{ text: "profile: taskProfile", line: 5, depth: 1 }],
      },
      cliWorkerCommand: [],
      taskIntent: "tool-expansion",
      toolName: "post-on-gitea",
    });

    expect(command).toEqual([
      "opencode",
      "run",
      "--from-defaults",
      "1",
      "--from-commands-run",
      "1",
      "--from-frontmatter",
      "1",
      "--from-directive",
      "1",
      "--from-task-inline",
      "1",
    ]);
  });

  it("does not warn on profile sub-item for supported prefix intents", () => {
    const events: ApplicationOutputEvent[] = [];

    resolveWorkerForInvocation({
      commandName: "run",
      workerConfig: {
        defaults: {
          worker: ["opencode", "run"],
        },
      },
      source: "- [ ] memory: release context\n",
      task: {
        subItems: [{ text: "profile: fast", line: 2, depth: 1 }],
      },
      cliWorkerCommand: [],
      emit: (event) => events.push(event),
      taskIntent: "memory-capture",
    });

    expect(events.some((event) => event.kind === "warn")).toBe(false);
  });
});
