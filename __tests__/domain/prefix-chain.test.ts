import { describe, expect, it } from "vitest";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import { extractForceModifier, parsePrefixChain } from "../../src/domain/prefix-chain.js";
import type { ToolResolverPort } from "../../src/domain/ports/tool-resolver-port.js";
import {
  PARALLEL_PREFIX_ALIASES,
  VERIFY_PREFIX_ALIASES,
} from "../helpers/prefix-aliases.js";

const builtinToolResolver: ToolResolverPort = {
  resolve: (toolName) => resolveBuiltinTool(toolName),
  listKnownToolNames: () => listBuiltinToolNames(),
};

describe("extractForceModifier", () => {
  it("returns non-force metadata for plain task text", () => {
    const result = extractForceModifier("implement feature");

    expect(result).toEqual({
      isForce: false,
      maxAttempts: 2,
      strippedText: "implement feature",
    });
  });

  it("extracts force prefix with default attempts", () => {
    const result = extractForceModifier("force: implement feature");

    expect(result).toEqual({
      isForce: true,
      maxAttempts: 2,
      strippedText: "implement feature",
    });
  });

  it("parses attempt count when payload uses comma separator", () => {
    const result = extractForceModifier("force: 3, implement feature");

    expect(result).toEqual({
      isForce: true,
      maxAttempts: 3,
      strippedText: "implement feature",
    });
  });

  it("preserves nested modifier payload for later parsing", () => {
    const result = extractForceModifier("force: verify: tests pass");

    expect(result).toEqual({
      isForce: true,
      maxAttempts: 2,
      strippedText: "verify: tests pass",
    });
  });

  it("handles bare force prefix with empty payload", () => {
    const result = extractForceModifier("force:");

    expect(result).toEqual({
      isForce: true,
      maxAttempts: 2,
      strippedText: "",
    });
  });

  it("treats numeric-only payload without comma as task text", () => {
    const result = extractForceModifier("force: 3");

    expect(result).toEqual({
      isForce: true,
      maxAttempts: 2,
      strippedText: "3",
    });
  });

  it("extracts only the first force prefix", () => {
    const result = extractForceModifier("force: force: implement feature");

    expect(result).toEqual({
      isForce: true,
      maxAttempts: 2,
      strippedText: "force: implement feature",
    });
  });

  it("does not apply force extraction when resolved force tool is not a modifier", () => {
    const toolResolver: ToolResolverPort = {
      resolve: (toolName) => toolName.toLowerCase() === "force"
        ? {
          name: "force",
          kind: "handler",
        }
        : undefined,
      listKnownToolNames: () => ["force"],
    };

    const result = extractForceModifier("force: implement feature", toolResolver);

    expect(result).toEqual({
      isForce: false,
      maxAttempts: 2,
      strippedText: "force: implement feature",
    });
  });
});

describe("parsePrefixChain", () => {
  it("keeps verify alias handlers behaviorally equivalent", () => {
    const chains = VERIFY_PREFIX_ALIASES.map((alias) => parsePrefixChain(`${alias}: run smoke tests`, builtinToolResolver));

    for (const chain of chains) {
      expect(chain.modifiers).toEqual([]);
      expect(chain.handler?.tool.kind).toBe("handler");
      expect(chain.handler?.tool.frontmatter).toEqual({ skipExecution: true, shouldVerify: true });
      expect(chain.handler?.payload).toBe("run smoke tests");
      expect(chain.remainingText).toBe("run smoke tests");
    }
  });

  it("keeps parallel alias handlers behaviorally equivalent", () => {
    const chains = PARALLEL_PREFIX_ALIASES.map((alias) => parsePrefixChain(`${alias}: prepare workers`, builtinToolResolver));

    for (const chain of chains) {
      expect(chain.modifiers).toEqual([]);
      expect(chain.handler?.tool.kind).toBe("handler");
      expect(chain.handler?.tool.frontmatter).toEqual({ skipExecution: true, autoComplete: true, shouldVerify: false });
      expect(chain.handler?.payload).toBe("prepare workers");
      expect(chain.remainingText).toBe("prepare workers");
    }
  });

  it("keeps existing built-in prefixes parsing unchanged after registering get", () => {
    const resolverWithQuestion: ToolResolverPort = {
      resolve: (toolName) => {
        const normalized = toolName.trim().toLowerCase();
        if (normalized === "question") {
          return {
            name: "question",
            kind: "handler",
            frontmatter: { skipExecution: true, shouldVerify: false },
          };
        }

        return resolveBuiltinTool(normalized);
      },
      listKnownToolNames: () => [...listBuiltinToolNames(), "question"],
    };

    expect(parsePrefixChain("verify: run smoke tests", resolverWithQuestion)).toMatchObject({
      modifiers: [],
      handler: {
        tool: { name: "verify", kind: "handler" },
        payload: "run smoke tests",
      },
      remainingText: "run smoke tests",
    });

    expect(parsePrefixChain("include: ./child.md", resolverWithQuestion)).toMatchObject({
      modifiers: [],
      handler: {
        tool: { name: "include", kind: "handler" },
        payload: "./child.md",
      },
      remainingText: "./child.md",
    });

    expect(parsePrefixChain("parallel: setup environments", resolverWithQuestion)).toMatchObject({
      modifiers: [],
      handler: {
        tool: { name: "parallel", kind: "handler" },
        payload: "setup environments",
      },
      remainingText: "setup environments",
    });

    expect(parsePrefixChain("question: Which module should we improve?", resolverWithQuestion)).toMatchObject({
      modifiers: [],
      handler: {
        tool: { name: "question", kind: "handler" },
        payload: "Which module should we improve?",
      },
      remainingText: "Which module should we improve?",
    });
  });

  it("identifies registered force prefix as a modifier", () => {
    const chain = parsePrefixChain("force: verify: tests pass", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("force");
    expect(chain.modifiers[0]?.tool.kind).toBe("modifier");
    expect(chain.modifiers[0]?.payload).toBe("verify: tests pass");
    expect(chain.handler).toBeUndefined();
    expect(chain.remainingText).toBe("");
  });

  it("parses force as a modifier segment with a handler after comma boundary", () => {
    const chain = parsePrefixChain("force: 3, verify: tests pass", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("force");
    expect(chain.modifiers[0]?.tool.kind).toBe("modifier");
    expect(chain.modifiers[0]?.payload).toBe("3");
    expect(chain.handler?.tool.name).toBe("verify");
    expect(chain.handler?.payload).toBe("tests pass");
    expect(chain.remainingText).toBe("tests pass");
  });

  it("parses force-only prefix as a modifier when no handler is present", () => {
    const chain = parsePrefixChain("force: implement feature", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("force");
    expect(chain.modifiers[0]?.tool.kind).toBe("modifier");
    expect(chain.modifiers[0]?.payload).toBe("implement feature");
    expect(chain.handler).toBeUndefined();
    expect(chain.remainingText).toBe("");
  });

  it("parses for: as loop handler and preserves payload text", () => {
    const chain = parsePrefixChain("for: All controllers", builtinToolResolver);

    expect(chain.modifiers).toEqual([]);
    expect(chain.handler?.tool.name).toBe("for");
    expect(chain.handler?.tool.kind).toBe("handler");
    expect(chain.handler?.payload).toBe("All controllers");
    expect(chain.remainingText).toBe("All controllers");
  });

  it("normalizes each:/foreach: aliases to canonical for handler", () => {
    const eachChain = parsePrefixChain("each: API routes", builtinToolResolver);
    const foreachChain = parsePrefixChain("foreach: API routes", builtinToolResolver);

    expect(eachChain.handler?.tool.name).toBe("for");
    expect(eachChain.handler?.payload).toBe("API routes");
    expect(foreachChain.handler?.tool.name).toBe("for");
    expect(foreachChain.handler?.payload).toBe("API routes");
  });

  it("supports modifier chains before loop aliases and keeps canonical handler", () => {
    const chain = parsePrefixChain("profile=fast, each: services", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast");
    expect(chain.handler?.tool.name).toBe("for");
    expect(chain.handler?.payload).toBe("services");
    expect(chain.remainingText).toBe("services");
  });

  it.each([",", ";"])("splits profile=<name> modifier from known handler using %s separator", (separator) => {
    const chain = parsePrefixChain(`profile=fast${separator} verify: run smoke tests`, builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast");
    expect(chain.handler?.tool.name).toBe("verify");
    expect(chain.handler?.payload).toBe("run smoke tests");
    expect(chain.remainingText).toBe("run smoke tests");
  });

  it.each([",", ";"])("parses profile/fast composition with %s separator and keeps loop alias canonical", (separator) => {
    const chain = parsePrefixChain(`profile=fast${separator} foreach: services`, builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast");
    expect(chain.handler?.tool.name).toBe("for");
    expect(chain.handler?.payload).toBe("services");
    expect(chain.remainingText).toBe("services");
  });

  it("parses chained modifiers before a terminal handler", () => {
    const chain = parsePrefixChain("profile=fast; force: 3, verify: run smoke tests", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(2);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast");
    expect(chain.modifiers[1]?.tool.name).toBe("force");
    expect(chain.modifiers[1]?.payload).toBe("3");
    expect(chain.handler?.tool.name).toBe("verify");
    expect(chain.handler?.payload).toBe("run smoke tests");
    expect(chain.remainingText).toBe("run smoke tests");
  });

  it("splits only at boundaries where the next segment is a known prefix", () => {
    const chain = parsePrefixChain("profile=fast, unknown: value, verify: run smoke tests", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast, unknown: value");
    expect(chain.handler?.tool.name).toBe("verify");
    expect(chain.handler?.payload).toBe("run smoke tests");
    expect(chain.remainingText).toBe("run smoke tests");
  });

  it("does not split at delimiter boundaries without required trailing space", () => {
    const chain = parsePrefixChain("profile=fast,verify: run smoke tests", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast,verify: run smoke tests");
    expect(chain.handler).toBeUndefined();
    expect(chain.remainingText).toBe("");
  });

  it("does not split when prefix-like words appear only in payload text", () => {
    const chain = parsePrefixChain(
      "profile=fast, verify: investigate memory usage; parallel execution can be fast",
      builtinToolResolver,
    );

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast");
    expect(chain.handler?.tool.name).toBe("verify");
    expect(chain.handler?.payload).toBe("investigate memory usage; parallel execution can be fast");
    expect(chain.remainingText).toBe("investigate memory usage; parallel execution can be fast");
  });

  it("preserves payload text containing additional colons after a valid prefix", () => {
    const chain = parsePrefixChain("verify: keep parser:prefix behavior stable", builtinToolResolver);

    expect(chain.modifiers).toEqual([]);
    expect(chain.handler?.tool.name).toBe("verify");
    expect(chain.handler?.payload).toBe("keep parser:prefix behavior stable");
    expect(chain.remainingText).toBe("keep parser:prefix behavior stable");
  });

  it("accepts profile=<name> syntax as a valid modifier form", () => {
    const chain = parsePrefixChain("PrOfIlE = fast, verify: tests pass", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast");
    expect(chain.handler?.tool.name).toBe("verify");
    expect(chain.handler?.payload).toBe("tests pass");
    expect(chain.remainingText).toBe("tests pass");
  });

  it.each(["for", "each", "foreach"])("keeps verify as terminal handler when %s appears inside verify payload", (alias) => {
    const chain = parsePrefixChain(`profile=fast, verify: ${alias}: services`, builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast");
    expect(chain.handler?.tool.name).toBe("verify");
    expect(chain.handler?.payload).toBe(`${alias}: services`);
    expect(chain.remainingText).toBe(`${alias}: services`);
  });

  it.each([
    "profile: fast",
    "profile: fast, verify: tests pass",
    "profile = release, profile: fast",
    "ProFiLe : fast; verify: tests pass",
  ])("rejects legacy-invalid profile: syntax (%s)", (taskText) => {
    expect(() => parsePrefixChain(taskText, builtinToolResolver)).toThrow(
      "Invalid profile syntax: use profile=<name> (not profile: <name>).",
    );
  });
});
