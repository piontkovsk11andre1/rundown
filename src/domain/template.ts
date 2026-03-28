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
  /** Parsed verification result text (available during correction). */
  verificationResult?: string;
  /** Command output from the previous run (if captured). */
  commandOutput?: string;
  /** JSON array of nested checkbox children for the selected task. */
  children?: string;
  /** JSON array of nested non-checkable sub-items for the selected task. */
  subItems?: string;
}

interface TaskHierarchyLike {
  children?: unknown;
  subItems?: unknown;
}

/**
 * Serialize task hierarchy fields for template usage.
 */
export function buildTaskHierarchyTemplateVars(task: TaskHierarchyLike): Pick<TemplateVars, "children" | "subItems"> {
  const children = Array.isArray(task.children) ? task.children : [];
  const subItems = Array.isArray(task.subItems) ? task.subItems : [];
  return {
    children: JSON.stringify(children),
    subItems: JSON.stringify(subItems),
  };
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
