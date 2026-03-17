import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TEMPLATE_VARS_FILE,
  loadTemplateVarsFile,
  parseCliTemplateVars,
  resolveTemplateVarsFilePath,
} from "./template-vars.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempVarsFile(content: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-todo-vars-"));
  tempDirs.push(dir);
  const file = path.join(dir, "vars.json");
  fs.writeFileSync(file, content, "utf-8");
  return { dir, file };
}

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

describe("loadTemplateVarsFile", () => {
  it("loads a JSON object of template vars", () => {
    const { file } = writeTempVarsFile(JSON.stringify({ branch: "main", build: 42, dryRun: true, notes: null }));

    expect(loadTemplateVarsFile(file)).toEqual({
      branch: "main",
      build: "42",
      dryRun: "true",
      notes: "",
    });
  });

  it("rejects non-object JSON", () => {
    const { file } = writeTempVarsFile(JSON.stringify(["nope"]));

    expect(() => loadTemplateVarsFile(file))
      .toThrow(`Template vars file \"${file}\" must contain a JSON object.`);
  });

  it("rejects invalid value types", () => {
    const { file } = writeTempVarsFile(JSON.stringify({ meta: { nested: true } }));

    expect(() => loadTemplateVarsFile(file))
      .toThrow(`Template variable \"meta\" in \"${file}\" must be a string, number, boolean, or null.`);
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