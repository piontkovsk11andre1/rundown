import { parseTasks } from "../domain/parser.js";
import { hasUncheckedDescendants } from "../domain/task-selection.js";
import type { SortMode } from "../domain/sorting.js";
import { sortFiles } from "../domain/sorting.js";
import type { FileSystem } from "../domain/ports/file-system.js";
import type { SourceResolverPort } from "../domain/ports/source-resolver-port.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { pluralize } from "./run-task-utils.js";

/**
 * Dependencies required to list tasks from Markdown sources.
 */
export interface ListTasksDependencies {
  fileSystem: FileSystem;
  sourceResolver: SourceResolverPort;
  output: ApplicationOutputPort;
}

/**
 * Runtime options that control source selection and task filtering.
 */
export interface ListTasksOptions {
  source: string;
  sortMode: SortMode;
  includeAll: boolean;
}

/**
 * Creates the list-tasks application use case.
 *
 * The returned function resolves Markdown sources, parses task items,
 * applies filtering and ordering, and emits task records through the
 * configured output port.
 */
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

        // Prefer creation time when available to support stable chronological sorting.
        if (stats.birthtimeMs !== undefined && Number.isFinite(stats.birthtimeMs)) {
          return stats.birthtimeMs;
        }

        // Fall back to modification time on filesystems that do not expose birthtime.
        if (stats.mtimeMs !== undefined && Number.isFinite(stats.mtimeMs)) {
          return stats.mtimeMs;
        }

        throw new Error(`birthtime unavailable for '${filePath}'`);
      },
    });
    let count = 0;
    let filesWithTasks = 0;

    for (const file of sorted) {
      const content = dependencies.fileSystem.readText(file);
      const tasks = parseTasks(content, file);
      // By default only unfinished tasks are listed unless includeAll is requested.
      const filtered = includeAll ? tasks : tasks.filter((task) => !task.checked);

      if (filtered.length === 0) {
        continue;
      }

      filesWithTasks += 1;

      if (count > 0) {
        emit({ kind: "text", text: "" });
      }

      emit({ kind: "text", text: `${file} (${filtered.length} ${pluralize(filtered.length, "task", "tasks")})` });

      for (const [index, task] of filtered.entries()) {
        emit({ kind: "text", text: `${count + 1}.` });
        // Unchecked ancestors with pending descendants are marked as blocked.
        const blocked = !task.checked && hasUncheckedDescendants(task, tasks, { useChildren: true });
        emit({ kind: "task", task, blocked, children: task.children, subItems: task.subItems });
        count++;

        if (index < filtered.length - 1) {
          emit({ kind: "text", text: "" });
        }
      }
    }

    if (count === 0) {
      emit({ kind: "info", message: "No tasks found." });
    } else {
      emit({
        kind: "info",
        message: `${count} ${pluralize(count, "task", "tasks")} across ${filesWithTasks} ${pluralize(filesWithTasks, "file", "files")}.`,
      });
    }

    return 0;
  };
}

