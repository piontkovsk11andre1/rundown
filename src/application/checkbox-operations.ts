import { markChecked, markTasksChecked, resetAllCheckboxes } from "../domain/checkbox.js";
import { insertSubitems } from "../domain/planner.js";
import { parseTasks, type Task } from "../domain/parser.js";
import { findRemainingSiblings, findUncheckedDescendants } from "../domain/task-selection.js";
import type { FileSystem } from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

/**
 * Marks a single task as checked in its source file.
 */
export function checkTaskUsingFileSystem(task: Task, fileSystem: FileSystem): void {
  const source = fileSystem.readText(task.file);
  const updated = markChecked(source, task);
  fileSystem.writeText(task.file, updated);
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
  let source = fileSystem.readText(task.file);
  const allTasks = parseTasks(source, task.file);
  const currentTask = allTasks.find((candidate) => candidate.line === task.line && candidate.index === task.index)
    ?? allTasks.find((candidate) => candidate.line === task.line)
    ?? task;

  const remainingSiblings = findRemainingSiblings(currentTask, allTasks);
  if (remainingSiblings.length === 0) {
    return {
      skippedSiblingCount: 0,
      skippedDescendantCount: 0,
      skippedTaskTexts: [],
    };
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

  return {
    skippedSiblingCount: remainingSiblings.length,
    skippedDescendantCount: Math.max(0, orderedTasksToSkip.length - remainingSiblings.length),
    skippedTaskTexts: remainingSiblings.map((sibling) => sibling.text),
  };
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
  const source = fileSystem.readText(file);
  const resetCount = countCheckedTasks(source, file);

  // Skip rewriting the file when there is nothing to reset.
  if (resetCount === 0) {
    return;
  }

  const updated = resetAllCheckboxes(source, file);
  fileSystem.writeText(file, updated);
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
