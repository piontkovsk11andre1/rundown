import { parseTasks } from "../domain/parser.js";
import { hasUncheckedDescendants } from "../domain/task-selection.js";
import type { SortMode } from "../domain/sorting.js";
import { sortFiles } from "../domain/sorting.js";
import type { FileSystem } from "../domain/ports/file-system.js";
import type { SourceResolverPort } from "../domain/ports/source-resolver-port.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

export interface ListTasksDependencies {
  fileSystem: FileSystem;
  sourceResolver: SourceResolverPort;
  output: ApplicationOutputPort;
}

export interface ListTasksOptions {
  source: string;
  sortMode: SortMode;
  includeAll: boolean;
}

export function createListTasks(
  dependencies: ListTasksDependencies,
): (options: ListTasksOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function listTasks(options: ListTasksOptions): Promise<number> {
    const { source, sortMode, includeAll } = options;

    const files = await dependencies.sourceResolver.resolveSources(source);
    if (files.length === 0) {
      emit({ kind: "warn", message: "No Markdown files found matching: " + source });
      return 3;
    }

    const sorted = sortFiles(files, sortMode, {
      getBirthtimeMs: (filePath) => {
        const stats = dependencies.fileSystem.stat(filePath);
        if (!stats) {
          throw new Error(`ENOENT: no such file or directory, stat '${filePath}'`);
        }

        if (stats.birthtimeMs !== undefined && Number.isFinite(stats.birthtimeMs)) {
          return stats.birthtimeMs;
        }

        if (stats.mtimeMs !== undefined && Number.isFinite(stats.mtimeMs)) {
          return stats.mtimeMs;
        }

        throw new Error(`birthtime unavailable for '${filePath}'`);
      },
    });
    let count = 0;

    for (const file of sorted) {
      const content = dependencies.fileSystem.readText(file);
      const tasks = parseTasks(content, file);
      const filtered = includeAll ? tasks : tasks.filter((task) => !task.checked);

      for (const task of filtered) {
        const blocked = !task.checked && hasUncheckedDescendants(task, tasks, { useChildren: true });
        emit({ kind: "task", task, blocked, children: task.children, subItems: task.subItems });
        count++;
      }
    }

    if (count === 0) {
      emit({ kind: "info", message: "No tasks found." });
    }

    return 0;
  };
}

