import type { SortMode } from "../domain/sorting.js";
import type { Task } from "../domain/parser.js";
import type {
  SourceResolverPort,
  TaskSelectionResult as PortTaskSelectionResult,
  TaskSelectorPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";

export type TaskSelectionResult = PortTaskSelectionResult;

export interface NextTaskDependencies {
  sourceResolver: SourceResolverPort;
  taskSelector: TaskSelectorPort;
  output: ApplicationOutputPort;
}

export interface NextTaskOptions {
  source: string;
  sortMode: SortMode;
}

export function createNextTask(
  dependencies: NextTaskDependencies,
): (options: NextTaskOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function nextTask(options: NextTaskOptions): Promise<number> {
    const { source, sortMode } = options;

    const files = await dependencies.sourceResolver.resolveSources(source);
    if (files.length === 0) {
      emit({ kind: "warn", message: "No Markdown files found matching: " + source });
      return 3;
    }

    const result = dependencies.taskSelector.selectNextTask(files, sortMode);
    if (!result) {
      emit({ kind: "info", message: "No unchecked tasks found." });
      return 3;
    }

    emit({
      kind: "task",
      task: result.task,
      children: result.task.children,
      subItems: result.task.subItems,
    });
    return 0;
  };
}

