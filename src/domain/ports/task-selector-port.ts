import type { Task } from "../parser.js";
import type { SortMode } from "../sorting.js";

/**
 * Represents the outcome of resolving a task selection request.
 *
 * The result includes the selected parsed task, the full source document from
 * which the task was resolved, and the leading context that appears before the
 * selected task location.
 */
export interface TaskSelectionResult {
  // The parsed task chosen by the selector implementation.
  task: Task;
  // Full markdown source that contains the selected task.
  source: string;
  // Source text that appears before the selected task, used as context.
  contextBefore: string;
}

/**
 * Port abstraction for resolving tasks from migration source documents.
 */
export interface TaskSelectorPort {
  /**
   * Selects the next task from the provided files using the configured sort mode.
   */
  selectNextTask(files: string[], sortMode: SortMode): TaskSelectionResult[] | null;
  /**
   * Selects a task by explicit file path and line location.
   */
  selectTaskByLocation(filePath: string, line: number): TaskSelectionResult | null;
}
