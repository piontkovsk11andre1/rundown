import fs from "node:fs";
import path from "node:path";

export type ExtraTemplateVars = Record<string, string>;
export const DEFAULT_TEMPLATE_VARS_FILE = ".md-todo/vars.json";

const TEMPLATE_VAR_KEY = /^[A-Za-z_]\w*$/;

export function parseCliTemplateVars(entries: string[]): ExtraTemplateVars {
  const vars: ExtraTemplateVars = {};

  for (const entry of entries) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error(`Invalid template variable \"${entry}\". Use key=value.`);
    }

    const key = entry.slice(0, equalsIndex).trim();
    const value = entry.slice(equalsIndex + 1);

    if (!TEMPLATE_VAR_KEY.test(key)) {
      throw new Error(`Invalid template variable name \"${key}\". Use letters, numbers, and underscores only.`);
    }

    vars[key] = value;
  }

  return vars;
}

export function loadTemplateVarsFile(filePath: string, cwd: string = process.cwd()): ExtraTemplateVars {
  const resolvedPath = path.resolve(cwd, filePath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  } catch (error) {
    throw new Error(`Failed to read template vars file \"${filePath}\": ${String(error)}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Template vars file \"${filePath}\" must contain a JSON object.`);
  }

  const vars: ExtraTemplateVars = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (!TEMPLATE_VAR_KEY.test(key)) {
      throw new Error(`Invalid template variable name \"${key}\" in \"${filePath}\". Use letters, numbers, and underscores only.`);
    }

    if (value === null || value === undefined) {
      vars[key] = "";
      continue;
    }

    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      vars[key] = String(value);
      continue;
    }

    throw new Error(`Template variable \"${key}\" in \"${filePath}\" must be a string, number, boolean, or null.`);
  }

  return vars;
}

export function resolveTemplateVarsFilePath(option: string | boolean | undefined): string | undefined {
  if (option === true) {
    return DEFAULT_TEMPLATE_VARS_FILE;
  }

  return typeof option === "string" ? option : undefined;
}