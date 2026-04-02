import type { TaskSelectorPort } from "../../domain/ports/task-selector-port.js";
import { selectNextTask, selectTaskByLocation } from "../selector.js";

/**
 * Creates a task selector adapter that bridges the domain port to infrastructure selection utilities.
 */
export function createTaskSelectorAdapter(): TaskSelectorPort {
  return {
    // Delegates next-task selection to the shared infrastructure selector implementation.
    selectNextTask(files, sortMode) {
      return selectNextTask(files, sortMode);
    },
    // Delegates location-based task selection to the shared infrastructure selector implementation.
    selectTaskByLocation(filePath, line) {
      return selectTaskByLocation(filePath, line);
    },
  };
}
