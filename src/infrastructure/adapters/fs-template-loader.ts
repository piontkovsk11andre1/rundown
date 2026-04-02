import fs from "node:fs";
import type { TemplateLoader } from "../../domain/ports/template-loader.js";

/**
 * Creates a filesystem-backed template loader.
 *
 * The loader reads template files synchronously and returns `null` when a file
 * cannot be read so callers can handle missing or inaccessible templates
 * without throwing.
 */
export function createFsTemplateLoader(): TemplateLoader {
  return {
    /**
     * Loads the template content for the provided path.
     *
     * @param filePath Absolute or relative path to the template file.
     * @returns Template content when readable; otherwise `null`.
     */
    load(filePath) {
      try {
        // Read and return the template content as UTF-8 text.
        return fs.readFileSync(filePath, "utf-8");
      } catch {
        // Normalize read failures to `null` for the domain contract.
        return null;
      }
    },
  };
}
