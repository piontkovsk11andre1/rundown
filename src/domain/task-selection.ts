import type { Task } from "./parser.js";

/**
 * Options that control how unchecked descendant checks are performed.
 */
export interface DescendantSelectionOptions {
  /**
   * Prefer traversing `task.children` when present.
   * Falls back to linear scan when no children are attached.
   */
  useChildren?: boolean;
}

/**
 * Determine whether a task has unchecked descendants.
 *
 * Descendants are tasks that appear after the given task in document
 * order and have a strictly greater depth, up to the next task at the
 * same or shallower depth.
 */
export function hasUncheckedDescendants(
  task: Task,
  allTasks: Task[],
  options: DescendantSelectionOptions = {},
): boolean {
  // Prefer tree traversal when parser-attached children are available.
  if (options.useChildren) {
    const children = task.children ?? [];
    if (children.length > 0) {
      return hasUncheckedInTree(children);
    }
  }

  // Locate the task in document order to scan only its descendant range.
  const startIdx = allTasks.indexOf(task);
  if (startIdx === -1) return false;

  for (let i = startIdx + 1; i < allTasks.length; i++) {
    const candidate = allTasks[i]!;
    // Stop once we leave this task's subtree.
    if (candidate.depth <= task.depth) break;
    // Any unchecked descendant means the current task is not runnable yet.
    if (!candidate.checked) return true;
  }

  return false;
}

/**
 * Recursively checks whether any task in a child subtree is unchecked.
 */
function hasUncheckedInTree(children: Task[]): boolean {
  for (const child of children) {
    // Return immediately for the first unchecked child encountered.
    if (!child.checked) {
      return true;
    }

    // Continue the search through deeper descendants.
    if (hasUncheckedInTree(child.children ?? [])) {
      return true;
    }
  }

  return false;
}

/**
 * Filter a list of tasks to only those that are runnable.
 *
 * An unchecked task is runnable if it has no unchecked descendants.
 * Checked tasks are excluded entirely.
 */
export function filterRunnable(tasks: Task[]): Task[] {
  return tasks.filter((task) => !task.checked && !hasUncheckedDescendants(task, tasks));
}
