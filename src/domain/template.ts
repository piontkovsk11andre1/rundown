/**
 * Template rendering domain utilities.
 *
 * Provides the variable contract and helpers used to interpolate
 * `{{placeholder}}` tokens inside Markdown prompt templates.
 */

/** Variables available to prompt template interpolation. */
export interface TemplateVars {
  // Allow additional ad-hoc variables without changing this contract.
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

/**
 * Minimal task hierarchy shape required for template serialization.
 */
interface TaskHierarchyLike {
  // Child checkbox tasks, if present on the parsed task node.
  children?: unknown;

  // Nested non-checkable bullet items under the selected task.
  subItems?: unknown;
}

/**
 * Builds serialized task hierarchy template variables.
 *
 * Normalizes `children` and `subItems` to arrays and JSON-encodes them so
 * templates can consume deterministic string values.
 */
export function buildTaskHierarchyTemplateVars(task: TaskHierarchyLike): Pick<TemplateVars, "children" | "subItems"> {
  // Ensure template variables always encode arrays, never raw unknown values.
  const children = Array.isArray(task.children) ? task.children : [];
  const subItems = Array.isArray(task.subItems) ? task.subItems : [];

  // Preserve exact structure by serializing arrays into JSON strings.
  return {
    children: JSON.stringify(children),
    subItems: JSON.stringify(subItems),
  };
}

/**
 * Renders a Markdown template with the provided variables.
 *
 * Replaces placeholders in the form `{{name}}` using values from `vars`.
 * Unknown placeholders are preserved to avoid silently losing template intent.
 */
export function renderTemplate(template: string, vars: TemplateVars): string {
  // Match only word-like placeholder names for predictable interpolation.
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    // Use explicit key checks so optional fields still resolve to empty strings.
    if (key in vars) {
      return String(vars[key as keyof TemplateVars] ?? "");
    }

    // Keep unresolved placeholders visible for downstream diagnostics.
    return `{{${key}}}`;
  });
}
