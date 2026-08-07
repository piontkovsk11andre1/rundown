/**
 * Severity classification for a memory validation issue.
 */
export type MemoryIssueSeverity = "error" | "warning";

/**
 * Describes a single issue found while validating source-local memory.
 */
export interface MemoryIssue {
  // Severity used to communicate whether the issue is broken or stale/drift.
  severity: MemoryIssueSeverity;
  // Stable issue code for machine-readable consumers.
  code: string;
  // Human-readable explanation suitable for CLI output.
  message: string;
}

/**
 * Result envelope produced by memory validation workflows.
 */
export interface MemoryValidationResult {
  // Canonical source markdown path used for validation.
  sourcePath: string;
  // Absolute path to the source-local memory body file.
  memoryFilePath: string;
  // Collected validation issues for the source memory artifacts.
  issues: MemoryIssue[];
}
