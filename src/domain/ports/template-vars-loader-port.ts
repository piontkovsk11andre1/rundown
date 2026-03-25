import type { ExtraTemplateVars } from "../template-vars.js";

export interface TemplateVarsLoaderPort {
  load(filePath: string, cwd: string): ExtraTemplateVars;
}