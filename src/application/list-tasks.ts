import fs from "node:fs";
import { parseTasks } from "../domain/parser.js";
import type { SortMode } from "../domain/sorting.js";
import { sortFiles } from "../domain/sorting.js";
import { hasUncheckedDescendants } from "../infrastructure/selector.js";
import { resolveSources } from "../infrastructure/sources.js";
import * as log from "../presentation/log.js";

export interface ListTasksOptions {
  source: string;
  sortMode: SortMode;
  includeAll: boolean;
}

export async function listTasks(options: ListTasksOptions): Promise<number> {
  const { source, sortMode, includeAll } = options;

  const files = await resolveSources(source);
  if (files.length === 0) {
    log.warn("No Markdown files found matching: " + source);
    return 3;
  }

  const sorted = sortFiles(files, sortMode);
  let count = 0;

  for (const file of sorted) {
    const content = fs.readFileSync(file, "utf-8");
    const tasks = parseTasks(content, file);
    const filtered = includeAll ? tasks : tasks.filter((task) => !task.checked);

    for (const task of filtered) {
      const blocked = !task.checked && hasUncheckedDescendants(task, tasks);
      const suffix = blocked ? log.dim(" (blocked — has unchecked subtasks)") : "";
      console.log(log.taskLabel(task) + suffix);
      count++;
    }
  }

  if (count === 0) {
    log.info("No tasks found.");
  }

  return 0;
}
