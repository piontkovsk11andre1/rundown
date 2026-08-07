/**
 * Result envelope produced by memory cleanup workflows.
 */
export interface MemoryCleanResult {
  // Absolute memory body file paths removed during the cleanup run.
  removed: string[];
  // Total number of bytes reclaimed by removing memory artifacts.
  freedBytes: number;
  // Indicates whether cleanup ran in planning mode without deletions.
  dryRun: boolean;
}
