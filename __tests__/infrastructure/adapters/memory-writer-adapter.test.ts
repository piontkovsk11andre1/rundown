import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryWriterAdapter } from "../../../src/infrastructure/adapters/memory-writer-adapter.js";
import { createNodeFileSystem } from "../../../src/infrastructure/adapters/fs-file-system.js";
import { createNodePathOperationsAdapter } from "../../../src/infrastructure/adapters/node-path-operations-adapter.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-memory-writer-"));
  tempDirs.push(dir);
  return dir;
}

describe("createMemoryWriterAdapter", () => {
  it("writes source-local memory body and memory index keyed by canonical source path", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "docs", "plan.md");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "- [ ] memory: capture release context\n", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Captured release context\nOwner: platform",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const memoryDir = path.join(path.dirname(sourceFile), ".rundown");
    const memoryFilePath = path.join(memoryDir, "plan.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");
    const canonicalSourcePath = path.resolve(sourceFile);

    expect(result.value.memoryFilePath).toBe(memoryFilePath);
    expect(result.value.memoryIndexPath).toBe(memoryIndexPath);
    expect(result.value.canonicalSourcePath).toBe(canonicalSourcePath);

    expect(fs.readFileSync(memoryFilePath, "utf-8")).toContain("Captured release context");

    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, {
      summary?: string;
      updatedAt?: string;
      lastPrefix?: string;
      entryCount?: number;
    }>;
    expect(index[canonicalSourcePath]?.summary).toBe("Captured release context");
    expect(typeof index[canonicalSourcePath]?.updatedAt).toBe("string");
    expect(index[canonicalSourcePath]?.entryCount).toBe(1);
    expect(index[canonicalSourcePath]?.lastPrefix).toBeUndefined();
  });

  it("composes index entry metadata with deterministic summary, lastPrefix, and incremented entryCount", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] remember: capture\n", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const firstResult = writer.write({
      sourcePath: sourceFile,
      workerOutput: "First summary line\nextra details",
      capturePrefix: "remember",
    });
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) {
      return;
    }

    const secondResult = writer.write({
      sourcePath: sourceFile,
      workerOutput: "   \n\tSecond summary line after trim",
      capturePrefix: "inventory",
    });
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) {
      return;
    }

    const index = JSON.parse(fs.readFileSync(secondResult.value.memoryIndexPath, "utf-8")) as Record<string, {
      summary?: string;
      updatedAt?: string;
      lastPrefix?: string;
      entryCount?: number;
    }>;
    const entry = index[path.resolve(sourceFile)];
    expect(entry?.summary).toBe("Second summary line after trim");
    expect(entry?.lastPrefix).toBe("inventory");
    expect(entry?.entryCount).toBe(2);
    expect(typeof entry?.updatedAt).toBe("string");
  });

  it("appends new memory entries without destroying existing memory body", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: update runbook\n", "utf-8");

    const memoryDir = path.join(rootDir, ".rundown");
    fs.mkdirSync(memoryDir, { recursive: true });
    const memoryFilePath = path.join(memoryDir, "tasks.md.memory.md");
    fs.writeFileSync(memoryFilePath, "Existing memory snapshot\n", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Second capture line",
    });

    expect(result.ok).toBe(true);
    const persistedBody = fs.readFileSync(memoryFilePath, "utf-8");
    expect(persistedBody).toContain("Existing memory snapshot");
    expect(persistedBody).toContain("\n---\n\nSecond capture line\n");
  });

  it("returns warning and rebuilds index when memory-index.json is malformed", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const memoryDir = path.join(rootDir, ".rundown");
    fs.mkdirSync(memoryDir, { recursive: true });
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");
    fs.writeFileSync(memoryIndexPath, "{\"broken\":", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Recovered memory summary",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.warningMessage).toContain("Memory index is malformed");
    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(index[path.resolve(sourceFile)]?.summary).toBe("Recovered memory summary");
  });

  it("fails when memory body write cannot be performed", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: {
        exists: () => false,
        readText() {
          throw new Error("not used");
        },
        writeText() {
          throw new Error("disk write denied");
        },
        mkdir() {},
        readdir() {
          return [];
        },
        stat() {
          return null;
        },
        unlink() {},
        rm() {},
      },
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Captured memory",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        message: "Failed to persist memory body file: Error: disk write denied",
        reason: "Memory body write failed.",
        warningMessage: undefined,
      },
    });
  });

  it("fails with partial-write warning when memory index update fails after body write", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "tasks.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");
    const canonicalSourcePath = path.resolve(sourceFile);
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryIndexPath, "{}", "utf-8");

    const baseFs = createNodeFileSystem();
    const writer = createMemoryWriterAdapter({
      fileSystem: {
        ...baseFs,
        rename(fromPath, toPath) {
          if (toPath === memoryIndexPath) {
            throw new Error("rename failed");
          }
          baseFs.rename?.(fromPath, toPath);
        },
      },
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Durable captured memory",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        message: "Memory body was written to "
          + memoryFilePath
          + " but updating memory index failed at "
          + memoryIndexPath
          + ": Error: rename failed",
        reason: "Memory index update failed after writing memory body.",
        warningMessage:
          "Memory capture output was persisted to "
          + memoryFilePath
          + ", but memory index metadata could not be updated.",
      },
    });

    expect(fs.readFileSync(memoryFilePath, "utf-8")).toContain("Durable captured memory");

    const parsedIndex = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(parsedIndex[canonicalSourcePath]).toBeUndefined();
  });

  it("fails when worker output is empty", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "   \n\t ",
    });

    expect(result).toEqual({
      ok: false,
      error: {
        message: "Memory capture worker returned empty output; nothing to persist.",
        reason: "Memory capture worker returned empty output.",
      },
    });
  });

  it("creates the .rundown directory lazily only when writes require it", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const memoryDir = path.join(rootDir, ".rundown");
    fs.mkdirSync(memoryDir, { recursive: true });
    const memoryFilePath = path.join(memoryDir, "tasks.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");
    fs.writeFileSync(memoryFilePath, "Existing memory\n", "utf-8");
    fs.writeFileSync(memoryIndexPath, "{}", "utf-8");

    const mkdirCalls: string[] = [];
    const baseFs = createNodeFileSystem();
    const writer = createMemoryWriterAdapter({
      fileSystem: {
        ...baseFs,
        mkdir(dirPath, options) {
          mkdirCalls.push(dirPath);
          baseFs.mkdir(dirPath, options);
        },
      },
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Fresh capture",
    });

    expect(result.ok).toBe(true);
    expect(mkdirCalls).toEqual([]);
  });

  it("writes memory index via atomic temp-file replace", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const renameCalls: Array<{ fromPath: string; toPath: string }> = [];
    const baseFs = createNodeFileSystem();
    const writer = createMemoryWriterAdapter({
      fileSystem: {
        ...baseFs,
        rename(fromPath, toPath) {
          renameCalls.push({ fromPath, toPath });
          baseFs.rename?.(fromPath, toPath);
        },
      },
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Atomic summary",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(renameCalls.length).toBe(1);
    expect(renameCalls[0]?.toPath).toBe(result.value.memoryIndexPath);
    expect(renameCalls[0]?.fromPath).toContain("memory-index.json.tmp-");

    const index = JSON.parse(fs.readFileSync(result.value.memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(index[path.resolve(sourceFile)]?.summary).toBe("Atomic summary");
  });

  it("creates missing body while preserving existing index entries", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const memoryDir = path.join(rootDir, ".rundown");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");
    const preservedSource = path.join(rootDir, "other.md");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [path.resolve(preservedSource)]: {
        summary: "Preserved summary",
      },
    }, null, 2), "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Captured current context",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const memoryFilePath = path.join(memoryDir, "tasks.md.memory.md");
    expect(fs.existsSync(memoryFilePath)).toBe(true);
    expect(fs.readFileSync(memoryFilePath, "utf-8")).toContain("Captured current context");

    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(index[path.resolve(preservedSource)]?.summary).toBe("Preserved summary");
    expect(index[path.resolve(sourceFile)]?.summary).toBe("Captured current context");
  });

  it("creates missing index while appending to existing body", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const memoryDir = path.join(rootDir, ".rundown");
    const memoryFilePath = path.join(memoryDir, "tasks.md.memory.md");
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(memoryFilePath, "Existing memory body\n", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput: "Appended memory entry",
    });

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(memoryFilePath, "utf-8")).toContain("\n---\n\nAppended memory entry\n");
    expect(fs.existsSync(memoryIndexPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(index[path.resolve(sourceFile)]?.summary).toBe("Appended memory entry");
  });

  it("keys index entries by canonical absolute source path when called with a relative path", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "docs", "plan.md");
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const relativeSourcePath = path.relative(process.cwd(), sourceFile);

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: relativeSourcePath,
      workerOutput: "Relative-path capture",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.canonicalSourcePath).toBe(path.resolve(sourceFile));
    const index = JSON.parse(fs.readFileSync(result.value.memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(index[path.resolve(sourceFile)]?.summary).toBe("Relative-path capture");
  });

  it("handles source rename by writing new source-local memory artifacts without dropping prior index entries", () => {
    const rootDir = makeTempDir();
    const oldSourceFile = path.join(rootDir, "roadmap.md");
    const newSourceFile = path.join(rootDir, "plan.md");
    fs.writeFileSync(oldSourceFile, "- [ ] memory: capture\n", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const firstWrite = writer.write({
      sourcePath: oldSourceFile,
      workerOutput: "Old source memory",
    });
    expect(firstWrite.ok).toBe(true);

    fs.renameSync(oldSourceFile, newSourceFile);

    const secondWrite = writer.write({
      sourcePath: newSourceFile,
      workerOutput: "New source memory",
    });
    expect(secondWrite.ok).toBe(true);
    if (!secondWrite.ok) {
      return;
    }

    const oldMemoryPath = path.join(rootDir, ".rundown", "roadmap.md.memory.md");
    const newMemoryPath = path.join(rootDir, ".rundown", "plan.md.memory.md");
    expect(fs.existsSync(oldMemoryPath)).toBe(true);
    expect(fs.existsSync(newMemoryPath)).toBe(true);

    const index = JSON.parse(fs.readFileSync(secondWrite.value.memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(index[path.resolve(oldSourceFile)]?.summary).toBe("Old source memory");
    expect(index[path.resolve(newSourceFile)]?.summary).toBe("New source memory");
  });

  it("keeps same-basename files in different directories isolated", () => {
    const rootDir = makeTempDir();
    const alphaSource = path.join(rootDir, "alpha", "plan.md");
    const betaSource = path.join(rootDir, "beta", "plan.md");
    fs.mkdirSync(path.dirname(alphaSource), { recursive: true });
    fs.mkdirSync(path.dirname(betaSource), { recursive: true });
    fs.writeFileSync(alphaSource, "- [ ] memory: capture alpha\n", "utf-8");
    fs.writeFileSync(betaSource, "- [ ] memory: capture beta\n", "utf-8");

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const alphaResult = writer.write({
      sourcePath: alphaSource,
      workerOutput: "Alpha memory",
    });
    const betaResult = writer.write({
      sourcePath: betaSource,
      workerOutput: "Beta memory",
    });

    expect(alphaResult.ok).toBe(true);
    expect(betaResult.ok).toBe(true);
    if (!alphaResult.ok || !betaResult.ok) {
      return;
    }

    expect(alphaResult.value.memoryFilePath).toBe(path.join(rootDir, "alpha", ".rundown", "plan.md.memory.md"));
    expect(betaResult.value.memoryFilePath).toBe(path.join(rootDir, "beta", ".rundown", "plan.md.memory.md"));
    expect(alphaResult.value.memoryIndexPath).not.toBe(betaResult.value.memoryIndexPath);

    const alphaIndex = JSON.parse(fs.readFileSync(alphaResult.value.memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    const betaIndex = JSON.parse(fs.readFileSync(betaResult.value.memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    expect(alphaIndex[path.resolve(alphaSource)]?.summary).toBe("Alpha memory");
    expect(betaIndex[path.resolve(betaSource)]?.summary).toBe("Beta memory");
    expect(alphaIndex[path.resolve(betaSource)]).toBeUndefined();
    expect(betaIndex[path.resolve(alphaSource)]).toBeUndefined();
  });

  it("persists large worker output and truncates summary to index limits", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "tasks.md");
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const veryLongFirstLine = "A".repeat(5000);
    const workerOutput = veryLongFirstLine + "\nSecond line";

    const writer = createMemoryWriterAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const result = writer.write({
      sourcePath: sourceFile,
      workerOutput,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const persistedBody = fs.readFileSync(result.value.memoryFilePath, "utf-8");
    expect(persistedBody).toContain(veryLongFirstLine);

    const index = JSON.parse(fs.readFileSync(result.value.memoryIndexPath, "utf-8")) as Record<string, { summary?: string }>;
    const summary = index[path.resolve(sourceFile)]?.summary;
    expect(summary).toBe("A".repeat(157) + "...");
    expect(summary?.length).toBe(160);
  });
});
