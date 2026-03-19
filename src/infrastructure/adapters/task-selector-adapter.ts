import type { TaskSelectorPort } from "../../domain/ports/task-selector-port.js";
import { selectNextTask, selectTaskByLocation } from "../selector.js";

export function createTaskSelectorAdapter(): TaskSelectorPort {
  return {
    selectNextTask(files, sortMode) {
      return selectNextTask(files, sortMode);
    },
    selectTaskByLocation(filePath, line) {
      return selectTaskByLocation(filePath, line);
    },
  };
}
