/**
 * Task selector.
 *
 * Given a list of sorted Markdown file paths, scans each file in order
 * and selects the first unchecked task.
 */

import fs from "node:fs";
import { parseTasks, type Task } from "./parser.js";
import { sortFiles, type SortMode } from "./sorting.js";

export interface SelectionResult {
  /** The selected task. */
  task: Task;
  /** Full source content of the file containing the task. */
  source: string;
  /** Content of the file up to (but not including) the task line. */
  contextBefore: string;
}

/**
 * Find the next unchecked task across all given files.
 *
 * Files are sorted according to `sortMode` before scanning.
 * Inside each file, tasks are scanned in document order.
 * The first unchecked task found is returned.
 */
export function selectNextTask(
  files: string[],
  sortMode: SortMode = "name-sort",
): SelectionResult | null {
  const sorted = sortFiles(files, sortMode);

  for (const file of sorted) {
    const source = fs.readFileSync(file, "utf-8");
    const tasks = parseTasks(source, file);

    for (const task of tasks) {
      if (!task.checked) {
        const lines = source.split("\n");
        const contextBefore = lines.slice(0, task.line - 1).join("\n");

        return { task, source, contextBefore };
      }
    }
  }

  return null;
}
