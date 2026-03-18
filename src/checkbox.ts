/**
 * Checkbox updater.
 *
 * Updates a task's checkbox from unchecked to checked in the raw Markdown source,
 * preserving all other formatting.
 */

import fs from "node:fs";
import type { Task } from "./parser.js";

/**
 * Mark a task as checked by rewriting the source file.
 *
 * This performs a precise in-place replacement of `[ ]` → `[x]`
 * at the task's known position, preserving the rest of the file.
 */
export function checkTask(task: Task): void {
  const source = fs.readFileSync(task.file, "utf-8");
  const updated = markChecked(source, task);
  fs.writeFileSync(task.file, updated, "utf-8");
}

/**
 * Replace the first `[ ]` on the task's line with `[x]`.
 *
 * Uses the task's line number for safety.
 */
export function markChecked(source: string, task: Task): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const lineIndex = task.line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Task line ${task.line} is out of range in ${task.file}`);
  }

  const line = lines[lineIndex]!;
  const updated = line.replace(/\[ \]/, "[x]");

  if (updated === line) {
    throw new Error(`Could not find unchecked checkbox on line ${task.line} in ${task.file}`);
  }

  lines[lineIndex] = updated;
  return lines.join(eol);
}
