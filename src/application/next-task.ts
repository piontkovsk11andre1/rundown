import type { SortMode } from "../domain/sorting.js";
import type { Task } from "../domain/parser.js";
import { parseTasks } from "../domain/parser.js";
import { EXIT_CODE_NO_WORK, EXIT_CODE_SUCCESS } from "../domain/exit-codes.js";
import type {
  SourceResolverPort,
  TaskSelectionResult as PortTaskSelectionResult,
  TaskSelectorPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { formatNoItemsFound, formatNoItemsFoundMatching } from "./run-task-utils.js";

/**
 * Re-export of the domain-level task selection result for application consumers.
 */
export type TaskSelectionResult = PortTaskSelectionResult;

/**
 * Dependencies required to resolve source files and select the next task.
 */
export interface NextTaskDependencies {
  // Resolves user-provided source input into concrete Markdown files.
  sourceResolver: SourceResolverPort;
  // Encapsulates the task selection policy across resolved files.
  taskSelector: TaskSelectorPort;
  // Emits user-facing events for warnings, informational notices, and task data.
  output: ApplicationOutputPort;
}

/**
 * Input options for selecting and displaying the next task.
 */
export interface NextTaskOptions {
  // Source glob/path expression used to locate candidate task files.
  source: string;
  // Ordering strategy applied before choosing the next unchecked task.
  sortMode: SortMode;
}

/**
 * Creates an application use case that finds and emits the next unchecked task.
 *
 * The returned function resolves source files, selects the next unchecked task
 * using the configured sort mode, and emits either a warning/info event or the
 * selected task payload. Exit code `0` indicates success, while `3` indicates
 * that no eligible task could be selected.
 */
export function createNextTask(
  dependencies: NextTaskDependencies,
): (options: NextTaskOptions) => Promise<number> {
  // Bind once so downstream calls can emit without repeating member access.
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function nextTask(options: NextTaskOptions): Promise<number> {
    const { source, sortMode } = options;

    // Resolve all Markdown files that match the caller-provided source value.
    const files = await dependencies.sourceResolver.resolveSources(source);
    if (files.length === 0) {
      emit({ kind: "warn", message: formatNoItemsFoundMatching("Markdown files", source) });
      return EXIT_CODE_NO_WORK;
    }

    // Select the next unchecked task according to the requested ordering mode.
    const selection = dependencies.taskSelector.selectNextTask(files, sortMode);
    if (!selection || selection.length === 0) {
      emit({ kind: "info", message: formatNoItemsFound("unchecked tasks") });
      return EXIT_CODE_NO_WORK;
    }

    const result = selection[0]!;

    const totalTasksInFile = parseTasks(result.source, result.task.file).length;
    emit({
      kind: "info",
      message: `Next task: ${result.task.index + 1}/${totalTasksInFile} in ${result.task.file}`,
    });

    // Emit the selected task and any nested checklist items for display.
    emit({
      kind: "task",
      task: result.task,
      children: result.task.children,
      subItems: result.task.subItems,
    });

    // Signal successful task discovery.
    return EXIT_CODE_SUCCESS;
  };
}

