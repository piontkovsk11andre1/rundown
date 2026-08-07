import { parseTasks, type Task } from "../domain/parser.js";
import type {
  ArtifactRunMetadata,
  ArtifactStore,
  FileSystem,
  PathOperationsPort,
} from "../domain/ports/index.js";

/**
 * Carries the persisted task identity that is stored at runtime boundaries.
 */
export interface RuntimeTaskMetadata {
  text: string;
  file: string;
  line: number;
  index: number;
  source: string;
}

/**
 * Describes the resolved task and source context needed by execution flows.
 */
export interface ResolvedTaskContext {
  task: Task;
  source: string;
  contextBefore: string;
}

/**
 * Captures metrics used to describe task selection and scan coverage.
 */
export interface TaskContextMetrics {
  sourceFilesScanned: number;
  totalUncheckedTasks: number;
  taskPositionInFile: number;
  hasSubtasks: boolean;
}

/**
 * Converts a parsed task into metadata suitable for persistence and reuse.
 */
export function toRuntimeTaskMetadata(
  task: Task,
  source: string,
): RuntimeTaskMetadata {
  return {
    text: task.text,
    file: task.file,
    line: task.line,
    index: task.index,
    source,
  };
}

/**
 * Computes aggregate metrics for unchecked tasks and selected task structure.
 */
export function computeTaskContextMetrics(
  files: string[],
  selectedTask: Task,
  fileSystem: FileSystem,
): TaskContextMetrics {
  let totalUncheckedTasks = 0;

  for (const file of files) {
    // Skip missing source documents so metric computation remains resilient.
    if (!fileSystem.exists(file)) {
      continue;
    }

    const source = fileSystem.readText(file);
    const tasks = parseTasks(source, file);
    totalUncheckedTasks += tasks.filter((task) => !task.checked).length;
  }

  return {
    sourceFilesScanned: files.length,
    totalUncheckedTasks,
    taskPositionInFile: selectedTask.index + 1,
    hasSubtasks: hasDescendantTasks(selectedTask, fileSystem),
  };
}

/**
 * Finds the newest saved run that is completed and has enough task data to reverify.
 */
export function resolveLatestCompletedRun(
  artifactStore: ArtifactStore,
  artifactBaseDir: string | undefined,
): ArtifactRunMetadata | null {
  const runs = artifactStore.listSaved(artifactBaseDir);
  return runs.find((run) => isCompletedArtifactRun(run) && hasReverifiableTask(run)) ?? null;
}

/**
 * Validates runtime task metadata and returns a human-readable error when invalid.
 */
export function validateRuntimeTaskMetadata(task: RuntimeTaskMetadata): string | null {
  if (!task.text || task.text.trim() === "") {
    return "task text is missing.";
  }
  if (!task.file || task.file.trim() === "") {
    return "task file path is missing.";
  }
  if (!Number.isInteger(task.line) || task.line < 1) {
    return "task line must be a positive integer.";
  }
  if (!Number.isInteger(task.index) || task.index < 0) {
    return "task index must be a non-negative integer.";
  }
  if (!task.source || task.source.trim() === "") {
    return "task source is missing.";
  }
  return null;
}

/**
 * Resolves the current task context from persisted runtime metadata.
 */
export function resolveTaskContextFromRuntimeMetadata(
  metadata: RuntimeTaskMetadata,
  cwd: string,
  fileSystem: FileSystem,
  pathOperations: PathOperationsPort,
): ResolvedTaskContext | null {
  // Support both absolute and cwd-relative task file paths.
  const resolvedFilePath = pathOperations.isAbsolute(metadata.file)
    ? metadata.file
    : pathOperations.resolve(cwd, metadata.file);

  if (!fileSystem.exists(resolvedFilePath)) {
    return null;
  }

  const source = fileSystem.readText(resolvedFilePath);
  const tasks = parseTasks(source, resolvedFilePath);
  const resolvedTask = findTaskByFallback(tasks, metadata);
  if (!resolvedTask) {
    return null;
  }

  const lines = source.split("\n");
  return {
    task: resolvedTask,
    source,
    contextBefore: lines.slice(0, resolvedTask.line - 1).join("\n"),
  };
}

/**
 * Resolves a task using progressively looser matching when metadata is stale.
 */
export function findTaskByFallback(tasks: Task[], metadata: RuntimeTaskMetadata): Task | null {
  // Prefer exact positional and textual matches for determinism.
  const byLineAndText = tasks.find((task) => task.line === metadata.line && task.text === metadata.text);
  if (byLineAndText) {
    return byLineAndText;
  }

  // Fall back to index plus text when lines shift.
  const byIndexAndText = tasks.find((task) => task.index === metadata.index && task.text === metadata.text);
  if (byIndexAndText) {
    return byIndexAndText;
  }

  // Use text-only matching only when it is unambiguous.
  const textMatches = tasks.filter((task) => task.text === metadata.text);
  if (textMatches.length === 1) {
    return textMatches[0] ?? null;
  }

  return null;
}

function hasDescendantTasks(task: Task, fileSystem: FileSystem): boolean {
  if (!task.file || !fileSystem.exists(task.file)) {
    return false;
  }

  const source = fileSystem.readText(task.file);
  const tasks = parseTasks(source, task.file);
  const index = tasks.findIndex((candidate) => candidate.line === task.line && candidate.text === task.text);
  if (index === -1) {
    return false;
  }

  for (let i = index + 1; i < tasks.length; i += 1) {
    const candidate = tasks[i]!;
    // Stop when traversal exits the selected task's subtree.
    if (candidate.depth <= task.depth) {
      break;
    }

    // The first deeper task confirms at least one descendant exists.
    return true;
  }

  return false;
}

function hasReverifiableTask(run: ArtifactRunMetadata): boolean {
  return Boolean(run.task && run.task.text && run.task.file);
}

function isCompletedArtifactRun(run: ArtifactRunMetadata): boolean {
  return run.status === "completed"
    || run.status === "reverify-completed"
    || run.status === "discuss-finished-completed";
}
