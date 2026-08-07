import { describe, expect, it, vi } from "vitest";
import { createViewMemory, type ViewMemoryDependencies, type ViewMemoryOptions } from "../../src/application/view-memory.js";
import type { ApplicationOutputEvent, MemoryIndexEntry, MemoryMetadata } from "../../src/domain/ports/index.js";

describe("view-memory", () => {
  it("returns exit code 3 when no source matches the selector", async () => {
    const { viewMemory, events } = createDependencies({
      resolvedSources: [],
    });

    const code = await viewMemory(createOptions({ source: "missing.md" }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("No Markdown files found"))).toBe(true);
  });

  it("returns exit code 3 when sources exist but none has memory", async () => {
    const sourcePath = "roadmap.md";
    const { viewMemory, events } = createDependencies({
      resolvedSources: [sourcePath],
      metadataBySource: {
        [sourcePath]: {
          available: false,
          filePath: ".rundown/roadmap.md.memory.md",
        },
      },
      memoryBySource: {
        [sourcePath]: {
          entries: [],
          index: null,
        },
      },
    });

    const code = await viewMemory(createOptions({ source: sourcePath }));

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "info" && event.message.includes("No memory entries found."))).toBe(true);
  });

  it("emits JSON output for a single source as an object payload", async () => {
    const sourcePath = "notes.md";
    const memoryFilePath = ".rundown/notes.md.memory.md";
    const { viewMemory, events } = createDependencies({
      resolvedSources: [sourcePath],
      metadataBySource: {
        [sourcePath]: {
          available: true,
          filePath: memoryFilePath,
          summary: "Captured release context",
        },
      },
      memoryBySource: {
        [sourcePath]: {
          entries: ["Captured release context", "Owner: platform"],
          index: {
            summary: "Owner: platform",
            updatedAt: "2026-04-04T00:00:00.000Z",
            entryCount: 2,
            lastPrefix: "memory",
          },
        },
      },
    });

    const code = await viewMemory(createOptions({ source: sourcePath, json: true }));

    expect(code).toBe(0);
    const textEvents = events.filter((event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text");
    expect(textEvents).toHaveLength(1);

    const payload = JSON.parse(textEvents[0]?.text ?? "{}");
    expect(payload).toEqual({
      source: sourcePath,
      memoryFile: memoryFilePath,
      entries: ["Captured release context", "Owner: platform"],
      index: {
        summary: "Owner: platform",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 2,
        lastPrefix: "memory",
      },
    });
  });

  it("renders summary mode with metadata and without body entries", async () => {
    const sourcePath = "roadmap.md";
    const memoryFilePath = ".rundown/roadmap.md.memory.md";
    const { viewMemory, events } = createDependencies({
      resolvedSources: [sourcePath],
      metadataBySource: {
        [sourcePath]: {
          available: true,
          filePath: memoryFilePath,
          summary: "Sprint notes",
        },
      },
      memoryBySource: {
        [sourcePath]: {
          entries: ["Sprint notes", "Follow-up"],
          index: {
            summary: "Follow-up",
            updatedAt: "2026-04-04T12:34:56.000Z",
            entryCount: 2,
            lastPrefix: "remember",
          },
        },
      },
    });

    const code = await viewMemory(createOptions({ source: sourcePath, summary: true }));

    expect(code).toBe(0);
    const textLines = events
      .filter((event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text")
      .map((event) => event.text);

    expect(textLines).toContain(sourcePath);
    expect(textLines).toContain("  memory: " + memoryFilePath);
    expect(textLines).toContain("  summary: Follow-up");
    expect(textLines).toContain("  updatedAt: 2026-04-04T12:34:56.000Z");
    expect(textLines).toContain("  entryCount: 2");
    expect(textLines).toContain("  lastPrefix: remember");
    expect(textLines.some((line) => line.includes("entries ("))).toBe(false);
  });

  it("includes all matched sources in JSON with --all and skips sources without memory", async () => {
    const sourceOne = "alpha.md";
    const sourceTwo = "beta.md";
    const sourceThree = "gamma.md";
    const { viewMemory, events } = createDependencies({
      resolvedSources: [sourceOne, sourceTwo, sourceThree],
      metadataBySource: {
        [sourceOne]: {
          available: true,
          filePath: ".rundown/alpha.md.memory.md",
          summary: "Alpha summary",
        },
        [sourceTwo]: {
          available: false,
          filePath: ".rundown/beta.md.memory.md",
        },
        [sourceThree]: {
          available: false,
          filePath: ".rundown/gamma.md.memory.md",
        },
      },
      memoryBySource: {
        [sourceOne]: {
          entries: ["Alpha memory"],
          index: {
            summary: "Alpha summary",
            updatedAt: "2026-04-04T00:00:00.000Z",
            entryCount: 1,
          },
        },
        [sourceTwo]: {
          entries: [],
          index: null,
        },
        [sourceThree]: {
          entries: ["Gamma memory"],
          index: null,
        },
      },
    });

    const code = await viewMemory(createOptions({ source: "*.md", json: true, all: true }));

    expect(code).toBe(0);
    const textEvents = events.filter((event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text");
    expect(textEvents).toHaveLength(1);

    const payload = JSON.parse(textEvents[0]?.text ?? "[]");
    expect(payload).toHaveLength(2);
    expect(payload).toEqual([
      {
        source: sourceOne,
        memoryFile: ".rundown/alpha.md.memory.md",
        entries: ["Alpha memory"],
        index: {
          summary: "Alpha summary",
          updatedAt: "2026-04-04T00:00:00.000Z",
          entryCount: 1,
        },
      },
      {
        source: sourceThree,
        memoryFile: ".rundown/gamma.md.memory.md",
        entries: ["Gamma memory"],
        index: null,
      },
    ]);
  });
});

function createDependencies(options: {
  resolvedSources: string[];
  metadataBySource?: Record<string, MemoryMetadata>;
  memoryBySource?: Record<string, { entries: string[]; index: MemoryIndexEntry | null }>;
}): {
  viewMemory: (options: ViewMemoryOptions) => Promise<number>;
  events: ApplicationOutputEvent[];
  dependencies: ViewMemoryDependencies;
} {
  const events: ApplicationOutputEvent[] = [];

  const dependencies: ViewMemoryDependencies = {
    sourceResolver: {
      resolveSources: vi.fn(async () => options.resolvedSources),
    },
    memoryResolver: {
      resolve: vi.fn((sourcePath: string): MemoryMetadata => {
        return options.metadataBySource?.[sourcePath] ?? {
          available: false,
          filePath: sourcePath + ".memory.md",
        };
      }),
    },
    memoryReader: {
      read: vi.fn((sourcePath: string) => {
        return options.memoryBySource?.[sourcePath] ?? { entries: [], index: null };
      }),
      readAll: vi.fn(() => []),
    },
    output: {
      emit: (event) => events.push(event),
    },
  };

  return {
    viewMemory: createViewMemory(dependencies),
    events,
    dependencies,
  };
}

function createOptions(overrides: Partial<ViewMemoryOptions> = {}): ViewMemoryOptions {
  return {
    source: "*.md",
    json: false,
    summary: false,
    all: false,
    ...overrides,
  };
}
