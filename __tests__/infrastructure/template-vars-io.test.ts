import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadTemplateVarsFile } from "../../src/infrastructure/template-vars-io.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempVarsFile(content: string): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-vars-"));
  tempDirs.push(dir);
  const file = path.join(dir, "vars.json");
  fs.writeFileSync(file, content, "utf-8");
  return { dir, file };
}

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

  it("resolves the file path relative to cwd", () => {
    const { dir } = writeTempVarsFile(JSON.stringify({ release: "stable" }));

    expect(loadTemplateVarsFile("vars.json", dir)).toEqual({ release: "stable" });
  });

  it("resolves default .rundown/vars.json using the resolved config dir", () => {
    const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-config-"));
    tempDirs.push(configRoot);
    const configDir = path.join(configRoot, ".rundown");
    fs.mkdirSync(configDir, { recursive: true });
    const varsFile = path.join(configDir, "vars.json");
    fs.writeFileSync(varsFile, JSON.stringify({ team: "platform" }), "utf-8");

    const cwd = path.join(configRoot, "nested", "repo");
    fs.mkdirSync(cwd, { recursive: true });

    expect(loadTemplateVarsFile(".rundown/vars.json", cwd, configDir)).toEqual({ team: "platform" });
  });

  it("rejects malformed JSON input", () => {
    const { file } = writeTempVarsFile("{not valid json");

    expect(() => loadTemplateVarsFile(file))
      .toThrow(`Failed to read template vars file \"${file}\":`);
  });

  it("rejects invalid template variable names", () => {
    const { file } = writeTempVarsFile(JSON.stringify({ "bad-key": true }));

    expect(() => loadTemplateVarsFile(file))
      .toThrow(`Invalid template variable name \"bad-key\" in \"${file}\". Use letters, numbers, and underscores only.`);
  });
});
