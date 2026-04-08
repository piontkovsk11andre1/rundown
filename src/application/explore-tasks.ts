import { parseTasks, type Task } from "../domain/parser.js";
import { hasUncheckedDescendants } from "../domain/task-selection.js";
import type { SortMode } from "../domain/sorting.js";
import { sortFiles } from "../domain/sorting.js";
import type { FileSystem } from "../domain/ports/file-system.js";
import type { SourceResolverPort } from "../domain/ports/source-resolver-port.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import { formatNoItemsFoundMatching, pluralize } from "./run-task-utils.js";

/**
 * Dependencies required to explore tasks from Markdown sources.
 */
export interface ExploreTasksDependencies {
  fileSystem: FileSystem;
  sourceResolver: SourceResolverPort;
  output: ApplicationOutputPort;
}

/**
 * Runtime options that control source selection and explore output.
 */
export interface ExploreTasksOptions {
  source: string;
  sortMode: SortMode;
  fileStatus?: string[];
  compact?: boolean;
}

type FileStatus = "complete" | "incomplete" | "empty";

interface FileTaskSummary {
  file: string;
  tasks: Task[];
  total: number;
  checked: number;
  unchecked: number;
  percent: number;
  status: FileStatus;
}

/**
 * Creates the explore-tasks application use case.
 */
export function createExploreTasks(
  dependencies: ExploreTasksDependencies,
): (options: ExploreTasksOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function exploreTasks(options: ExploreTasksOptions): Promise<number> {
    const { source, sortMode } = options;

    const files = await dependencies.sourceResolver.resolveSources(source);
    if (files.length === 0) {
      emit({ kind: "warn", message: formatNoItemsFoundMatching("Markdown files", source) });
      return EXIT_CODE_NO_WORK;
    }

    const sortedFiles = sortFiles(files, sortMode, {
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

    const requestedStatuses = normalizeFileStatusFilter(options.fileStatus);

    let totalTasks = 0;
    let totalChecked = 0;
    let totalUnchecked = 0;
    let emittedFiles = 0;

    for (const file of sortedFiles) {
      const content = dependencies.fileSystem.readText(file);
      const tasks = parseTasks(content, file);
      const total = tasks.length;
      const checked = tasks.filter((task) => task.checked).length;
      const unchecked = total - checked;
      const percent = total === 0 ? 0 : Math.round((checked / total) * 100);
      const status = determineFileStatus(total, unchecked);

      if (requestedStatuses && !requestedStatuses.has(status)) {
        continue;
      }

      const summary: FileTaskSummary = {
        file,
        tasks,
        total,
        checked,
        unchecked,
        percent,
        status,
      };

      totalTasks += summary.total;
      totalChecked += summary.checked;
      totalUnchecked += summary.unchecked;

      if (emittedFiles > 0) {
        emit({ kind: "text", text: "" });
      }
      emittedFiles += 1;

      emit({
        kind: "explore-file-summary",
        summary: {
          file: summary.file,
          total: summary.total,
          checked: summary.checked,
          unchecked: summary.unchecked,
          percent: summary.percent,
        },
      });

      if (options.compact) {
        continue;
      }

      const uncheckedTasks = summary.tasks.filter((task) => !task.checked);
      for (const task of uncheckedTasks) {
        const blocked = hasUncheckedDescendants(task, summary.tasks, { useChildren: true });
        emit({ kind: "task", task, blocked, children: task.children, subItems: task.subItems });
      }
    }

    const aggregatePercent = totalTasks === 0 ? 0 : Math.round((totalChecked / totalTasks) * 100);
    emit({
      kind: "info",
      message: `${totalTasks} ${pluralize(totalTasks, "task", "tasks")} across ${emittedFiles} ${pluralize(emittedFiles, "file", "files")}: ${totalChecked} checked, ${totalUnchecked} unchecked (${aggregatePercent}%).`,
    });

    return EXIT_CODE_SUCCESS;
  };
}

function normalizeFileStatusFilter(fileStatus: string[] | undefined): Set<FileStatus> | undefined {
  if (!fileStatus || fileStatus.length === 0) {
    return undefined;
  }

  const normalized = new Set<FileStatus>();
  for (const rawStatus of fileStatus) {
    const tokens = rawStatus.split(",");
    for (const token of tokens) {
      const status = token.trim().toLowerCase();
      if (status === "complete" || status === "incomplete" || status === "empty") {
        normalized.add(status);
      }
    }
  }

  return normalized.size > 0 ? normalized : undefined;
}

function determineFileStatus(total: number, unchecked: number): FileStatus {
  if (total === 0) {
    return "empty";
  }

  if (unchecked === 0) {
    return "complete";
  }

  return "incomplete";
}
