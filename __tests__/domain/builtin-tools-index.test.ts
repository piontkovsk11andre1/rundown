import { describe, expect, it } from "vitest";
import { resolveBuiltinTool } from "../../src/domain/builtin-tools/index.js";

describe("builtin tools registry", () => {
  it("defines end as a handler tool with explicit execution and verification flags", () => {
    const tool = resolveBuiltinTool("end");

    expect(tool?.kind).toBe("handler");
    expect(tool?.frontmatter).toEqual({
      skipExecution: false,
      shouldVerify: false,
    });
  });

  it("maps return/skip/quit as end aliases", () => {
    const end = resolveBuiltinTool("end");
    const aliasNames = ["return", "skip", "quit"];

    for (const aliasName of aliasNames) {
      const alias = resolveBuiltinTool(aliasName);
      expect(alias?.kind).toBe("handler");
      expect(alias?.handler).toBe(end?.handler);
      expect(alias?.frontmatter).toEqual(end?.frontmatter);
    }
  });
});
