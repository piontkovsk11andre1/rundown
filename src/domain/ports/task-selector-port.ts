import type { Task } from "../parser.js";
import type { SortMode } from "../sorting.js";

export interface TaskSelectionResult {
  task: Task;
  source: string;
  contextBefore: string;
}

export interface TaskSelectorPort {
  selectNextTask(files: string[], sortMode: SortMode): TaskSelectionResult | null;
  selectTaskByLocation(filePath: string, line: number): TaskSelectionResult | null;
}
