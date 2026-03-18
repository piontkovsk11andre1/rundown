/**
 * Planner — decompose a task into subitems.
 *
 * Parses worker output for unchecked Markdown task items and inserts
 * them as nested children directly below the selected parent task,
 * preserving surrounding content and indentation.
 */

import fs from "node:fs";
import type { Task } from "./parser.js";

/**
 * Parse planner output into clean task lines.
 *
 * Accepts raw worker output and extracts lines that look like
 * unchecked Markdown task items (any standard bullet marker).
 * Returns the bare task lines with leading whitespace stripped.
 */
export function parsePlannerOutput(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const taskPattern = /^\s*[-*+]\s+\[ \]\s+\S/;

  return lines
    .filter((line) => taskPattern.test(line))
    .map((line) => line.replace(/^\s+/, ""));
}

/**
 * Compute the indentation prefix for child items under a parent task.
 *
 * Uses the parent task's line to detect existing indentation style,
 * then adds one level (2 spaces by default, matching the parent's
 * indent unit if detectable).
 */
export function computeChildIndent(parentLine: string): string {
  const leadingWhitespace = parentLine.match(/^(\s*)/)?.[1] ?? "";
  // Detect indent unit from the parent's own leading whitespace
  // If parent is already indented, use the same unit; otherwise default to 2 spaces
  const indentUnit = "  ";
  return leadingWhitespace + indentUnit;
}

/**
 * Insert subtask lines below a parent task in the source file.
 *
 * The new items are inserted on the line immediately after the parent
 * task, indented one level deeper. Returns the updated source string.
 */
export function insertSubitems(
  source: string,
  task: Task,
  subitemLines: string[],
): string {
  if (subitemLines.length === 0) return source;

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const parentLineIndex = task.line - 1;

  if (parentLineIndex < 0 || parentLineIndex >= lines.length) {
    throw new Error(`Task line ${task.line} is out of range.`);
  }

  const parentLine = lines[parentLineIndex]!;
  const indent = computeChildIndent(parentLine);

  // Indent each subitem and normalize bullet to match standard form
  const indented = subitemLines.map((item) => {
    // Strip the existing bullet and re-add with proper indent
    const text = item.replace(/^[-*+]\s+/, "");
    return `${indent}- ${text}`;
  });

  // Insert after the parent line
  lines.splice(parentLineIndex + 1, 0, ...indented);

  return lines.join(eol);
}

/**
 * Apply planner output to a source file on disk.
 *
 * Reads the file, parses the planner output, inserts subitems,
 * and writes the result back. Returns the number of subitems inserted.
 */
export function applyPlannerOutput(
  task: Task,
  plannerOutput: string,
): number {
  const subitemLines = parsePlannerOutput(plannerOutput);
  if (subitemLines.length === 0) return 0;

  const source = fs.readFileSync(task.file, "utf-8");
  const updated = insertSubitems(source, task, subitemLines);
  fs.writeFileSync(task.file, updated, "utf-8");

  return subitemLines.length;
}
