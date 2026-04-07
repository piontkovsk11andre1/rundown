import type {
  MemoryIndexEntry,
  MemoryReaderPort,
  MemoryResolverPort,
  SourceResolverPort,
} from "../domain/ports/index.js";
import type { ApplicationOutputPort } from "../domain/ports/output-port.js";
import { formatNoItemsFound, formatNoItemsFoundMatching } from "./run-task-utils.js";

/**
 * Dependencies required to resolve and render source-local memory.
 */
export interface ViewMemoryDependencies {
  sourceResolver: SourceResolverPort;
  memoryResolver: MemoryResolverPort;
  memoryReader: MemoryReaderPort;
  output: ApplicationOutputPort;
}

/**
 * Runtime options for viewing memory for one or more sources.
 */
export interface ViewMemoryOptions {
  source: string;
  json: boolean;
  summary: boolean;
  all: boolean;
}

interface ViewMemoryEntry {
  source: string;
  memoryFile: string;
  entries: string[];
  index: MemoryIndexEntry | null;
}

/**
 * Creates the memory-view application use case.
 *
 * The returned function resolves source files, reads source-local memory body and
 * index metadata, and emits either human-readable text or JSON output.
 */
export function createViewMemory(
  dependencies: ViewMemoryDependencies,
): (options: ViewMemoryOptions) => Promise<number> {
  const emit = dependencies.output.emit.bind(dependencies.output);

  return async function viewMemory(options: ViewMemoryOptions): Promise<number> {
    const resolvedSources = await dependencies.sourceResolver.resolveSources(options.source);
    if (resolvedSources.length === 0) {
      emit({ kind: "warn", message: formatNoItemsFoundMatching("Markdown files", options.source) });
      return 3;
    }

    const selectedSources = options.all ? resolvedSources : [resolvedSources[0]];
    const memoryEntries: ViewMemoryEntry[] = [];

    for (const sourcePath of selectedSources) {
      const metadata = dependencies.memoryResolver.resolve(sourcePath);
      const memory = dependencies.memoryReader.read(sourcePath);
      const hasMemory = metadata.available || memory.entries.length > 0 || memory.index !== null;
      if (!hasMemory) {
        continue;
      }

      memoryEntries.push({
        source: sourcePath,
        memoryFile: metadata.filePath,
        entries: memory.entries,
        index: memory.index,
      });
    }

    if (memoryEntries.length === 0) {
      emit({ kind: "info", message: formatNoItemsFound("memory entries") });
      return 1;
    }

    if (options.json) {
      emit({ kind: "text", text: JSON.stringify(toJsonPayload(memoryEntries, options.all), null, 2) });
      return 0;
    }

    for (const [index, entry] of memoryEntries.entries()) {
      if (index > 0) {
        emit({ kind: "text", text: "" });
      }
      renderMemoryEntry(entry, options.summary, emit);
    }

    return 0;
  };
}

function toJsonPayload(entries: ViewMemoryEntry[], includeAll: boolean): ViewMemoryEntry | ViewMemoryEntry[] {
  if (includeAll || entries.length !== 1) {
    return entries;
  }
  return entries[0];
}

function renderMemoryEntry(
  entry: ViewMemoryEntry,
  summaryOnly: boolean,
  emit: ApplicationOutputPort["emit"],
): void {
  emit({ kind: "text", text: entry.source });
  emit({ kind: "text", text: "  memory: " + entry.memoryFile });

  if (summaryOnly) {
    emit({ kind: "text", text: "  summary: " + (entry.index?.summary ?? "(none)") });
    emit({ kind: "text", text: "  updatedAt: " + (entry.index?.updatedAt || "(unknown)") });
    emit({ kind: "text", text: "  entryCount: " + String(entry.index?.entryCount ?? entry.entries.length) });
    emit({ kind: "text", text: "  lastPrefix: " + (entry.index?.lastPrefix ?? "(none)") });
    return;
  }

  emit({ kind: "text", text: `  entries (${entry.entries.length}):` });
  if (entry.entries.length === 0) {
    emit({ kind: "text", text: "    (none)" });
    return;
  }

  for (const [entryIndex, memoryEntry] of entry.entries.entries()) {
    emit({ kind: "text", text: `    ${entryIndex + 1}.` });
    emitMultiline(memoryEntry, emit, "      ");
  }
}

function emitMultiline(text: string, emit: ApplicationOutputPort["emit"], indent: string): void {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    emit({ kind: "text", text: indent + line });
  }
}
