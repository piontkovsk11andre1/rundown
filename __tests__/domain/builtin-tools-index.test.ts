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

  it("maps skip/end/return/quit/break to the canonical optional handler", () => {
    const optional = resolveBuiltinTool("optional");
    const end = resolveBuiltinTool("end");
    const aliasNames = ["skip", "end", "return", "quit", "break"];

    expect(optional?.kind).toBe("handler");
    expect(end?.kind).toBe("handler");
    expect(optional?.handler).toBe(end?.handler);
    expect(optional?.frontmatter).toEqual(end?.frontmatter);

    for (const aliasName of aliasNames) {
      const alias = resolveBuiltinTool(aliasName);
      expect(alias?.kind).toBe("handler");
      expect(alias?.handler).toBe(optional?.handler);
      expect(alias?.frontmatter).toEqual(optional?.frontmatter);
    }
  });

  it("defines parallel as a non-verifying handler that skips worker execution", () => {
    const tool = resolveBuiltinTool("parallel");

    expect(tool?.kind).toBe("handler");
    expect(tool?.frontmatter).toEqual({
      skipExecution: true,
      autoComplete: true,
      shouldVerify: false,
    });
  });

  it("defines get as a non-verifying handler that skips worker execution", () => {
    const tool = resolveBuiltinTool("get");

    expect(tool?.kind).toBe("handler");
    expect(tool?.frontmatter).toEqual({
      skipExecution: true,
      shouldVerify: false,
    });
  });

  it("keeps verify/include/parallel registry contracts unchanged after adding get", () => {
    expect(resolveBuiltinTool("verify")?.frontmatter).toEqual({
      skipExecution: true,
      shouldVerify: true,
    });

    expect(resolveBuiltinTool("include")?.frontmatter).toEqual({
      skipExecution: true,
      autoComplete: true,
      shouldVerify: false,
    });

    expect(resolveBuiltinTool("parallel")?.frontmatter).toEqual({
      skipExecution: true,
      autoComplete: true,
      shouldVerify: false,
    });
  });

  it("maps concurrent/par as parallel aliases", () => {
    const parallel = resolveBuiltinTool("parallel");
    const aliasNames = ["concurrent", "par"];

    for (const aliasName of aliasNames) {
      const alias = resolveBuiltinTool(aliasName);
      expect(alias?.kind).toBe("handler");
      expect(alias?.handler).toBe(parallel?.handler);
      expect(alias?.frontmatter).toEqual(parallel?.frontmatter);
    }
  });

  it("maps for/each/foreach as canonical loop handler aliases", () => {
    const loopTool = resolveBuiltinTool("for");
    const aliasNames = ["each", "foreach"];

    expect(loopTool?.kind).toBe("handler");
    expect(loopTool?.name).toBe("for");
    expect(loopTool?.frontmatter).toEqual({
      skipExecution: true,
      autoComplete: true,
      shouldVerify: false,
    });

    for (const aliasName of aliasNames) {
      const alias = resolveBuiltinTool(aliasName);
      expect(alias?.kind).toBe("handler");
      expect(alias?.name).toBe("for");
      expect(alias?.handler).toBe(loopTool?.handler);
      expect(alias?.frontmatter).toEqual(loopTool?.frontmatter);
    }
  });

  it("does not statically register question because it needs injected interactive input", () => {
    expect(resolveBuiltinTool("question")).toBeUndefined();
  });
});
