import { describe, expect, it } from "vitest";
import type { SubItem } from "../../src/domain/parser.js";
import {
  extractProfileFromSubItems,
  resolveWorkerConfig,
} from "../../src/domain/worker-config.js";

describe("resolveWorkerConfig", () => {
  it("resolves defaults only", () => {
    const resolved = resolveWorkerConfig(
      {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--model", "gpt-5.3-codex"],
        },
      },
      "run",
      undefined,
      undefined,
      undefined,
    );

    expect(resolved).toEqual({
      worker: ["opencode", "run"],
      workerArgs: ["--model", "gpt-5.3-codex"],
    });
  });

  it("applies per-command overrides", () => {
    const resolved = resolveWorkerConfig(
      {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--model", "gpt-5.3-codex"],
        },
        commands: {
          plan: {
            worker: ["opencode", "plan"],
            workerArgs: ["--effort", "high"],
          },
        },
      },
      "plan",
      undefined,
      undefined,
      undefined,
    );

    expect(resolved).toEqual({
      worker: ["opencode", "plan"],
      workerArgs: ["--model", "gpt-5.3-codex", "--effort", "high"],
    });
  });

  it("applies file-level frontmatter profile", () => {
    const resolved = resolveWorkerConfig(
      {
        defaults: {
          worker: ["opencode", "run"],
        },
        profiles: {
          complex: {
            workerArgs: ["--model", "opus-4.6"],
          },
        },
      },
      "run",
      "complex",
      undefined,
      undefined,
    );

    expect(resolved).toEqual({
      worker: ["opencode", "run"],
      workerArgs: ["--model", "opus-4.6"],
    });
  });

  it("applies directive profile and overrides file profile", () => {
    const resolved = resolveWorkerConfig(
      {
        defaults: {
          worker: ["opencode", "run"],
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
      "run",
      "complex",
      "fast",
      undefined,
    );

    expect(resolved).toEqual({
      worker: ["opencode", "run"],
      workerArgs: ["--model", "opus-4.6", "--model", "gpt-5.3-codex"],
    });
  });

  it("uses CLI worker over all other sources", () => {
    const resolved = resolveWorkerConfig(
      {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--model", "gpt-5.3-codex"],
        },
        commands: {
          run: {
            worker: ["opencode", "plan"],
            workerArgs: ["--effort", "high"],
          },
        },
        profiles: {
          fast: {
            workerArgs: ["--model", "opus-4.6"],
          },
        },
      },
      "run",
      "fast",
      "fast",
      ["custom-worker", "execute"],
    );

    expect(resolved).toEqual({
      worker: ["custom-worker", "execute"],
      workerArgs: [],
    });
  });

  it("throws when referenced profile does not exist", () => {
    expect(() =>
      resolveWorkerConfig(
        {
          defaults: {
            worker: ["opencode", "run"],
          },
          profiles: {
            fast: {
              workerArgs: ["--model", "gpt-5.3-codex"],
            },
          },
        },
        "run",
        "missing",
        undefined,
        undefined,
      ),
    ).toThrow("Unknown worker profile: missing");
  });

  it("returns empty worker and args for empty config", () => {
    expect(resolveWorkerConfig(undefined, "run", undefined, undefined, undefined)).toEqual({
      worker: [],
      workerArgs: [],
    });
  });

  it("appends workerArgs from each layer instead of replacing", () => {
    const resolved = resolveWorkerConfig(
      {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--base", "1"],
        },
        commands: {
          run: {
            workerArgs: ["--command", "2"],
          },
        },
        profiles: {
          complex: {
            workerArgs: ["--profile", "3"],
          },
        },
      },
      "run",
      "complex",
      undefined,
      undefined,
    );

    expect(resolved.workerArgs).toEqual([
      "--base",
      "1",
      "--command",
      "2",
      "--profile",
      "3",
    ]);
  });

  it("combines multiple cascade layers in order", () => {
    const resolved = resolveWorkerConfig(
      {
        defaults: {
          worker: ["opencode", "run"],
          workerArgs: ["--default", "1"],
        },
        commands: {
          discuss: {
            worker: ["opencode", "discuss"],
            workerArgs: ["--command", "2"],
          },
        },
        profiles: {
          complex: {
            workerArgs: ["--file", "3"],
          },
          fast: {
            workerArgs: ["--directive", "4"],
          },
        },
      },
      "discuss",
      "complex",
      "fast",
      undefined,
    );

    expect(resolved).toEqual({
      worker: ["opencode", "discuss"],
      workerArgs: ["--default", "1", "--command", "2", "--file", "3", "--directive", "4"],
    });
  });
});

describe("extractProfileFromSubItems", () => {
  it("returns undefined when no profile directive exists", () => {
    const subItems: SubItem[] = [
      { text: "verify:", line: 2, depth: 1 },
      { text: "All tests pass", line: 3, depth: 2 },
    ];

    expect(extractProfileFromSubItems(subItems)).toBeUndefined();
  });

  it("extracts profile name from profile: directive", () => {
    const subItems: SubItem[] = [
      { text: "profile: fast", line: 2, depth: 1 },
    ];

    expect(extractProfileFromSubItems(subItems)).toBe("fast");
  });

  it("matches profile directive case-insensitively", () => {
    const subItems: SubItem[] = [
      { text: "PrOfIlE: complex", line: 2, depth: 1 },
    ];

    expect(extractProfileFromSubItems(subItems)).toBe("complex");
  });

  it("returns first valid profile when multiple directives exist", () => {
    const subItems: SubItem[] = [
      { text: "note", line: 2, depth: 1 },
      { text: "profile: fast", line: 3, depth: 1 },
      { text: "profile: complex", line: 4, depth: 1 },
    ];

    expect(extractProfileFromSubItems(subItems)).toBe("fast");
  });

  it("ignores directives with empty profile names", () => {
    const subItems: SubItem[] = [
      { text: "profile:", line: 2, depth: 1 },
      { text: "profile:   ", line: 3, depth: 1 },
      { text: "profile: fast", line: 4, depth: 1 },
    ];

    expect(extractProfileFromSubItems(subItems)).toBe("fast");
  });
});
