// Reuse the domain template-variables model as the port return type.
import type { ExtraTemplateVars } from "../template-vars.js";

/**
 * Defines the domain contract for loading additional template variables.
 */
export interface TemplateVarsLoaderPort {
  // Resolve external template variables for the active execution context.
  /**
   * Loads additional template variables from a source path.
   *
   * `cwd` is used to resolve relative paths, while `configDir` can scope
   * implementation-specific lookup behavior.
   */
  load(filePath: string, cwd: string, configDir?: string): ExtraTemplateVars;
}
