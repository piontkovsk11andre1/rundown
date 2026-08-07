import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryReaderAdapter } from "../../../src/infrastructure/adapters/memory-reader-adapter.js";
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-memory-reader-"));
  tempDirs.push(dir);
  return dir;
}

describe("createMemoryReaderAdapter", () => {
  it("reads source-local memory entries and index metadata", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "docs", "plan.md");
    const canonicalSourcePath = path.resolve(sourceFile);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const memoryDir = path.join(path.dirname(sourceFile), ".rundown");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "plan.md.memory.md"),
      "First entry\n\n---\n\nSecond entry\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(memoryDir, "memory-index.json"),
      JSON.stringify({
        [canonicalSourcePath]: {
          summary: "Second entry",
          updatedAt: "2026-04-04T23:15:59.904Z",
          lastPrefix: "memory",
          entryCount: 2,
          origin: {
            taskText: "memory: capture",
            taskLine: 3,
            sourceHash: "abc123",
          },
        },
      }),
      "utf-8",
    );

    const adapter = createMemoryReaderAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(adapter.read(sourceFile)).toEqual({
      entries: ["First entry", "Second entry"],
      index: {
        summary: "Second entry",
        updatedAt: "2026-04-04T23:15:59.904Z",
        lastPrefix: "memory",
        entryCount: 2,
        origin: {
          taskText: "memory: capture",
          taskLine: 3,
          sourceHash: "abc123",
        },
      },
    });
  });

  it("returns empty results when memory artifacts are missing or malformed", () => {
    const adapter = createMemoryReaderAdapter({
      fileSystem: {
        exists(filePath) {
          return filePath.endsWith("memory-index.json");
        },
        readText(filePath) {
          if (!filePath.endsWith("memory-index.json")) {
            throw new Error("unexpected file read");
          }
          return "{\"broken\":";
        },
        writeText() {
          throw new Error("not implemented");
        },
        mkdir() {
          throw new Error("not implemented");
        },
        readdir() {
          throw new Error("not implemented");
        },
        stat() {
          throw new Error("not implemented");
        },
        unlink() {
          throw new Error("not implemented");
        },
        rm() {
          throw new Error("not implemented");
        },
      },
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(adapter.read("docs/plan.md")).toEqual({
      entries: [],
      index: null,
    });
  });

  it("parses body entries using separators and trims entry whitespace", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "docs", "plan.md");
    const canonicalSourcePath = path.resolve(sourceFile);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const memoryDir = path.join(path.dirname(sourceFile), ".rundown");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "plan.md.memory.md"),
      "\r\n   First entry   \r\n\r\n---\r\n\r\n   Second entry   \r\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(memoryDir, "memory-index.json"),
      JSON.stringify({
        [canonicalSourcePath]: {
          summary: "Second entry",
          updatedAt: "2026-04-04T23:16:10.000Z",
          entryCount: 2,
        },
      }),
      "utf-8",
    );

    const adapter = createMemoryReaderAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(adapter.read(sourceFile)).toEqual({
      entries: ["First entry", "Second entry"],
      index: {
        summary: "Second entry",
        updatedAt: "2026-04-04T23:16:10.000Z",
        entryCount: 2,
      },
    });
  });

  it("returns empty entries for missing body and null for malformed index entry", () => {
    const rootDir = makeTempDir();
    const sourceFile = path.join(rootDir, "docs", "plan.md");
    const canonicalSourcePath = path.resolve(sourceFile);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, "- [ ] memory: capture\n", "utf-8");

    const memoryDir = path.join(path.dirname(sourceFile), ".rundown");
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(
      path.join(memoryDir, "memory-index.json"),
      JSON.stringify({
        [canonicalSourcePath]: {
          summary: 123,
          updatedAt: "2026-04-04T23:16:20.000Z",
          entryCount: 1,
        },
      }),
      "utf-8",
    );

    const adapter = createMemoryReaderAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    expect(adapter.read(sourceFile)).toEqual({
      entries: [],
      index: null,
    });
  });

  it("reads all memory files under nested source directories", () => {
    const rootDir = makeTempDir();
    const alphaSource = path.join(rootDir, "alpha", "plan.md");
    const betaSource = path.join(rootDir, "beta", "notes.md");
    fs.mkdirSync(path.dirname(alphaSource), { recursive: true });
    fs.mkdirSync(path.dirname(betaSource), { recursive: true });
    fs.writeFileSync(alphaSource, "- [ ] memory\n", "utf-8");
    fs.writeFileSync(betaSource, "- [ ] memory\n", "utf-8");

    const alphaMemoryDir = path.join(rootDir, "alpha", ".rundown");
    const betaMemoryDir = path.join(rootDir, "beta", ".rundown");
    fs.mkdirSync(alphaMemoryDir, { recursive: true });
    fs.mkdirSync(betaMemoryDir, { recursive: true });

    fs.writeFileSync(path.join(alphaMemoryDir, "plan.md.memory.md"), "Alpha one\n", "utf-8");
    fs.writeFileSync(path.join(betaMemoryDir, "notes.md.memory.md"), "Beta one\n\n---\n\nBeta two\n", "utf-8");

    fs.writeFileSync(
      path.join(alphaMemoryDir, "memory-index.json"),
      JSON.stringify({
        [path.resolve(alphaSource)]: {
          summary: "Alpha one",
          updatedAt: "2026-04-04T23:15:59.904Z",
          entryCount: 1,
        },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(betaMemoryDir, "memory-index.json"),
      JSON.stringify({
        [path.resolve(betaSource)]: {
          summary: "Beta two",
          updatedAt: "2026-04-04T23:16:00.000Z",
          entryCount: 2,
          lastPrefix: "remember",
        },
      }),
      "utf-8",
    );

    const adapter = createMemoryReaderAdapter({
      fileSystem: createNodeFileSystem(),
      pathOperations: createNodePathOperationsAdapter(),
    });

    const all = adapter.readAll(rootDir)
      .sort((a, b) => a.memoryFilePath.localeCompare(b.memoryFilePath));

    expect(all).toEqual([
      {
        sourcePath: path.resolve(alphaSource),
        memoryFilePath: path.join(alphaMemoryDir, "plan.md.memory.md"),
        entries: ["Alpha one"],
        index: {
          summary: "Alpha one",
          updatedAt: "2026-04-04T23:15:59.904Z",
          entryCount: 1,
        },
      },
      {
        sourcePath: path.resolve(betaSource),
        memoryFilePath: path.join(betaMemoryDir, "notes.md.memory.md"),
        entries: ["Beta one", "Beta two"],
        index: {
          summary: "Beta two",
          updatedAt: "2026-04-04T23:16:00.000Z",
          entryCount: 2,
          lastPrefix: "remember",
        },
      },
    ]);
  });
});
