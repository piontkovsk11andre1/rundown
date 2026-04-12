import { describe, expect, it } from "vitest";
import { listBuiltinToolNames, resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";
import { extractForceModifier, parsePrefixChain } from "../../src/domain/prefix-chain.js";
import type { ToolResolverPort } from "../../src/domain/ports/tool-resolver-port.js";

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
    const chain = parsePrefixChain("profile: fast, each: services", builtinToolResolver);

    expect(chain.modifiers).toHaveLength(1);
    expect(chain.modifiers[0]?.tool.name).toBe("profile");
    expect(chain.modifiers[0]?.payload).toBe("fast");
    expect(chain.handler?.tool.name).toBe("for");
    expect(chain.handler?.payload).toBe("services");
    expect(chain.remainingText).toBe("services");
  });
});
