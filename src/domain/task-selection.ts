import type { Task } from "./parser.js";

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
  if (options.useChildren) {
    const children = task.children ?? [];
    if (children.length > 0) {
      return hasUncheckedInTree(children);
    }
  }

  const startIdx = allTasks.indexOf(task);
  if (startIdx === -1) return false;

  for (let i = startIdx + 1; i < allTasks.length; i++) {
    const candidate = allTasks[i]!;
    if (candidate.depth <= task.depth) break;
    if (!candidate.checked) return true;
  }

  return false;
}

function hasUncheckedInTree(children: Task[]): boolean {
  for (const child of children) {
    if (!child.checked) {
      return true;
    }

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
