import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  buildRundownVarEnv,
  DEFAULT_TEMPLATE_VARS_FILE,
  formatTemplateVarsForPrompt,
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

  it("resolves default vars file against config dir when provided", () => {
    const configDir = path.join(path.sep, "workspace", ".rundown");
    expect(resolveTemplateVarsFilePath(true, configDir)).toBe(path.join(configDir, "vars.json"));
  });

  it("uses an explicit vars file path when provided", () => {
    expect(resolveTemplateVarsFilePath("custom.json")).toBe("custom.json");
  });

  it("returns undefined when the option is not provided", () => {
    expect(resolveTemplateVarsFilePath(undefined)).toBeUndefined();
  });
});

describe("buildRundownVarEnv", () => {
  it("returns an empty object when no vars are provided", () => {
    expect(buildRundownVarEnv({})).toEqual({});
  });

  it("maps vars to uppercase RUNDOWN_VAR_ env keys", () => {
    expect(buildRundownVarEnv({ db_host: "localhost", apiToken: "abc123" }))
      .toEqual({
        RUNDOWN_VAR_DB_HOST: "localhost",
        RUNDOWN_VAR_APITOKEN: "abc123",
      });
  });

  it("preserves values including empty strings", () => {
    expect(buildRundownVarEnv({ notes: "", ticket: "ENG-42" }))
      .toEqual({
        RUNDOWN_VAR_NOTES: "",
        RUNDOWN_VAR_TICKET: "ENG-42",
      });
  });

  it("does not mutate the input vars object", () => {
    const vars = { branch: "main" };

    buildRundownVarEnv(vars);

    expect(vars).toEqual({ branch: "main" });
  });
});

describe("formatTemplateVarsForPrompt", () => {
  it("returns (none) when no vars are provided", () => {
    expect(formatTemplateVarsForPrompt({})).toBe("(none)");
  });

  it("formats vars as key=value lines", () => {
    expect(formatTemplateVarsForPrompt({ branch: "main", ticket: "ENG-42" }))
      .toBe("branch=main\nticket=ENG-42");
  });

  it("sorts keys alphabetically", () => {
    expect(formatTemplateVarsForPrompt({ zebra: "last", alpha: "first", middle: "mid" }))
      .toBe("alpha=first\nmiddle=mid\nzebra=last");
  });

  it("preserves values including empty strings", () => {
    expect(formatTemplateVarsForPrompt({ notes: "", title: "fix=now" }))
      .toBe("notes=\ntitle=fix=now");
  });

  it("does not mutate the input vars object", () => {
    const vars = { ticket: "ENG-42", branch: "main" };

    formatTemplateVarsForPrompt(vars);

    expect(vars).toEqual({ ticket: "ENG-42", branch: "main" });
  });
});
