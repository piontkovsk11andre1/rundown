import { markChecked, markTasksChecked, resetAllCheckboxes } from "../domain/checkbox.js";
import { computeChildIndent, insertSubitems } from "../domain/planner.js";
import { parseTasks, type Task } from "../domain/parser.js";
import { findRemainingSiblings, findUncheckedDescendants } from "../domain/task-selection.js";
import type { FileSystem } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

const TRACE_STATISTICS_CHILD_LABEL_PATTERN = /^(?:total time|execution|verify|repair|idle|tokens estimated|phases|verify attempts|repair attempts):\s+\S/i;
const TRACE_STATISTICS_GRANDCHILD_LABEL_PATTERN = /^(?:execution|verify|repair):\s+\S/i;
const RUNTIME_STALE_CHILD_LABEL_PATTERN = /^(?:total time|execution|verify|repair|idle|tokens estimated|phases|verify attempts|repair attempts|fix|skipped):\s+\S/i;

interface FileMutationQueue {
  locked: boolean;
  operations: Array<() => void>;
}

const fileMutationQueues = new Map<string, FileMutationQueue>();

function withSerializedFileMutation(filePath: string, operation: () => void): void {
  const existingQueue = fileMutationQueues.get(filePath);
  const queue = existingQueue ?? { locked: false, operations: [] };
  if (!existingQueue) {
    fileMutationQueues.set(filePath, queue);
  }

  queue.operations.push(operation);

  if (queue.locked) {
    return;
  }

  let firstError: unknown = null;
  queue.locked = true;
  try {
    while (queue.operations.length > 0) {
      const nextOperation = queue.operations.shift();
      if (!nextOperation) {
        continue;
      }

      try {
        nextOperation();
      } catch (error) {
        if (firstError === null) {
          firstError = error;
        }
      }
    }
  } finally {
    queue.locked = false;
    if (queue.operations.length === 0) {
      fileMutationQueues.delete(filePath);
    }
  }

  if (firstError !== null) {
    throw firstError;
  }
}

function getLeadingWhitespaceLength(line: string): number {
  return (line.match(/^(\s*)/)?.[1] ?? "").length;
}

function isListItemWithLabel(line: string, labelPattern: RegExp): boolean {
  const match = line.match(/^\s*[-*+]\s+(.*)$/);
  if (!match) {
    return false;
  }

  const label = (match[1] ?? "").replace(/^\[[ xX]\]\s+/, "").trimStart();
  return labelPattern.test(label);
}

function isTraceStatisticsLineForTask(line: string, parentIndentLength: number): boolean {
  const lineIndentLength = getLeadingWhitespaceLength(line);
  if (lineIndentLength === parentIndentLength + 2) {
    return isListItemWithLabel(line, TRACE_STATISTICS_CHILD_LABEL_PATTERN);
  }

  if (lineIndentLength === parentIndentLength + 4) {
    return isListItemWithLabel(line, TRACE_STATISTICS_GRANDCHILD_LABEL_PATTERN);
  }

  return false;
}

function stripTrailingTraceStatisticsLines(
  lines: string[],
  parentLineIndex: number,
  descendantEndIndexExclusive: number,
): number {
  const parentLine = lines[parentLineIndex] ?? "";
  const parentIndentLength = getLeadingWhitespaceLength(parentLine);
  let removeStartIndex = descendantEndIndexExclusive;

  for (let index = descendantEndIndexExclusive - 1; index > parentLineIndex; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      if (removeStartIndex < descendantEndIndexExclusive) {
        removeStartIndex = index;
        continue;
      }

      break;
    }

    if (!isTraceStatisticsLineForTask(line, parentIndentLength)) {
      break;
    }

    removeStartIndex = index;
  }

  if (removeStartIndex < descendantEndIndexExclusive) {
    lines.splice(removeStartIndex, descendantEndIndexExclusive - removeStartIndex);
  }

  return removeStartIndex;
}

function stripRuntimeStaleDescendantBlocks(
  lines: string[],
  parentLineIndex: number,
  descendantEndIndexExclusive: number,
): number {
  const parentLine = lines[parentLineIndex] ?? "";
  const parentIndentLength = getLeadingWhitespaceLength(parentLine);
  const staleChildIndentLength = parentIndentLength + 2;
  let adjustedEndIndexExclusive = descendantEndIndexExclusive;
  let index = parentLineIndex + 1;

  while (index < adjustedEndIndexExclusive) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (getLeadingWhitespaceLength(line) !== staleChildIndentLength
      || !isListItemWithLabel(line, RUNTIME_STALE_CHILD_LABEL_PATTERN)) {
      index += 1;
      continue;
    }

    let removeEndIndexExclusive = index + 1;
    while (removeEndIndexExclusive < adjustedEndIndexExclusive) {
      const candidate = lines[removeEndIndexExclusive] ?? "";
      if (candidate.trim().length === 0) {
        removeEndIndexExclusive += 1;
        continue;
      }

      if (getLeadingWhitespaceLength(candidate) <= staleChildIndentLength) {
        break;
      }

      removeEndIndexExclusive += 1;
    }

    const deleteCount = removeEndIndexExclusive - index;
    lines.splice(index, deleteCount);
    adjustedEndIndexExclusive -= deleteCount;
  }

  return adjustedEndIndexExclusive;
}

function hasTraceStatisticsInDescendants(
  lines: string[],
  parentLineIndex: number,
  descendantEndIndexExclusive: number,
): boolean {
  const parentLine = lines[parentLineIndex] ?? "";
  const parentIndentLength = getLeadingWhitespaceLength(parentLine);

  for (let index = parentLineIndex + 1; index < descendantEndIndexExclusive; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      continue;
    }

    if (isTraceStatisticsLineForTask(line, parentIndentLength)) {
      return true;
    }
  }

  return false;
}

function stripRuntimeStaleAnnotationsFromSource(source: string, file: string): string {
  const tasks = parseTasks(source, file);
  if (tasks.length === 0) {
    return source;
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const tasksDescending = [...tasks].sort((left, right) => right.line - left.line);

  for (const task of tasksDescending) {
    const parentLineIndex = task.line - 1;
    if (parentLineIndex < 0 || parentLineIndex >= lines.length) {
      continue;
    }

    const parentIndentLength = getLeadingWhitespaceLength(lines[parentLineIndex] ?? "");
    let descendantEndIndexExclusive = parentLineIndex + 1;
    for (let index = parentLineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0) {
        continue;
      }

      if (getLeadingWhitespaceLength(line) <= parentIndentLength) {
        break;
      }

      descendantEndIndexExclusive = index + 1;
    }

    stripRuntimeStaleDescendantBlocks(lines, parentLineIndex, descendantEndIndexExclusive);
  }

  return lines.join(eol);
}

/**
 * Marks a single task as checked in its source file.
 */
export function checkTaskUsingFileSystem(task: Task, fileSystem: FileSystem): void {
  withSerializedFileMutation(task.file, () => {
    const source = fileSystem.readText(task.file);
    const updated = markChecked(source, task);
    fileSystem.writeText(task.file, updated);
  });
}

/**
 * Marks a task checked and appends a verification failure fix annotation.
 */
export function writeFixAnnotationToFile(task: Task, failureReason: string | null, fileSystem: FileSystem): void {
  const reason = failureReason?.trim().length ? failureReason.trim() : "Verification failed (no details).";
  const reasonLines = reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const annotationLines = reasonLines.length > 0
    ? reasonLines.map((line) => `fix: ${line}`)
    : ["fix: Verification failed (no details)."];

  withSerializedFileMutation(task.file, () => {
    const source = fileSystem.readText(task.file);
    let checkedSource = source;
    try {
      checkedSource = markChecked(source, task);
    } catch (error) {
      const lines = source.split(/\r?\n/);
      const taskLine = lines[task.line - 1] ?? "";
      const taskLineAlreadyChecked = /\[[xX]\]/.test(taskLine);
      if (!taskLineAlreadyChecked) {
        throw error;
      }
    }
    const updated = insertSubitems(checkedSource, task, annotationLines);
    fileSystem.writeText(task.file, updated);
  });
}

/**
 * Inserts formatted trace-statistics lines beneath a completed task.
 *
 * The insertion point is after the task's existing descendant block, so any
 * pre-existing child tasks/sub-items remain above the appended statistics.
 */
export function insertTraceStatisticsUsingFileSystem(
  task: Task,
  statisticsLines: string[],
  fileSystem: FileSystem,
): void {
  if (statisticsLines.length === 0) {
    return;
  }

  withSerializedFileMutation(task.file, () => {
    const source = fileSystem.readText(task.file);
    const eol = source.includes("\r\n") ? "\r\n" : "\n";
    const lines = source.split(/\r?\n/);
    const parentLineIndex = task.line - 1;

    if (parentLineIndex < 0 || parentLineIndex >= lines.length) {
      return;
    }

    const parentLine = lines[parentLineIndex] ?? "";
    const parentIndentLength = (parentLine.match(/^(\s*)/)?.[1] ?? "").length;
    const childIndent = computeChildIndent(parentLine);

    let insertionIndex = parentLineIndex + 1;
    for (let index = parentLineIndex + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      if (line.trim().length === 0) {
        continue;
      }

      const lineIndentLength = (line.match(/^(\s*)/)?.[1] ?? "").length;
      if (lineIndentLength <= parentIndentLength) {
        break;
      }

      insertionIndex = index + 1;
    }

    if (hasTraceStatisticsInDescendants(lines, parentLineIndex, insertionIndex)) {
      return;
    }

    insertionIndex = stripTrailingTraceStatisticsLines(lines, parentLineIndex, insertionIndex);

    const minimumLeadingSpaces = statisticsLines.reduce<number>((minimum, line) => {
      if (line.trim().length === 0) {
        return minimum;
      }

      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      return Math.min(minimum, leadingSpaces);
    }, Number.POSITIVE_INFINITY);

    const baseIndent = Number.isFinite(minimumLeadingSpaces) ? minimumLeadingSpaces : 0;
    const relativeIndentUnit = statisticsLines.reduce<number>((minimum, line) => {
      if (line.trim().length === 0) {
        return minimum;
      }

      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      const delta = leadingSpaces - baseIndent;
      if (delta <= 0) {
        return minimum;
      }

      return Math.min(minimum, delta);
    }, Number.POSITIVE_INFINITY);

    const indentUnit = Number.isFinite(relativeIndentUnit) && relativeIndentUnit > 0
      ? relativeIndentUnit
      : 2;

    const adjustedLines = statisticsLines.map((line) => {
      const leadingSpaces = line.match(/^(\s*)/)?.[1].length ?? 0;
      const relativeLevels = Math.max(0, Math.floor((leadingSpaces - baseIndent) / indentUnit));
      const content = line.trimStart();
      return `${childIndent}${"  ".repeat(relativeLevels)}${content}`;
    });

    lines.splice(insertionIndex, 0, ...adjustedLines);
    fileSystem.writeText(task.file, lines.join(eol));
  });
}

/**
 * Marks remaining unchecked siblings (and their unchecked descendants) as checked,
 * and inserts skip-annotation sub-items for each skipped task.
 */
export function skipRemainingSiblingsUsingFileSystem(
  task: Task,
  reason: string,
  fileSystem: FileSystem,
): {
  skippedSiblingCount: number;
  skippedDescendantCount: number;
  skippedTaskTexts: string[];
} {
  let outcome = {
    skippedSiblingCount: 0,
    skippedDescendantCount: 0,
    skippedTaskTexts: [] as string[],
  };

  withSerializedFileMutation(task.file, () => {
    let source = fileSystem.readText(task.file);
    const allTasks = parseTasks(source, task.file);
    const currentTask = allTasks.find((candidate) => candidate.line === task.line && candidate.index === task.index)
      ?? allTasks.find((candidate) => candidate.line === task.line)
      ?? task;

    const remainingSiblings = findRemainingSiblings(currentTask, allTasks);
    if (remainingSiblings.length === 0) {
      outcome = {
        skippedSiblingCount: 0,
        skippedDescendantCount: 0,
        skippedTaskTexts: [],
      };
      return;
    }

    const siblingsDescending = [...remainingSiblings].sort((left, right) => right.line - left.line);
    const tasksToSkip = new Map<number, Task>();

    // Process siblings from bottom to top so sub-item insertion does not shift
    // yet-to-be-processed task line numbers.
    for (const sibling of siblingsDescending) {
      const descendantsDescending = findUncheckedDescendants(sibling, allTasks)
        .sort((left, right) => right.line - left.line);

      for (const descendant of descendantsDescending) {
        tasksToSkip.set(descendant.line, descendant);
      }

      tasksToSkip.set(sibling.line, sibling);
    }

    const orderedTasksToSkip = [...tasksToSkip.values()].sort((left, right) => right.line - left.line);
    const annotation = reason.trim().length > 0 ? reason.trim() : "condition met";

    source = markTasksChecked(source, orderedTasksToSkip);

    for (const skippedTask of orderedTasksToSkip) {
      source = insertSubitems(source, skippedTask, [`skipped: ${annotation}`]);
    }

    fileSystem.writeText(task.file, source);

    outcome = {
      skippedSiblingCount: remainingSiblings.length,
      skippedDescendantCount: Math.max(0, orderedTasksToSkip.length - remainingSiblings.length),
      skippedTaskTexts: remainingSiblings.map((sibling) => sibling.text),
    };
  });

  return outcome;
}

/**
 * Resets all checked tasks in a file, or reports the planned reset in dry-run mode.
 */
export function maybeResetFileCheckboxes(
  file: string,
  fileSystem: FileSystem,
  dryRun: boolean,
  emit: ApplicationOutputPort["emit"],
  phase: "pre-run" | "post-run",
): number {
  const source = fileSystem.readText(file);
  const resetCount = countCheckedTasks(source, file);

  if (dryRun) {
    emit({ kind: "info", message: `Dry run — would reset checkboxes (${phase}) in: ${file}` });
    if (resetCount > 0) {
      const normalized = resetAllCheckboxes(source, file);
      const cleaned = stripRuntimeStaleAnnotationsFromSource(normalized, file);
      if (cleaned !== normalized) {
        emit({ kind: "info", message: `Dry run — would also remove stale runtime annotations in: ${file}` });
      }
    }
    return resetCount;
  }

  resetFileCheckboxes(file, fileSystem);
  emit({ kind: "info", message: `Reset ${resetCount} checkbox${resetCount === 1 ? "" : "es"} in ${file}.` });
  return resetCount;
}

/**
 * Resets all checked markdown task checkboxes in a file.
 */
export function resetFileCheckboxes(file: string, fileSystem: FileSystem): void {
  withSerializedFileMutation(file, () => {
    const source = fileSystem.readText(file);
    const resetCount = countCheckedTasks(source, file);

    // Skip rewriting the file when there is nothing to reset.
    if (resetCount === 0) {
      return;
    }

    const updated = resetAllCheckboxes(source, file);
    const cleaned = stripRuntimeStaleAnnotationsFromSource(updated, file);
    fileSystem.writeText(file, cleaned);
  });
}

/**
 * Counts checked markdown tasks in the provided source text.
 */
export function countCheckedTasks(source: string, file: string): number {
  return parseTasks(source, file).filter((task) => task.checked).length;
}

/**
 * Captures checkbox states in source order for mutation detection.
 */
export interface CheckboxStateSnapshot {
  orderedStates: boolean[];
}

/**
 * Builds a normalized checkbox state snapshot from markdown source text.
 */
export function captureCheckboxState(source: string): CheckboxStateSnapshot {
  // Match markdown list items that contain a checkbox marker and task text.
  const checkboxPattern = /^(\s*[-*+]\s+)\[([ xX])\](\s+\S.*)$/;
  const fencePattern = /^\s*(`{3,}|~{3,})/;
  const lines = source.split(/\r?\n/);
  const orderedStates: boolean[] = [];
  let openFence: { char: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    const fenceMatch = line.match(fencePattern);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      const char = marker[0] as "`" | "~";
      const length = marker.length;

      if (openFence === null) {
        openFence = { char, length };
      } else if (openFence.char === char && length >= openFence.length) {
        openFence = null;
      }
      continue;
    }

    if (openFence !== null) {
      continue;
    }

    const match = line.match(checkboxPattern);
    if (!match) {
      continue;
    }

    // Treat both lowercase and uppercase x markers as checked.
    const checked = /[xX]/.test(match[2]);
    orderedStates.push(checked);
  }

  return {
    orderedStates,
  };
}

/**
 * Detects files whose existing checkbox states changed between snapshots.
 */
export function detectCheckboxMutations(
  files: string[],
  beforeByFile: Map<string, CheckboxStateSnapshot>,
  fileSystem: FileSystem,
): string[] {
  const mutatedFiles: string[] = [];

  for (const filePath of files) {
    const before = beforeByFile.get(filePath);
    if (!before) {
      continue;
    }

    const after = captureCheckboxState(fileSystem.readText(filePath));
    const comparableCount = Math.min(before.orderedStates.length, after.orderedStates.length);
    let hasMutation = false;

    // Compare only shared indexes to ignore unrelated additions/removals.
    for (let index = 0; index < comparableCount; index += 1) {
      if (before.orderedStates[index] !== after.orderedStates[index]) {
        hasMutation = true;
        break;
      }
    }

    if (hasMutation) {
      mutatedFiles.push(filePath);
    }
  }

  return mutatedFiles;
}
