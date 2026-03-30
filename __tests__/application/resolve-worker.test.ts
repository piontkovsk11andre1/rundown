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
});
