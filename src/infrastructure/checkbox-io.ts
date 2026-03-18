/**
 * Checkbox updater.
 *
 * Updates a task's checkbox from unchecked to checked in the raw Markdown source,
 * preserving all other formatting.
 */

import fs from "node:fs";
import { markChecked } from "../domain/checkbox.js";
import type { Task } from "../domain/parser.js";

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
