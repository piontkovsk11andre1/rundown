import type { Task } from "./parser.js";

export type { Task } from "./parser.js";

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

/**
 * Replace the first `[x]` on the task's line with `[ ]`.
 *
 * Uses the task's line number for safety.
 */
export function markUnchecked(source: string, task: Task): string {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const lineIndex = task.line - 1;

  if (lineIndex < 0 || lineIndex >= lines.length) {
    throw new Error(`Task line ${task.line} is out of range in ${task.file}`);
  }

  const line = lines[lineIndex]!;
  const updated = line.replace(/\[x\]/, "[ ]");

  if (updated === line) {
    throw new Error(`Could not find checked checkbox on line ${task.line} in ${task.file}`);
  }

  lines[lineIndex] = updated;
  return lines.join(eol);
}
