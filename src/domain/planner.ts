import type { Task } from "./parser.js";

export type { Task } from "./parser.js";

export type PlannerSubitemLine = string;

export function parsePlannerOutput(output: string): PlannerSubitemLine[] {
  const lines = output.split(/\r?\n/);
  const taskPattern = /^\s*[-*+]\s+\[ \]\s+\S/;

  return lines
    .filter((line) => taskPattern.test(line))
    .map((line) => line.replace(/^\s+/, ""));
}

export function computeChildIndent(parentLine: string): string {
  const leadingWhitespace = parentLine.match(/^(\s*)/)?.[1] ?? "";
  const indentUnit = "  ";
  return leadingWhitespace + indentUnit;
}

export function insertSubitems(
  source: string,
  task: Task,
  subitemLines: PlannerSubitemLine[],
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

  const indented = subitemLines.map((item) => {
    const text = item.replace(/^[-*+]\s+/, "");
    return `${indent}- ${text}`;
  });

  lines.splice(parentLineIndex + 1, 0, ...indented);

  return lines.join(eol);
}
