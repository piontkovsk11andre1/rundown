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

  it("keeps optional/skip on optional handler and maps terminal aliases separately", () => {
    const optional = resolveBuiltinTool("optional");
    const skip = resolveBuiltinTool("skip");
    const end = resolveBuiltinTool("end");
    const exit = resolveBuiltinTool("exit");
    const terminalAliasNames = ["end", "exit", "return", "quit", "break"];

    expect(optional?.kind).toBe("handler");
    expect(skip?.kind).toBe("handler");
    expect(skip?.handler).toBe(optional?.handler);
    expect(skip?.frontmatter).toEqual(optional?.frontmatter);

    expect(end?.kind).toBe("handler");
    expect(exit?.kind).toBe("handler");
    expect(exit?.handler).toBe(end?.handler);
    expect(exit?.frontmatter).toEqual(end?.frontmatter);
    expect(optional?.handler).not.toBe(end?.handler);

    for (const aliasName of terminalAliasNames) {
      const alias = resolveBuiltinTool(aliasName);
      expect(alias?.kind).toBe("handler");
      expect(alias?.handler).toBe(end?.handler);
      expect(alias?.frontmatter).toEqual(end?.frontmatter);
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

  it("keeps verify alias handlers equivalent across verify/confirm/check", () => {
    const verify = resolveBuiltinTool("verify");
    const aliasNames = ["confirm", "check"];

    expect(verify?.kind).toBe("handler");
    expect(verify?.frontmatter).toEqual({
      skipExecution: true,
      shouldVerify: true,
    });

    for (const aliasName of aliasNames) {
      const alias = resolveBuiltinTool(aliasName);
      expect(alias?.kind).toBe("handler");
      expect(alias?.handler).toBe(verify?.handler);
      expect(alias?.frontmatter).toEqual(verify?.frontmatter);
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
