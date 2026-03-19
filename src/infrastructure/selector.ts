/**
 * Task selector.
 *
 * Given a list of sorted Markdown file paths, scans each file in order
 * and selects the first runnable unchecked task.
 *
 * A task is runnable only when it is unchecked and has no unchecked
 * descendants. This ensures child tasks are completed before their
 * parent becomes eligible for execution.
 */

import fs from "node:fs";
import { parseTasks, type Task } from "../domain/parser.js";
import { filterRunnable } from "../domain/task-selection.js";
import { sortFiles, type SortMode } from "../domain/sorting.js";
import { getFileBirthtimeMs } from "./file-birthtime.js";

const selectorFileSystem = {
  stat(filePath: string) {
    const stats = fs.statSync(filePath);
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      birthtimeMs: stats.birthtimeMs,
      mtimeMs: stats.mtimeMs,
    };
  },
};

export interface SelectionResult {
  /** The selected task. */
  task: Task;
  /** Full source content of the file containing the task. */
  source: string;
  /** Content of the file up to (but not including) the task line. */
  contextBefore: string;
}

/**
 * Find the next runnable unchecked task across all given files.
 *
 * Files are sorted according to `sortMode` before scanning.
 * Inside each file, tasks are scanned in document order.
 *
 * A task is runnable when it is unchecked and has no unchecked
 * descendants (children at a greater depth that follow it in
 * document order before the next sibling or shallower task).
 */
export function selectNextTask(
  files: string[],
  sortMode: SortMode = "name-sort",
): SelectionResult | null {
  const sorted = sortFiles(files, sortMode, {
    getBirthtimeMs: (filePath) => getFileBirthtimeMs(filePath, selectorFileSystem),
  });

  for (const file of sorted) {
    const source = fs.readFileSync(file, "utf-8");
    const tasks = parseTasks(source, file);
    const runnable = filterRunnable(tasks);

    for (const task of runnable) {
      const lines = source.split("\n");
      const contextBefore = lines.slice(0, task.line - 1).join("\n");

      return { task, source, contextBefore };
    }
  }

  return null;
}

/**
 * Select a specific task by file path and 1-based line number.
 *
 * Returns the task at the given line along with contextBefore,
 * or null if no task exists at that line.
 */
export function selectTaskByLocation(
  file: string,
  line: number,
): SelectionResult | null {
  const source = fs.readFileSync(file, "utf-8");
  const tasks = parseTasks(source, file);
  const task = tasks.find((t) => t.line === line);

  if (!task) {
    return null;
  }

  const lines = source.split("\n");
  const contextBefore = lines.slice(0, task.line - 1).join("\n");

  return { task, source, contextBefore };
}
