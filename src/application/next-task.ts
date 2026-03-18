import type { SortMode } from "../domain/sorting.js";
import { selectNextTask } from "../infrastructure/selector.js";
import { resolveSources } from "../infrastructure/sources.js";
import * as log from "../presentation/log.js";

export interface NextTaskOptions {
  source: string;
  sortMode: SortMode;
}

export async function nextTask(options: NextTaskOptions): Promise<number> {
  const { source, sortMode } = options;

  const files = await resolveSources(source);
  if (files.length === 0) {
    log.warn("No Markdown files found matching: " + source);
    return 3;
  }

  const result = selectNextTask(files, sortMode);
  if (!result) {
    log.info("No unchecked tasks found.");
    return 3;
  }

  console.log(log.taskLabel(result.task));
  return 0;
}
