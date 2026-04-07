import type { Task } from "./parser.js";
import { parseTasks } from "./parser.js";

/** Re-export the task shape used by checkbox helpers. */
export type { Task } from "./parser.js";

/**
 * Replace the first `[ ]` on the task's line with `[x]`.
 *
 * Uses the task's line number for safety.
 */
export function markChecked(source: string, task: Task): string {
  // Preserve the original line-ending style when rewriting the file.
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  // Split into logical lines so updates stay scoped to one task line.
  const lines = source.split(/\r?\n/);
  // Convert 1-based parser line numbers to a 0-based array index.
  const lineIndex = task.line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Task line ${task.line} is out of range in ${task.file}`);
  }

  const line = lines[lineIndex]!;
  // Only toggle the first unchecked box on the exact task line.
  const updated = line.replace(/\[ \]/, "[x]");

  if (updated === line) {
    throw new Error(`Could not find unchecked checkbox on line ${task.line} in ${task.file}`);
  }

  lines[lineIndex] = updated;
  return lines.join(eol);
}

/**
 * Replace the first `[x]` on the task's line with `[ ]`.
 *
 * Uses the task's line number for safety.
 */
export function markUnchecked(source: string, task: Task): string {
  // Preserve the original line-ending style when rewriting the file.
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  // Split into logical lines so updates stay scoped to one task line.
  const lines = source.split(/\r?\n/);
  // Convert 1-based parser line numbers to a 0-based array index.
  const lineIndex = task.line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Task line ${task.line} is out of range in ${task.file}`);
  }

  const line = lines[lineIndex]!;
  // Only toggle the first checked box on the exact task line.
  const updated = line.replace(/\[x\]/, "[ ]");

  if (updated === line) {
    throw new Error(`Could not find checked checkbox on line ${task.line} in ${task.file}`);
  }

  lines[lineIndex] = updated;
  return lines.join(eol);
}

/**
 * Marks multiple tasks as checked in a single source rewrite.
 *
 * Tasks are applied from bottom to top so later line insertions in callers do
 * not invalidate line references for earlier tasks.
 */
export function markTasksChecked(source: string, tasks: Task[]): string {
  if (tasks.length === 0) {
    return source;
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const uniqueLinesDescending = [...new Set(tasks.map((task) => task.line))].sort((left, right) => right - left);

  for (const lineNumber of uniqueLinesDescending) {
    const lineIndex = lineNumber - 1;
    if (lineIndex < 0 || lineIndex >= lines.length) {
      throw new Error(`Task line ${lineNumber} is out of range in ${tasks[0]!.file}`);
    }

    const line = lines[lineIndex]!;
    const updated = line.replace(/\[ \]/, "[x]");

    if (updated === line) {
      throw new Error(`Could not find unchecked checkbox on line ${lineNumber} in ${tasks[0]!.file}`);
    }

    lines[lineIndex] = updated;
  }

  return lines.join(eol);
}

/**
 * Reset all checked task checkboxes in a Markdown source back to unchecked.
 *
 * Parses tasks from the original source and applies unchecked updates one by one
 * so each change stays line-accurate and preserves the file's newline format.
 */
export function resetAllCheckboxes(source: string, file: string): string {
  // Keep an evolving source snapshot as each task is toggled back.
  let updatedSource = source;
  // Only process tasks that are currently marked as checked.
  const checkedTasks = parseTasks(source, file).filter((task) => task.checked);

  for (const task of checkedTasks) {
    updatedSource = markUnchecked(updatedSource, task);
  }

  return updatedSource;
}
