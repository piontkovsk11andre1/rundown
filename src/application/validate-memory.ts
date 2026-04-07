import { parseTasks } from "../domain/parser.js";
import { CONFIG_DIR_NAME } from "../domain/ports/config-dir-port.js";
import type { FileSystem } from "../domain/ports/file-system.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import type { PathOperationsPort } from "../domain/ports/path-operations-port.js";
import type {
  MemoryIssue,
  MemoryReaderPort,
  MemoryResolverPort,
  MemoryValidationResult,
  SourceResolverPort,
} from "../domain/ports/index.js";
import type { MemoryIndexEntry, MemoryIndexOrigin } from "../domain/ports/memory-writer-port.js";
import { formatNoItemsFoundMatching } from "./run-task-utils.js";

const MEMORY_INDEX_FILE_NAME = "memory-index.json";
const MEMORY_FILE_SUFFIX = ".memory.md";

interface ValidationContext {
  sourcePath: string;
  memoryFilePath: string;
  memoryIndexPath: string;
  sourceExists: boolean;
  bodyExists: boolean;
  entries: string[];
  indexEntry: MemoryIndexEntry | null;
}

interface IndexFixState {
  entries: Record<string, MemoryIndexEntry>;
  changed: boolean;
}

/**
 * Dependencies required to validate source-local memory artifacts.
 */
export interface ValidateMemoryDependencies {
  sourceResolver: SourceResolverPort;
  memoryResolver: MemoryResolverPort;
  memoryReader: MemoryReaderPort;
  fileSystem: FileSystem;
  pathOperations: PathOperationsPort;
  output: ApplicationOutputPort;
}

/**
 * Runtime options for memory validation.
 */
export interface ValidateMemoryOptions {
  source: string;
  fix: boolean;
  json: boolean;
}

/**
 * Creates the memory-validate application use case.
 */
export function createValidateMemory(
  dependencies: ValidateMemoryDependencies,
): (options: ValidateMemoryOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function validateMemory(options: ValidateMemoryOptions): Promise<number> {
    const resolvedSources = await dependencies.sourceResolver.resolveSources(options.source);
    if (resolvedSources.length === 0) {
      emit({ kind: "warn", message: formatNoItemsFoundMatching("Markdown files", options.source) });
      return 3;
    }

    const contexts = collectContexts(dependencies, resolvedSources);
    const reports: MemoryValidationResult[] = [];
    const fixStates = new Map<string, IndexFixState>();

    for (const context of contexts) {
      const issues = validateContext(dependencies.fileSystem, context);
      if (issues.length > 0) {
        reports.push({
          sourcePath: context.sourcePath,
          memoryFilePath: context.memoryFilePath,
          issues,
        });
      }

      if (!options.fix || issues.length === 0) {
        continue;
      }

      const state = ensureFixState(dependencies.fileSystem, context.memoryIndexPath, fixStates);
      applyFixForContext(context, state.entries);
      state.changed = true;
    }

    if (options.fix) {
      for (const [memoryIndexPath, state] of fixStates.entries()) {
        if (!state.changed) {
          continue;
        }
        writeMemoryIndexAtomically(dependencies, memoryIndexPath, state.entries);
      }
    }

    if (options.json) {
      emit({ kind: "text", text: JSON.stringify(reports, null, 2) });
    } else if (reports.length === 0) {
      emit({ kind: "success", message: "Memory validation passed." });
    } else {
      renderReports(reports, emit);
    }

    return reports.length === 0 ? 0 : 1;
  };
}

function collectContexts(
  dependencies: ValidateMemoryDependencies,
  resolvedSources: string[],
): ValidationContext[] {
  const contexts = new Map<string, ValidationContext>();
  const sourceDirs = new Set<string>();

  for (const source of resolvedSources) {
    const canonicalSourcePath = dependencies.pathOperations.resolve(source);
    sourceDirs.add(dependencies.pathOperations.dirname(canonicalSourcePath));
    contexts.set(canonicalSourcePath, buildContextFromSource(dependencies, canonicalSourcePath));
  }

  for (const sourceDir of sourceDirs) {
    const memoryIndexPath = dependencies.pathOperations.join(sourceDir, CONFIG_DIR_NAME, MEMORY_INDEX_FILE_NAME);
    const rawIndex = readRawMemoryIndex(dependencies.fileSystem, memoryIndexPath);
    if (!rawIndex) {
      continue;
    }

    for (const [rawSourcePath, rawEntry] of Object.entries(rawIndex)) {
      const sourcePath = dependencies.pathOperations.resolve(rawSourcePath);
      if (contexts.has(sourcePath)) {
        continue;
      }

      const memory = dependencies.memoryReader.read(sourcePath);
      const memoryFilePath = computeMemoryFilePath(dependencies.pathOperations, sourcePath);
      contexts.set(sourcePath, {
        sourcePath,
        memoryFilePath,
        memoryIndexPath,
        sourceExists: safeExists(dependencies.fileSystem, sourcePath),
        bodyExists: safeExists(dependencies.fileSystem, memoryFilePath),
        entries: memory.entries,
        indexEntry: normalizeMemoryIndexEntry(rawEntry),
      });
    }
  }

  return Array.from(contexts.values())
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
}

function buildContextFromSource(
  dependencies: ValidateMemoryDependencies,
  sourcePath: string,
): ValidationContext {
  const memoryMetadata = dependencies.memoryResolver.resolve(sourcePath);
  const memory = dependencies.memoryReader.read(sourcePath);
  return {
    sourcePath,
    memoryFilePath: memoryMetadata.filePath,
    memoryIndexPath: dependencies.pathOperations.join(
      dependencies.pathOperations.dirname(memoryMetadata.filePath),
      MEMORY_INDEX_FILE_NAME,
    ),
    sourceExists: safeExists(dependencies.fileSystem, sourcePath),
    bodyExists: safeExists(dependencies.fileSystem, memoryMetadata.filePath),
    entries: memory.entries,
    indexEntry: memory.index,
  };
}

function validateContext(fileSystem: FileSystem, context: ValidationContext): MemoryIssue[] {
  const issues: MemoryIssue[] = [];

  if (context.indexEntry && !context.bodyExists) {
    issues.push({
      severity: "error",
      code: "orphaned-index-entry",
      message: "Index entry exists but memory body file is missing.",
    });
  }

  if (context.bodyExists && !context.indexEntry) {
    issues.push({
      severity: "error",
      code: "missing-index-entry",
      message: "Memory body exists but index entry is missing.",
    });
  }

  if (context.indexEntry) {
    if (context.indexEntry.entryCount !== context.entries.length) {
      issues.push({
        severity: "error",
        code: "entry-count-mismatch",
        message: `Index entryCount=${context.indexEntry.entryCount} but body contains ${context.entries.length} entries.`,
      });
    }

    const expectedSummary = summarizeLatestEntry(context.entries);
    if (expectedSummary && normalizeComparable(context.indexEntry.summary) !== normalizeComparable(expectedSummary)) {
      issues.push({
        severity: "warning",
        code: "summary-drift",
        message: "Index summary does not match the latest memory entry.",
      });
    }
  }

  if (!context.sourceExists && context.indexEntry) {
    issues.push({
      severity: "warning",
      code: "source-missing",
      message: "Source file referenced in memory index no longer exists.",
    });
  }

  if (context.indexEntry?.origin) {
    issues.push(...validateOriginTask(fileSystem, context.sourcePath, context.sourceExists, context.indexEntry.origin));
  }

  return issues;
}

function validateOriginTask(
  fileSystem: FileSystem,
  sourcePath: string,
  sourceExists: boolean,
  origin: MemoryIndexOrigin,
): MemoryIssue[] {
  if (!sourceExists) {
    return [{
      severity: "warning",
      code: "origin-task-removed",
      message: "Origin task no longer exists because the source file was removed.",
    }];
  }

  const sourceText = readTextSafe(fileSystem, sourcePath);
  if (sourceText === null) {
    return [{
      severity: "warning",
      code: "origin-task-unreadable",
      message: "Origin task could not be validated because source file could not be read.",
    }];
  }

  const tasks = parseTasks(sourceText, sourcePath);
  const originTask = findOriginTask(tasks, origin);
  if (!originTask) {
    return [{
      severity: "warning",
      code: "origin-task-removed",
      message: "Origin task no longer exists in source.",
    }];
  }

  if (!originTask.checked) {
    return [{
      severity: "warning",
      code: "origin-task-unchecked",
      message: "Origin task exists but is unchecked.",
    }];
  }

  return [];
}

function findOriginTask(tasks: ReturnType<typeof parseTasks>, origin: MemoryIndexOrigin) {
  const originText = normalizeComparable(origin.taskText);
  return tasks.find((task) => task.line === origin.taskLine && normalizeComparable(task.text) === originText)
    ?? tasks.find((task) => normalizeComparable(task.text) === originText);
}

function ensureFixState(
  fileSystem: FileSystem,
  memoryIndexPath: string,
  stateMap: Map<string, IndexFixState>,
): IndexFixState {
  const existing = stateMap.get(memoryIndexPath);
  if (existing) {
    return existing;
  }

  const state: IndexFixState = {
    entries: readNormalizedMemoryIndex(fileSystem, memoryIndexPath),
    changed: false,
  };
  stateMap.set(memoryIndexPath, state);
  return state;
}

function applyFixForContext(
  context: ValidationContext,
  indexEntries: Record<string, MemoryIndexEntry>,
): void {
  if (!context.sourceExists || !context.bodyExists || context.entries.length === 0) {
    delete indexEntries[context.sourcePath];
    return;
  }

  indexEntries[context.sourcePath] = composeIndexFromBody(context.entries, indexEntries[context.sourcePath] ?? context.indexEntry);
}

function composeIndexFromBody(entries: string[], previous: MemoryIndexEntry | null): MemoryIndexEntry {
  const next: MemoryIndexEntry = {
    summary: summarizeLatestEntry(entries) ?? previous?.summary ?? "memory captured",
    updatedAt: new Date().toISOString(),
    entryCount: entries.length,
  };

  if (previous?.lastPrefix) {
    next.lastPrefix = previous.lastPrefix;
  }

  if (previous?.origin) {
    next.origin = previous.origin;
  }

  return next;
}

function renderReports(reports: MemoryValidationResult[], emit: ApplicationOutputPort["emit"]): void {
  for (const [reportIndex, report] of reports.entries()) {
    if (reportIndex > 0) {
      emit({ kind: "text", text: "" });
    }

    emit({ kind: "text", text: report.sourcePath });
    emit({ kind: "text", text: "  memory: " + report.memoryFilePath });
    for (const issue of report.issues) {
      emit({ kind: "text", text: `  [${issue.severity}] ${issue.code}: ${issue.message}` });
    }
  }
}

function summarizeLatestEntry(entries: string[]): string | undefined {
  const latest = entries[entries.length - 1];
  if (!latest) {
    return undefined;
  }

  const firstNonEmptyLine = latest
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstNonEmptyLine) {
    return undefined;
  }

  return firstNonEmptyLine.length > 160
    ? firstNonEmptyLine.slice(0, 157) + "..."
    : firstNonEmptyLine;
}

function normalizeComparable(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function readNormalizedMemoryIndex(fileSystem: FileSystem, memoryIndexPath: string): Record<string, MemoryIndexEntry> {
  const rawIndex = readRawMemoryIndex(fileSystem, memoryIndexPath);
  if (!rawIndex) {
    return {};
  }

  const normalized: Record<string, MemoryIndexEntry> = {};
  for (const [sourcePath, value] of Object.entries(rawIndex)) {
    const entry = normalizeMemoryIndexEntry(value);
    if (!entry) {
      continue;
    }
    normalized[sourcePath] = entry;
  }

  return normalized;
}

function readRawMemoryIndex(fileSystem: FileSystem, memoryIndexPath: string): Record<string, unknown> | null {
  try {
    if (!fileSystem.exists(memoryIndexPath)) {
      return null;
    }

    const raw = fileSystem.readText(memoryIndexPath);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeMemoryIndexEntry(value: unknown): MemoryIndexEntry | null {
  if (typeof value === "string") {
    const summary = value.trim();
    if (summary.length === 0) {
      return null;
    }

    return {
      summary,
      updatedAt: "",
      entryCount: 1,
    };
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as {
    summary?: unknown;
    description?: unknown;
    updatedAt?: unknown;
    lastPrefix?: unknown;
    entryCount?: unknown;
    origin?: unknown;
  };

  const summary = typeof record.summary === "string"
    ? record.summary.trim()
    : typeof record.description === "string"
      ? record.description.trim()
      : "";
  if (summary.length === 0) {
    return null;
  }

  const entryCount = typeof record.entryCount === "number" && Number.isFinite(record.entryCount) && record.entryCount >= 0
    ? Math.floor(record.entryCount)
    : 1;

  const normalized: MemoryIndexEntry = {
    summary,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : "",
    entryCount,
  };

  if (typeof record.lastPrefix === "string" && record.lastPrefix.trim().length > 0) {
    normalized.lastPrefix = record.lastPrefix;
  }

  const origin = normalizeOrigin(record.origin);
  if (origin) {
    normalized.origin = origin;
  }

  return normalized;
}

function normalizeOrigin(value: unknown): MemoryIndexOrigin | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    taskText?: unknown;
    taskLine?: unknown;
    sourceHash?: unknown;
  };

  if (typeof record.taskText !== "string") {
    return undefined;
  }
  if (typeof record.taskLine !== "number" || !Number.isFinite(record.taskLine)) {
    return undefined;
  }

  const origin: MemoryIndexOrigin = {
    taskText: record.taskText,
    taskLine: Math.floor(record.taskLine),
  };

  if (typeof record.sourceHash === "string" && record.sourceHash.length > 0) {
    origin.sourceHash = record.sourceHash;
  }

  return origin;
}

function writeMemoryIndexAtomically(
  dependencies: ValidateMemoryDependencies,
  memoryIndexPath: string,
  index: Record<string, MemoryIndexEntry>,
): void {
  const memoryDir = dependencies.pathOperations.dirname(memoryIndexPath);
  const serialized = JSON.stringify(index, null, 2);
  const rename = dependencies.fileSystem.rename;

  dependencies.fileSystem.mkdir(memoryDir, { recursive: true });
  if (!rename) {
    dependencies.fileSystem.writeText(memoryIndexPath, serialized);
    return;
  }

  const tempPath = `${memoryIndexPath}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  dependencies.fileSystem.writeText(tempPath, serialized);

  try {
    rename(tempPath, memoryIndexPath);
  } catch (error) {
    try {
      if (dependencies.fileSystem.exists(tempPath)) {
        dependencies.fileSystem.rm(tempPath, { force: true });
      }
    } catch {
      // Best-effort temp cleanup only.
    }
    throw error;
  }
}

function computeMemoryFilePath(pathOperations: PathOperationsPort, sourcePath: string): string {
  const sourceDirectory = pathOperations.dirname(sourcePath);
  const sourceName = basenameFromPath(sourcePath);
  return pathOperations.join(sourceDirectory, CONFIG_DIR_NAME, `${sourceName}${MEMORY_FILE_SUFFIX}`);
}

function basenameFromPath(filePath: string): string {
  const parts = filePath.split(/[/\\]+/);
  return parts[parts.length - 1] ?? filePath;
}

function safeExists(fileSystem: FileSystem, filePath: string): boolean {
  try {
    return fileSystem.exists(filePath);
  } catch {
    return false;
  }
}

function readTextSafe(fileSystem: FileSystem, filePath: string): string | null {
  try {
    return fileSystem.readText(filePath);
  } catch {
    return null;
  }
}
