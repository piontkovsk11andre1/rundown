import path from "node:path";
import { CONFIG_DIR_NAME } from "./ports/config-dir-port.js";

/**
 * Additional template variables supplied at runtime.
 */
export type ExtraTemplateVars = Record<string, string>;

// Default file name used for persisted template variables.
const DEFAULT_TEMPLATE_VARS_FILE_NAME = "vars.json";

/**
 * Default path to the template variables file in the rundown config directory.
 */
export const DEFAULT_TEMPLATE_VARS_FILE = path.join(CONFIG_DIR_NAME, DEFAULT_TEMPLATE_VARS_FILE_NAME);

// Valid variable names must start with a letter or underscore.
const TEMPLATE_VAR_KEY = /^[A-Za-z_]\w*$/;

/**
 * Parses CLI-provided template variable entries in key=value format.
 *
 * @param entries Raw CLI entries passed via template variable options.
 * @returns Parsed template variable map keyed by variable name.
 * @throws Error If an entry is missing a key/value delimiter.
 * @throws Error If a variable name does not match the supported pattern.
 */
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

/**
 * Resolves the effective template variables file path from CLI options.
 *
 * @param option Template vars option value (boolean toggle or explicit path).
 * @param configDir Optional resolved config directory path.
 * @returns Explicit path, default path when enabled, or undefined when disabled.
 */
export function resolveTemplateVarsFilePath(
  option: string | boolean | undefined,
  configDir?: string,
): string | undefined {
  if (option === true) {
    return configDir
      ? path.join(configDir, DEFAULT_TEMPLATE_VARS_FILE_NAME)
      : DEFAULT_TEMPLATE_VARS_FILE;
  }

  return typeof option === "string" ? option : undefined;
}

/**
 * Builds environment variables for extra template vars.
 *
 * @param vars Extra template variables.
 * @returns Environment variables prefixed with RUNDOWN_VAR_.
 */
export function buildRundownVarEnv(vars: ExtraTemplateVars): Record<string, string> {
  const envVars: Record<string, string> = {};

  for (const [key, value] of Object.entries(vars)) {
    envVars[`RUNDOWN_VAR_${key.toUpperCase()}`] = value;
  }

  return envVars;
}

/**
 * Formats extra template variables for prompt display.
 *
 * @param vars Extra template variables.
 * @returns Human-readable key=value lines or "(none)".
 */
export function formatTemplateVarsForPrompt(vars: ExtraTemplateVars): string {
  const entries = Object.entries(vars);

  if (entries.length === 0) {
    return "(none)";
  }

  return entries
    .sort(([keyA], [keyB]) => keyA.localeCompare(keyB))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}
