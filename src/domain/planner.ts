import type { Task } from "./parser.js";

/** Re-export the task shape used by planner insertion helpers. */
export type { Task } from "./parser.js";

/** Aggregate change stats for unchecked TODO items in a plan edit. */
export interface PlanEditStats {
  added: number;
  removed: number;
  reordered: number;
}

/** Result returned by plan-edit validation. */
export interface ValidatePlanEditResult {
  valid: boolean;
  rejectionReason?: string;
  stats: PlanEditStats;
}

/**
 * Validates planner-authored document edits against checkbox safety rules.
 *
 * Rules:
 * - Checked items cannot be removed.
 * - Unchecked items cannot be converted to checked.
 * - Unchecked items may be inserted, removed, or reordered.
 */
export function validatePlanEdit(beforeSource: string, afterSource: string): ValidatePlanEditResult {
  const beforeLines = parseTodoCheckboxLines(beforeSource);
  const afterLines = parseTodoCheckboxLines(afterSource);

  const beforeCheckedCounts = toCountMap(beforeLines.filter((line) => line.checked).map((line) => line.normalized));
  const afterCheckedCounts = toCountMap(afterLines.filter((line) => line.checked).map((line) => line.normalized));

  const beforeUnchecked = beforeLines.filter((line) => !line.checked).map((line) => line.normalized);
  const afterUnchecked = afterLines.filter((line) => !line.checked).map((line) => line.normalized);
  const beforeUncheckedCounts = toCountMap(beforeUnchecked);
  const afterUncheckedCounts = toCountMap(afterUnchecked);

  const stats = computeUncheckedStats(beforeUnchecked, afterUnchecked, beforeUncheckedCounts, afterUncheckedCounts);

  for (const [identity, beforeCount] of beforeCheckedCounts.entries()) {
    const afterCount = afterCheckedCounts.get(identity) ?? 0;
    if (afterCount < beforeCount) {
      return {
        valid: false,
        rejectionReason: "Plan edit attempted to remove checked TODO items, which is not allowed.",
        stats,
      };
    }
  }

  for (const [identity, afterCount] of afterCheckedCounts.entries()) {
    const beforeCount = beforeCheckedCounts.get(identity) ?? 0;
    if (afterCount > beforeCount) {
      return {
        valid: false,
        rejectionReason: "Plan edit attempted to check off TODO items (`[ ]` to `[x]`), which is not allowed.",
        stats,
      };
    }
  }

  return {
    valid: true,
    stats,
  };
}

function toCountMap(lines: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

function computeUncheckedStats(
  beforeUnchecked: string[],
  afterUnchecked: string[],
  beforeCounts: Map<string, number>,
  afterCounts: Map<string, number>,
): PlanEditStats {
  const identities = new Set<string>([...beforeCounts.keys(), ...afterCounts.keys()]);
  let added = 0;
  let removed = 0;
  let shared = 0;

  for (const identity of identities) {
    const beforeCount = beforeCounts.get(identity) ?? 0;
    const afterCount = afterCounts.get(identity) ?? 0;
    if (afterCount > beforeCount) {
      added += afterCount - beforeCount;
    } else if (beforeCount > afterCount) {
      removed += beforeCount - afterCount;
    }

    shared += Math.min(beforeCount, afterCount);
  }

  const lcsLength = longestCommonSubsequenceLength(beforeUnchecked, afterUnchecked);
  const reordered = Math.max(0, shared - lcsLength);

  return { added, removed, reordered };
}

function longestCommonSubsequenceLength(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const previous = new Array<number>(right.length + 1).fill(0);
  const current = new Array<number>(right.length + 1).fill(0);

  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      if (left[i - 1] === right[j - 1]) {
        current[j] = previous[j - 1] + 1;
      } else {
        current[j] = Math.max(previous[j], current[j - 1]);
      }
    }

    for (let j = 0; j <= right.length; j += 1) {
      previous[j] = current[j];
      current[j] = 0;
    }
  }

  return previous[right.length] ?? 0;
}

/** Converts checked/unchecked checkbox lines into canonical unchecked form. */
function normalizeTodoCheckboxLine(line: string): string {
  return line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "- [ ] ").trim();
}

interface ParsedTodoCheckboxLine {
  normalized: string;
  checked: boolean;
}

/** Parses checkbox list lines and records normalized content plus checked state. */
function parseTodoCheckboxLines(source: string): ParsedTodoCheckboxLine[] {
  const lines = source.split(/\r?\n/);
  const checkboxPattern = /^\s*[-*+]\s+\[([ xX])\]\s+\S/;
  const parsed: ParsedTodoCheckboxLine[] = [];

  for (const line of lines) {
    const match = line.match(checkboxPattern);
    if (!match) {
      continue;
    }

    parsed.push({
      normalized: normalizeTodoCheckboxLine(line),
      checked: /[xX]/.test(match[1]),
    });
  }

  return parsed;
}


/**
 * Computes two-space child indentation from a parent list-item line.
 *
 * @param parentLine Parent task line from source Markdown.
 * @returns Child indentation prefix that preserves leading whitespace.
 */
export function computeChildIndent(parentLine: string): string {
  const leadingWhitespace = parentLine.match(/^(\s*)/)?.[1] ?? "";
  const indentUnit = "  ";
  return leadingWhitespace + indentUnit;
}

/**
 * Inserts planner-generated sub-items directly beneath a selected task.
 *
 * @param source Original Markdown source.
 * @param task Task that will receive inserted sub-items.
 * @param subitemLines Planner-generated sub-item list lines.
 * @returns Updated source with correctly indented child list items.
 */
export function insertSubitems(
  source: string,
  task: Task,
  subitemLines: string[],
  options?: {
    dedupeWithExisting?: boolean;
  },
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
  const dedupeWithExisting = options?.dedupeWithExisting === true;

  const existingImmediateChildCounts = dedupeWithExisting
    ? collectImmediateChildCounts(lines, parentLineIndex, indent)
    : new Map<string, number>();

  const indented: string[] = [];
  for (const item of subitemLines) {
    const text = item.replace(/^[-*+]\s+/, "");
    const insertedLine = `${indent}- ${text}`;
    if (!dedupeWithExisting) {
      indented.push(insertedLine);
      continue;
    }

    const normalized = normalizeTodoChildLine(insertedLine);
    const existingCount = existingImmediateChildCounts.get(normalized) ?? 0;
    if (existingCount > 0) {
      existingImmediateChildCounts.set(normalized, existingCount - 1);
      continue;
    }

    indented.push(insertedLine);
  }

  if (indented.length === 0) {
    return source;
  }

  lines.splice(parentLineIndex + 1, 0, ...indented);

  return lines.join(eol);
}

function collectImmediateChildCounts(lines: string[], parentLineIndex: number, childIndent: string): Map<string, number> {
  const parentIndentLength = (lines[parentLineIndex]?.match(/^(\s*)/)?.[1] ?? "").length;
  const childIndentLength = childIndent.length;
  const counts = new Map<string, number>();

  for (let index = parentLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      continue;
    }

    const leadingWhitespaceLength = (line.match(/^(\s*)/)?.[1] ?? "").length;
    if (leadingWhitespaceLength <= parentIndentLength) {
      break;
    }

    if (leadingWhitespaceLength !== childIndentLength) {
      continue;
    }

    if (!/^\s*[-*+]\s+/.test(line)) {
      continue;
    }

    const normalized = normalizeTodoChildLine(line);
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  return counts;
}

function normalizeTodoChildLine(line: string): string {
  return line.replace(/^\s*[-*+]\s+/, "- ").trim();
}

const CHECKBOX_PATTERN = /^\s*[-*+]\s+\[([ xX])\]\s+\S/;
const FENCE_PATTERN = /^\s*(`{3,}|~{3,})/;

function classifyTodoLinesOutsideFences(lines: string[]): { proseLines: string[]; todoLines: string[]; todoIndices: number[] } {
  const proseLines: string[] = [];
  const todoLines: string[] = [];
  const todoIndices: number[] = [];
  let openFence: { char: "`" | "~"; length: number } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const char = marker[0] as "`" | "~";
      const length = marker.length;

      if (openFence === null) {
        openFence = { char, length };
        proseLines.push(line);
        continue;
      }

      if (openFence.char === char && length >= openFence.length) {
        openFence = null;
        proseLines.push(line);
        continue;
      }
    }

    if (openFence !== null) {
      proseLines.push(line);
      continue;
    }

    if (CHECKBOX_PATTERN.test(line)) {
      todoLines.push(line);
      todoIndices.push(index);
      continue;
    }

    proseLines.push(line);
  }

  return { proseLines, todoLines, todoIndices };
}

/**
 * Relocates planner-added TODO checkbox lines to the best tail location.
 *
 * Existing TODO lines must keep their current positions. Only newly inserted
 * TODO lines are moved:
 * - If the document already ends with a TODO list block, append new items to it.
 * - Otherwise, append new items at the very end of the document.
 */
export function relocateInsertedTodosToEnd(beforeSource: string, afterSource: string): string {
  const eol = afterSource.includes("\r\n") ? "\r\n" : "\n";
  const beforeLines = beforeSource.split(/\r?\n/);
  const afterLines = afterSource.split(/\r?\n/);

  const { todoLines: beforeTodoLines } = classifyTodoLinesOutsideFences(beforeLines);
  const { todoLines: afterTodoLines } = classifyTodoLinesOutsideFences(afterLines);

  const beforeCounts = toCountMap(beforeTodoLines.map((line) => normalizeTodoCheckboxLine(line)));
  const addedTodoLines: string[] = [];

  for (const line of afterTodoLines) {
    const normalized = normalizeTodoCheckboxLine(line);
    const beforeCount = beforeCounts.get(normalized) ?? 0;
    if (beforeCount > 0) {
      beforeCounts.set(normalized, beforeCount - 1);
      continue;
    }

    addedTodoLines.push(line);
  }

  if (addedTodoLines.length === 0) {
    return afterSource;
  }

  const removableCounts = toCountMap(addedTodoLines.map((line) => normalizeTodoCheckboxLine(line)));
  const linesWithoutAddedTodos: string[] = [];
  let openFence: { char: "`" | "~"; length: number } | null = null;
  for (let i = 0; i < afterLines.length; i += 1) {
    const line = afterLines[i] ?? "";

    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const char = marker[0] as "`" | "~";
      const length = marker.length;
      if (openFence === null) {
        openFence = { char, length };
      } else if (openFence.char === char && length >= openFence.length) {
        openFence = null;
      }
      linesWithoutAddedTodos.push(line);
      continue;
    }

    if (openFence !== null) {
      linesWithoutAddedTodos.push(line);
      continue;
    }

    if (!CHECKBOX_PATTERN.test(line)) {
      linesWithoutAddedTodos.push(line);
      continue;
    }

    const normalized = normalizeTodoCheckboxLine(line);
    const removableCount = removableCounts.get(normalized) ?? 0;
    if (removableCount > 0) {
      removableCounts.set(normalized, removableCount - 1);
      continue;
    }

    linesWithoutAddedTodos.push(line);
  }

  while (linesWithoutAddedTodos.length > 0 && linesWithoutAddedTodos[linesWithoutAddedTodos.length - 1]!.trim() === "") {
    linesWithoutAddedTodos.pop();
  }

  const hasTrailingTodoGroup = endsWithTodoBlockOutsideFences(linesWithoutAddedTodos);

  const result = [...linesWithoutAddedTodos];
  if (!hasTrailingTodoGroup && result.length > 0) {
    result.push("");
  }

  result.push(...addedTodoLines);

  // Restore a single final newline if the original ended with one.
  const endsWithNewline = afterSource.endsWith("\n") || afterSource.endsWith("\r\n");
  if (endsWithNewline) {
    result.push("");
  }

  return result.join(eol);
}

function endsWithTodoBlockOutsideFences(lines: string[]): boolean {
  let openFence: { char: "`" | "~"; length: number } | null = null;
  let lastMeaningfulIsTodo = false;

  for (const line of lines) {
    const fenceMatch = line.match(FENCE_PATTERN);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const char = marker[0] as "`" | "~";
      const length = marker.length;
      if (openFence === null) {
        openFence = { char, length };
      } else if (openFence.char === char && length >= openFence.length) {
        openFence = null;
      }

      if (line.trim() !== "") {
        lastMeaningfulIsTodo = false;
      }
      continue;
    }

    if (line.trim() === "") {
      continue;
    }

    if (openFence !== null) {
      lastMeaningfulIsTodo = false;
      continue;
    }

    lastMeaningfulIsTodo = CHECKBOX_PATTERN.test(line);
  }

  return lastMeaningfulIsTodo;
}
