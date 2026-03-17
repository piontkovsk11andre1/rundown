/**
 * Template renderer.
 *
 * Renders a Markdown template by replacing placeholders with actual values.
 * Placeholders use the form {{variable}}.
 */

/** Variables available inside templates. */
export interface TemplateVars {
  [key: string]: string | number | undefined;
  /** The full text of the selected task. */
  task: string;
  /** The source file path. */
  file: string;
  /** Markdown content of the file up to the task position. */
  context: string;
  /** The zero-based task index in the document. */
  taskIndex: number;
  /** The 1-based line number of the task. */
  taskLine: number;
  /** Full source file content. */
  source: string;
  /** Content of the validation sidecar file (available during correction). */
  validationResult?: string;
  /** Command output from the previous run (if captured). */
  commandOutput?: string;
}

/**
 * Render a Markdown template string with the given variables.
 *
 * Supports placeholders like {{task}}, {{file}}, {{context}}, etc.
 * Unknown placeholders are left as-is.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (key in vars) {
      return String(vars[key as keyof TemplateVars] ?? "");
    }
    return `{{${key}}}`;
  });
}
