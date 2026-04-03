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

  /** Whether source-local memory metadata is available for this document. */
  memoryStatus?: string;

  /** Source-local memory file path for this document. */
  memoryFilePath?: string;

  /** Short human-readable summary of memory context for this document. */
  memorySummary?: string;

  /** Source-local memory index metadata path for this document. */
  memoryIndexPath?: string;

  /** Compact JSON map of memory metadata for prompt/template rendering. */
  memoryMap?: string;

  /** JSON array of nested checkbox children for the selected task. */
  children?: string;

  /** JSON array of nested non-checkable sub-items for the selected task. */
  subItems?: string;
}

const MEMORY_INDEX_FILE_NAME = "memory-index.json";

type MemoryTemplateMetadata = {
  available: boolean;
  filePath: string;
  summary?: string;
};

/**
 * Builds stable memory template variables from source-local memory metadata.
 *
 * The returned map is intentionally compact and excludes raw memory body
 * contents so prompts can reference memory artifacts without context bloat.
 */
export function buildMemoryTemplateVars(params: {
  memoryMetadata: MemoryTemplateMetadata | null;
}): Pick<TemplateVars, "memoryStatus" | "memoryFilePath" | "memorySummary" | "memoryIndexPath" | "memoryMap"> {
  const { memoryMetadata } = params;
  const memoryStatus = memoryMetadata?.available ? "available" : "unavailable";
  const memoryFilePath = memoryMetadata?.filePath ?? "";
  const memorySummary = memoryMetadata?.summary ?? "";
  const memoryIndexPath = deriveMemoryIndexPath(memoryFilePath);

  return {
    memoryStatus,
    memoryFilePath,
    memorySummary,
    memoryIndexPath,
    memoryMap: JSON.stringify({
      status: memoryStatus,
      filePath: memoryFilePath,
      summary: memorySummary,
      indexPath: memoryIndexPath,
    }),
  };
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

function deriveMemoryIndexPath(memoryFilePath: string): string {
  if (memoryFilePath.length === 0) {
    return "";
  }

  const separatorIndex = Math.max(memoryFilePath.lastIndexOf("/"), memoryFilePath.lastIndexOf("\\"));
  if (separatorIndex < 0) {
    return MEMORY_INDEX_FILE_NAME;
  }

  return memoryFilePath.slice(0, separatorIndex + 1) + MEMORY_INDEX_FILE_NAME;
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
