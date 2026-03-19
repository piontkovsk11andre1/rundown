import type { Task } from "./parser.js";

/**
 * Determine whether a task has unchecked descendants.
 *
 * Descendants are tasks that appear after the given task in document
 * order and have a strictly greater depth, up to the next task at the
 * same or shallower depth.
 */
export function hasUncheckedDescendants(task: Task, allTasks: Task[]): boolean {
  const startIdx = allTasks.indexOf(task);
  if (startIdx === -1) return false;

  for (let i = startIdx + 1; i < allTasks.length; i++) {
    const candidate = allTasks[i]!;
    if (candidate.depth <= task.depth) break;
    if (!candidate.checked) return true;
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
