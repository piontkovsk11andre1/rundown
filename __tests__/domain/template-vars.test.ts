import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE_VARS_FILE,
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
} from "../../src/domain/template-vars.js";

describe("parseCliTemplateVars", () => {
  it("parses repeated key=value entries", () => {
    expect(parseCliTemplateVars(["branch=main", "ticket=ENG-42"]))
      .toEqual({ branch: "main", ticket: "ENG-42" });
  });

  it("allows empty values", () => {
    expect(parseCliTemplateVars(["notes="]))
      .toEqual({ notes: "" });
  });

  it("keeps text after the first equals sign", () => {
    expect(parseCliTemplateVars(["title=fix=now"]))
      .toEqual({ title: "fix=now" });
  });

  it("rejects entries without an equals sign", () => {
    expect(() => parseCliTemplateVars(["branch"]))
      .toThrow("Invalid template variable \"branch\". Use key=value.");
  });

  it("rejects invalid variable names", () => {
    expect(() => parseCliTemplateVars(["build-id=1"]))
      .toThrow("Invalid template variable name \"build-id\". Use letters, numbers, and underscores only.");
  });
});

describe("resolveTemplateVarsFilePath", () => {
  it("uses the default vars file when --vars-file has no path", () => {
    expect(resolveTemplateVarsFilePath(true)).toBe(DEFAULT_TEMPLATE_VARS_FILE);
  });

  it("uses an explicit vars file path when provided", () => {
    expect(resolveTemplateVarsFilePath("custom.json")).toBe("custom.json");
  });

  it("returns undefined when the option is not provided", () => {
    expect(resolveTemplateVarsFilePath(undefined)).toBeUndefined();
  });
});
