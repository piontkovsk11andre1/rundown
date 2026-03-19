export type ExtraTemplateVars = Record<string, string>;
export const DEFAULT_TEMPLATE_VARS_FILE = ".rundown/vars.json";

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

export function resolveTemplateVarsFilePath(option: string | boolean | undefined): string | undefined {
  if (option === true) {
    return DEFAULT_TEMPLATE_VARS_FILE;
  }

  return typeof option === "string" ? option : undefined;
}
