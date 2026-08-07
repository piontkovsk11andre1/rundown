import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createValidateMemory } from "../../src/application/validate-memory.js";
import type { ApplicationOutputEvent } from "../../src/domain/ports/index.js";
import { createMemoryReaderAdapter } from "../../src/infrastructure/adapters/memory-reader-adapter.js";
import { createMemoryResolverAdapter } from "../../src/infrastructure/adapters/memory-resolver-adapter.js";
import { createNodeFileSystem } from "../../src/infrastructure/adapters/fs-file-system.js";
import { createNodePathOperationsAdapter } from "../../src/infrastructure/adapters/node-path-operations-adapter.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-validate-memory-"));
  tempDirs.push(dir);
  return dir;
}

describe("validate-memory", () => {
  it("returns 3 when no markdown files match source", async () => {
    const events: ApplicationOutputEvent[] = [];
    const validateMemory = createValidateMemory({
      sourceResolver: {
        resolveSources: async () => [],
      },
      memoryResolver: createMemoryResolverAdapter({
        fileSystem: createNodeFileSystem(),
        pathOperations: createNodePathOperationsAdapter(),
      }),
      memoryReader: createMemoryReaderAdapter({
        fileSystem: createNodeFileSystem(),
        pathOperations: createNodePathOperationsAdapter(),
      }),
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
      output: {
        emit: (event) => events.push(event),
      },
    });

    const code = await validateMemory({
      source: "missing/**/*.md",
      fix: false,
      json: false,
    });

    expect(code).toBe(3);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("No Markdown files found"))).toBe(true);
  });

  it("reports orphaned-index-entry when index exists but memory body file is missing", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured release context",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
    });

    expect(code).toBe(2);
    expect(textLines.some((line) => line.includes("orphaned-index-entry"))).toBe(true);
  });

  it("reports missing-index-entry when memory body exists without index entry", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");

    fs.writeFileSync(sourcePath, "- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n\n---\n\nOwner: platform\n", "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
    });

    expect(code).toBe(2);
    expect(textLines.some((line) => line.includes("missing-index-entry"))).toBe(true);
  });

  it("reports entry-count-mismatch and summary-drift for mismatched metadata", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Actual first line\n\n---\n\nSecond entry\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Wrong summary",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 5,
      },
    }, null, 2), "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
    });

    expect(code).toBe(2);
    expect(textLines.some((line) => line.includes("entry-count-mismatch"))).toBe(true);
    expect(textLines.some((line) => line.includes("summary-drift"))).toBe(true);
  });

  it("reports source-missing for index entries whose source file no longer exists", async () => {
    const rootDir = makeTempDir();
    const liveSourcePath = path.join(rootDir, "roadmap.md");
    const missingSourcePath = path.join(rootDir, "removed.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(liveSourcePath, "- [x] memory: keep this source in resolution\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(missingSourcePath)]: {
        summary: "Captured from removed source",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath: liveSourcePath,
      resolvedSources: [liveSourcePath],
    });

    expect(code).toBe(2);
    expect(textLines.some((line) => line.includes("source-missing"))).toBe(true);
  });

  it("reports origin-task-unchecked when origin task exists but is unchecked", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [ ] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured release context",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
        origin: {
          taskText: "memory: capture release context",
          taskLine: 1,
        },
      },
    }, null, 2), "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
    });

    expect(code).toBe(2);
    expect(textLines.some((line) => line.includes("origin-task-unchecked"))).toBe(true);
  });

  it("reports origin-task-removed when origin task text is no longer present", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: different task\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured release context",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
        origin: {
          taskText: "memory: capture release context",
          taskLine: 1,
        },
      },
    }, null, 2), "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
    });

    expect(code).toBe(2);
    expect(textLines.some((line) => line.includes("origin-task-removed"))).toBe(true);
  });

  it("reports origin-task-unreadable when source cannot be read during origin checks", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured release context",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
        origin: {
          taskText: "memory: capture release context",
          taskLine: 1,
        },
      },
    }, null, 2), "utf-8");

    const nodeFileSystem = createNodeFileSystem();
    const unreadableFileSystem = {
      ...nodeFileSystem,
      readText(filePath: string): string {
        if (path.resolve(filePath) === path.resolve(sourcePath)) {
          throw new Error("simulated read failure");
        }
        return nodeFileSystem.readText(filePath);
      },
    };

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
      fileSystem: unreadableFileSystem,
    });

    expect(code).toBe(2);
    expect(textLines.some((line) => line.includes("origin-task-unreadable"))).toBe(true);
  });

  it("does not report origin-task-removed when task line drifts but task text still matches", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "# Sprint\n\nNotes\n\n- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured release context",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
        origin: {
          taskText: "memory: capture release context",
          taskLine: 1,
        },
      },
    }, null, 2), "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
    });

    expect(code).toBe(0);
    expect(textLines.some((line) => line.includes("origin-task-removed"))).toBe(false);
  });

  it("treats legacy index entries without origin as valid", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured release context",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
    });

    expect(code).toBe(0);
    expect(textLines.some((line) => line.includes("origin-task-"))).toBe(false);
  });

  it("treats malformed index entries as missing index metadata", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: 123,
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code, textLines } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
    });

    expect(code).toBe(2);
    expect(textLines.some((line) => line.includes("missing-index-entry"))).toBe(true);
  });

  it("fix mode rebuilds missing index entry from body and keeps body file intact", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n\n---\n\nOwner: platform\n", "utf-8");

    const { code } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
      fix: true,
    });

    expect(code).toBe(2);
    expect(fs.readFileSync(memoryFilePath, "utf-8")).toContain("Captured release context");

    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, MemoryIndexFixture>;
    const fixed = index[path.resolve(sourcePath)];
    expect(fixed?.summary).toBe("Owner: platform");
    expect(fixed?.entryCount).toBe(2);
    expect(typeof fixed?.updatedAt).toBe("string");
    expect((fixed?.updatedAt ?? "").length).toBeGreaterThan(0);
  });

  it("fix mode removes orphaned index entries while preserving valid entries", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const orphanSourcePath = path.join(rootDir, "removed.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture release context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Captured release context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured release context",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
      },
      [path.resolve(orphanSourcePath)]: {
        summary: "Orphaned entry",
        updatedAt: "2026-04-04T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code } = await runValidateMemory({
      sourcePath,
      resolvedSources: [sourcePath],
      fix: true,
    });

    expect(code).toBe(2);
    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, MemoryIndexFixture>;
    expect(index[path.resolve(orphanSourcePath)]).toBeUndefined();
    expect(index[path.resolve(sourcePath)]).toBeDefined();
  });
});

async function runValidateMemory(options: {
  sourcePath: string;
  resolvedSources: string[];
  fix?: boolean;
  json?: boolean;
  fileSystem?: ReturnType<typeof createNodeFileSystem>;
}): Promise<{ code: number; events: ApplicationOutputEvent[]; textLines: string[] }> {
  const events: ApplicationOutputEvent[] = [];
  const pathOperations = createNodePathOperationsAdapter();
  const nodeFileSystem = createNodeFileSystem();
  const fileSystem = options.fileSystem ?? nodeFileSystem;

  const validateMemory = createValidateMemory({
    sourceResolver: {
      resolveSources: async () => options.resolvedSources,
    },
    memoryResolver: createMemoryResolverAdapter({
      fileSystem: nodeFileSystem,
      pathOperations,
    }),
    memoryReader: createMemoryReaderAdapter({
      fileSystem: nodeFileSystem,
      pathOperations,
    }),
    fileSystem,
    pathOperations,
    output: {
      emit: (event) => events.push(event),
    },
  });

  const code = await validateMemory({
    source: options.sourcePath,
    fix: options.fix ?? false,
    json: options.json ?? false,
  });

  const textLines = events
    .filter((event): event is Extract<ApplicationOutputEvent, { kind: "text" }> => event.kind === "text")
    .map((event) => event.text);

  return {
    code,
    events,
    textLines,
  };
}

interface MemoryIndexFixture {
  summary?: string;
  entryCount?: number;
  updatedAt?: string;
}
