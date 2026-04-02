/**
 * Defines the port for loading template content from a path-like identifier.
 *
 * Implementations return the raw template text when available, or `null`
 * when the template cannot be found or resolved.
 */
export interface TemplateLoader {
  /** Loads template content for the provided file path. */
  load(filePath: string): string | null;
}
