import fs from "node:fs";
import path from "node:path";
import { type ExtraTemplateVars } from "../domain/template-vars.js";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";

const TEMPLATE_VAR_KEY = /^[A-Za-z_]\w*$/;
const DEFAULT_VARS_FILE_NAME = "vars.json";

/**
 * Resolves the effective template variables file path for the current invocation.
 *
 * When the caller requests the default config-relative vars path and an explicit
 * config directory is available, this function redirects to that config directory.
 * Otherwise, it resolves the requested path relative to the provided working directory.
 */
function resolveTemplateVarsPath(filePath: string, cwd: string, configDir?: string): string {
  // Build the canonical default vars path used by CLI callers.
  const defaultRelativePath = path.join(CONFIG_DIR_NAME, DEFAULT_VARS_FILE_NAME);
  // Resolve the default path from the caller's working directory.
  const defaultPathFromCwd = path.resolve(cwd, defaultRelativePath);
  // Resolve the user-provided path from the caller's working directory.
  const resolvedRequestedPath = path.resolve(cwd, filePath);

  // If the request targets the default location, honor an explicit config directory.
  if (configDir && resolvedRequestedPath === defaultPathFromCwd) {
    return path.join(configDir, DEFAULT_VARS_FILE_NAME);
  }

  return resolvedRequestedPath;
}

/**
 * Loads and validates template variables from a JSON file.
 *
 * Accepted values are strings, numbers, booleans, and null. Values are normalized
 * to string form for downstream template interpolation. Null and undefined values
 * are treated as empty strings.
 */
export function loadTemplateVarsFile(
  filePath: string,
  cwd: string = process.cwd(),
  configDir?: string,
): ExtraTemplateVars {
  // Resolve the on-disk path, accounting for config directory overrides.
  const resolvedPath = resolveTemplateVarsPath(filePath, cwd, configDir);

  let parsed: unknown;
  try {
    // Read and parse the vars file as JSON.
    parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf-8"));
  } catch (error) {
    throw new Error(`Failed to read template vars file \"${filePath}\": ${String(error)}`);
  }

  // Enforce an object root shape so variables can be iterated as key/value pairs.
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Template vars file \"${filePath}\" must contain a JSON object.`);
  }

  const vars: ExtraTemplateVars = {};

  for (const [key, value] of Object.entries(parsed)) {
    // Validate variable names against the supported identifier format.
    if (!TEMPLATE_VAR_KEY.test(key)) {
      throw new Error(`Invalid template variable name \"${key}\" in \"${filePath}\". Use letters, numbers, and underscores only.`);
    }

    // Normalize nullish values to empty strings for predictable interpolation.
    if (value === null || value === undefined) {
      vars[key] = "";
      continue;
    }

    // Coerce scalar primitives into string values consumed by template rendering.
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      vars[key] = String(value);
      continue;
    }

    throw new Error(`Template variable \"${key}\" in \"${filePath}\" must be a string, number, boolean, or null.`);
  }

  return vars;
}
