import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCleanMemory } from "../../src/application/clean-memory.js";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-clean-memory-"));
  tempDirs.push(dir);
  return dir;
}

describe("clean-memory", () => {
  it("removes orphaned memory files and index entries when orphans filter is enabled", async () => {
    const rootDir = makeTempDir();
    const liveSourcePath = path.join(rootDir, "roadmap.md");
    const orphanSourcePath = path.join(rootDir, "removed.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const liveMemoryPath = path.join(memoryDir, "roadmap.md.memory.md");
    const orphanMemoryPath = path.join(memoryDir, "removed.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(liveSourcePath, "- [x] memory: keep context\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(liveMemoryPath, "Live context\n", "utf-8");
    fs.writeFileSync(orphanMemoryPath, "Orphaned context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(liveSourcePath)]: {
        summary: "Live context",
        updatedAt: new Date().toISOString(),
        entryCount: 1,
      },
      [path.resolve(orphanSourcePath)]: {
        summary: "Orphaned context",
        updatedAt: "2025-01-01T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code } = await runCleanMemory({
      sourcePath: liveSourcePath,
      resolvedSources: [liveSourcePath],
      orphans: true,
    });

    expect(code).toBe(0);
    expect(fs.existsSync(orphanMemoryPath)).toBe(false);
    expect(fs.existsSync(liveMemoryPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, unknown>;
    expect(index[path.resolve(orphanSourcePath)]).toBeUndefined();
    expect(index[path.resolve(liveSourcePath)]).toBeDefined();
  });

  it("removes only outdated memory when outdated filter and threshold are enabled", async () => {
    const rootDir = makeTempDir();
    const oldSourcePath = path.join(rootDir, "old.md");
    const freshSourcePath = path.join(rootDir, "fresh.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const oldMemoryPath = path.join(memoryDir, "old.md.memory.md");
    const freshMemoryPath = path.join(memoryDir, "fresh.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(oldSourcePath, "- [x] memory: old\n", "utf-8");
    fs.writeFileSync(freshSourcePath, "- [x] memory: fresh\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(oldMemoryPath, "Old context\n", "utf-8");
    fs.writeFileSync(freshMemoryPath, "Fresh context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(oldSourcePath)]: {
        summary: "Old context",
        updatedAt: "2020-01-01T00:00:00.000Z",
        entryCount: 1,
      },
      [path.resolve(freshSourcePath)]: {
        summary: "Fresh context",
        updatedAt: new Date().toISOString(),
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code } = await runCleanMemory({
      sourcePath: rootDir,
      resolvedSources: [oldSourcePath, freshSourcePath],
      outdated: true,
      olderThan: "30d",
    });

    expect(code).toBe(0);
    expect(fs.existsSync(oldMemoryPath)).toBe(false);
    expect(fs.existsSync(freshMemoryPath)).toBe(true);
  });

  it("dry-run reports cleanup plan without deleting memory artifacts", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryPath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryPath, "Captured context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured context",
        updatedAt: "2020-01-01T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code, events, textLines } = await runCleanMemory({
      sourcePath,
      resolvedSources: [sourcePath],
      dryRun: true,
      all: true,
      force: true,
    });

    expect(code).toBe(0);
    expect(fs.existsSync(memoryPath)).toBe(true);
    expect(textLines.some((line) => line.includes(memoryPath))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run:"))).toBe(true);
  });

  it("returns exit code 1 when all cleanup is requested without force", async () => {
    const rootDir = makeTempDir();
    const sourcePath = path.join(rootDir, "roadmap.md");
    const memoryDir = path.join(rootDir, ".rundown");
    const memoryPath = path.join(memoryDir, "roadmap.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");

    fs.writeFileSync(sourcePath, "- [x] memory: capture\n", "utf-8");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryPath, "Captured context\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(sourcePath)]: {
        summary: "Captured context",
        updatedAt: "2020-01-01T00:00:00.000Z",
        entryCount: 1,
      },
    }, null, 2), "utf-8");

    const { code, events } = await runCleanMemory({
      sourcePath,
      resolvedSources: [sourcePath],
      all: true,
      force: false,
    });

    expect(code).toBe(1);
    expect(fs.existsSync(memoryPath)).toBe(true);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("without --force"))).toBe(true);
  });
});

async function runCleanMemory(options: {
  sourcePath: string;
  resolvedSources: string[];
  dryRun?: boolean;
  orphans?: boolean;
  outdated?: boolean;
  olderThan?: string;
  all?: boolean;
  force?: boolean;
}): Promise<{ code: number; events: ApplicationOutputEvent[]; textLines: string[] }> {
  const events: ApplicationOutputEvent[] = [];
  const pathOperations = createNodePathOperationsAdapter();
  const fileSystem = createNodeFileSystem();

  const cleanMemory = createCleanMemory({
    sourceResolver: {
      resolveSources: async () => options.resolvedSources,
    },
    memoryResolver: createMemoryResolverAdapter({
      fileSystem,
      pathOperations,
    }),
    memoryReader: createMemoryReaderAdapter({
      fileSystem,
      pathOperations,
    }),
    fileSystem,
    pathOperations,
    output: {
      emit: (event) => events.push(event),
    },
  });

  const code = await cleanMemory({
    source: options.sourcePath,
    dryRun: options.dryRun ?? false,
    orphans: options.orphans ?? false,
    outdated: options.outdated ?? false,
    olderThan: options.olderThan ?? "90d",
    all: options.all ?? false,
    force: options.force ?? false,
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
