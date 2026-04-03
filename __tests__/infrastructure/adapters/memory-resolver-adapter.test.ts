import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryResolverAdapter } from "../../../src/infrastructure/adapters/memory-resolver-adapter.js";
import { createNodeFileSystem } from "../../../src/infrastructure/adapters/fs-file-system.js";
import { createNodePathOperationsAdapter } from "../../../src/infrastructure/adapters/node-path-operations-adapter.js";
import { resolveSources } from "../../../src/infrastructure/sources.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-memory-resolver-"));
  tempDirs.push(dir);
  return dir;
}

function normalizePaths(paths: string[]): string[] {
  return paths.map((filePath) => path.normalize(filePath));
}

describe("createMemoryResolverAdapter", () => {
  it("resolves deterministic memory metadata across relative, absolute, directory, and glob sources", async () => {
    const rootDir = makeTempDir();
    const docsDir = path.join(rootDir, "docs");
    fs.mkdirSync(docsDir, { recursive: true });

    const sourceFile = path.join(docsDir, "roadmap.md");
    fs.writeFileSync(sourceFile, "# Roadmap\n", "utf-8");

    const memoryDir = path.join(docsDir, ".rundown");
    fs.mkdirSync(memoryDir, { recursive: true });
    const expectedMemoryPath = path.join(memoryDir, "roadmap.md.memory.md");
    fs.writeFileSync(expectedMemoryPath, "# Memory\n", "utf-8");

    const expectedSummary = "Tracks scope decisions and open questions.";
    const canonicalSourcePath = path.resolve(sourceFile);
    const memoryIndexPath = path.join(memoryDir, "memory-index.json");
    fs.writeFileSync(memoryIndexPath, JSON.stringify({
      [canonicalSourcePath]: {
        summary: expectedSummary,
      },
    }), "utf-8");

    const relativeSourceInput = path.relative(process.cwd(), sourceFile);
    const absoluteResolved = await resolveSources(sourceFile);
    const relativeResolved = await resolveSources(relativeSourceInput);
    const directoryResolved = await resolveSources(docsDir);
    const globResolved = await resolveSources(path.join(docsDir, "*.md").replace(/\\/g, "/"));

    const normalizedCanonical = path.normalize(canonicalSourcePath);
    const normalizedAbsoluteResolved = normalizePaths(absoluteResolved);
    const normalizedRelativeResolved = normalizePaths(relativeResolved);
    const normalizedDirectoryResolved = normalizePaths(directoryResolved);
    const normalizedGlobResolved = normalizePaths(globResolved);

    expect(normalizedAbsoluteResolved).toEqual([normalizedCanonical]);
    expect(normalizedRelativeResolved).toEqual([normalizedCanonical]);
    expect(normalizedDirectoryResolved).toContain(normalizedCanonical);
    expect(normalizedGlobResolved).toContain(normalizedCanonical);

    const directorySource = directoryResolved.find(
      (candidatePath) => path.normalize(candidatePath) === normalizedCanonical,
    );
    const globSource = globResolved.find(
      (candidatePath) => path.normalize(candidatePath) === normalizedCanonical,
    );

    const resolver = createMemoryResolverAdapter({
      pathOperations: createNodePathOperationsAdapter(),
      fileSystem: createNodeFileSystem(),
    });

    expect(resolver.resolve(absoluteResolved[0] as string)).toEqual({
      available: true,
      filePath: expectedMemoryPath,
      summary: expectedSummary,
    });
    expect(resolver.resolve(relativeResolved[0] as string)).toEqual({
      available: true,
      filePath: expectedMemoryPath,
      summary: expectedSummary,
    });
    expect(resolver.resolve(directorySource as string)).toEqual({
      available: true,
      filePath: expectedMemoryPath,
      summary: expectedSummary,
    });
    expect(resolver.resolve(globSource as string)).toEqual({
      available: true,
      filePath: expectedMemoryPath,
      summary: expectedSummary,
    });
  });

  it("keeps same-basename files in different directories collision-safe", async () => {
    const rootDir = makeTempDir();
    const alphaDir = path.join(rootDir, "alpha");
    const betaDir = path.join(rootDir, "beta");
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });

    const alphaFile = path.join(alphaDir, "plan.md");
    const betaFile = path.join(betaDir, "plan.md");
    fs.writeFileSync(alphaFile, "- [ ] Alpha\n", "utf-8");
    fs.writeFileSync(betaFile, "- [ ] Beta\n", "utf-8");

    const alphaMemoryDir = path.join(alphaDir, ".rundown");
    const betaMemoryDir = path.join(betaDir, ".rundown");
    fs.mkdirSync(alphaMemoryDir, { recursive: true });
    fs.mkdirSync(betaMemoryDir, { recursive: true });

    const alphaMemoryPath = path.join(alphaMemoryDir, "plan.md.memory.md");
    const betaMemoryPath = path.join(betaMemoryDir, "plan.md.memory.md");
    fs.writeFileSync(alphaMemoryPath, "# Alpha memory\n", "utf-8");
    fs.writeFileSync(betaMemoryPath, "# Beta memory\n", "utf-8");

    const resolver = createMemoryResolverAdapter({
      pathOperations: createNodePathOperationsAdapter(),
      fileSystem: createNodeFileSystem(),
    });

    const resolvedFromDirectory = await resolveSources(rootDir);
    const resolvedFromGlob = await resolveSources(path.join(rootDir, "**/*.md").replace(/\\/g, "/"));

    const normalizedResolvedFromDirectory = normalizePaths(resolvedFromDirectory);
    const normalizedResolvedFromGlob = normalizePaths(resolvedFromGlob);
    const normalizedAlphaPath = path.normalize(path.resolve(alphaFile));
    const normalizedBetaPath = path.normalize(path.resolve(betaFile));

    expect(normalizedResolvedFromDirectory).toContain(normalizedAlphaPath);
    expect(normalizedResolvedFromDirectory).toContain(normalizedBetaPath);
    expect(normalizedResolvedFromGlob).toContain(normalizedAlphaPath);
    expect(normalizedResolvedFromGlob).toContain(normalizedBetaPath);

    const alphaMemory = resolver.resolve(alphaFile);
    const betaMemory = resolver.resolve(betaFile);

    expect(alphaMemory.filePath).toBe(alphaMemoryPath);
    expect(betaMemory.filePath).toBe(betaMemoryPath);
    expect(alphaMemory.filePath).not.toBe(betaMemory.filePath);
    expect(alphaMemory.available).toBe(true);
    expect(betaMemory.available).toBe(true);
  });

  it("maps a relative source path to a source-local memory file path", () => {
    const pathOperations = createNodePathOperationsAdapter();
    const sourcePath = "docs/roadmap.md";
    const resolvedSourcePath = path.resolve(sourcePath);
    const expectedMemoryPath = path.join(
      path.dirname(resolvedSourcePath),
      ".rundown",
      `${path.basename(resolvedSourcePath)}.memory.md`,
    );

    const resolver = createMemoryResolverAdapter({
      pathOperations,
      fileSystem: {
        exists(candidatePath) {
          return candidatePath === expectedMemoryPath;
        },
        readText() {
          throw new Error("not implemented");
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
    });

    expect(resolver.resolve(sourcePath)).toEqual({
      available: true,
      filePath: expectedMemoryPath,
      summary: undefined,
    });
  });

  it("keeps source-basename identity for Windows-style paths", () => {
    const resolver = createMemoryResolverAdapter({
      pathOperations: {
        join: (...parts) => parts.join("\\"),
        resolve: (filePath) => filePath.replace(/\//g, "\\"),
        dirname: (filePath) => filePath.slice(0, filePath.lastIndexOf("\\")),
        relative: () => "",
        isAbsolute: () => true,
      },
      fileSystem: {
        exists: () => false,
        readText() {
          throw new Error("not implemented");
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
    });

    expect(resolver.resolve("C:/workspace/docs/roadmap.md")).toEqual({
      available: false,
      filePath: "C:\\workspace\\docs\\.rundown\\roadmap.md.memory.md",
      summary: undefined,
    });
  });

  it("loads summary from source-local memory-index.json keyed by canonical source path", () => {
    const pathOperations = createNodePathOperationsAdapter();
    const sourcePath = "docs/roadmap.md";
    const canonicalSourcePath = path.resolve(sourcePath);
    const sourceDir = path.dirname(canonicalSourcePath);
    const memoryPath = path.join(sourceDir, ".rundown", `${path.basename(canonicalSourcePath)}.memory.md`);
    const memoryIndexPath = path.join(sourceDir, ".rundown", "memory-index.json");

    const resolver = createMemoryResolverAdapter({
      pathOperations,
      fileSystem: {
        exists(candidatePath) {
          return candidatePath === memoryPath || candidatePath === memoryIndexPath;
        },
        readText(filePath) {
          if (filePath !== memoryIndexPath) {
            throw new Error("unexpected file read");
          }
          return JSON.stringify({
            [canonicalSourcePath]: {
              summary: "Keeps milestone decisions and open risks.",
            },
          });
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
    });

    expect(resolver.resolve(sourcePath)).toEqual({
      available: true,
      filePath: memoryPath,
      summary: "Keeps milestone decisions and open risks.",
    });
  });

  it("returns undefined summary when memory-index.json is malformed", () => {
    const pathOperations = createNodePathOperationsAdapter();
    const sourcePath = "docs/roadmap.md";
    const canonicalSourcePath = path.resolve(sourcePath);
    const sourceDir = path.dirname(canonicalSourcePath);
    const memoryPath = path.join(sourceDir, ".rundown", `${path.basename(canonicalSourcePath)}.memory.md`);
    const memoryIndexPath = path.join(sourceDir, ".rundown", "memory-index.json");

    const resolver = createMemoryResolverAdapter({
      pathOperations,
      fileSystem: {
        exists(candidatePath) {
          return candidatePath === memoryPath || candidatePath === memoryIndexPath;
        },
        readText() {
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
    });

    expect(resolver.resolve(sourcePath)).toEqual({
      available: true,
      filePath: memoryPath,
      summary: undefined,
    });
  });

  it("falls back when only memory-index.json exists", () => {
    const pathOperations = createNodePathOperationsAdapter();
    const sourcePath = "docs/roadmap.md";
    const canonicalSourcePath = path.resolve(sourcePath);
    const sourceDir = path.dirname(canonicalSourcePath);
    const memoryPath = path.join(sourceDir, ".rundown", `${path.basename(canonicalSourcePath)}.memory.md`);
    const memoryIndexPath = path.join(sourceDir, ".rundown", "memory-index.json");

    const resolver = createMemoryResolverAdapter({
      pathOperations,
      fileSystem: {
        exists(candidatePath) {
          return candidatePath === memoryIndexPath;
        },
        readText(filePath) {
          if (filePath !== memoryIndexPath) {
            throw new Error("unexpected file read");
          }
          return JSON.stringify({
            [canonicalSourcePath]: {
              summary: "Memory file has not been created yet.",
            },
          });
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
    });

    expect(resolver.resolve(sourcePath)).toEqual({
      available: false,
      filePath: memoryPath,
      summary: "Memory file has not been created yet.",
    });
  });

  it("does not throw when exists checks fail", () => {
    const pathOperations = createNodePathOperationsAdapter();
    const sourcePath = "docs/roadmap.md";
    const canonicalSourcePath = path.resolve(sourcePath);
    const sourceDir = path.dirname(canonicalSourcePath);
    const memoryPath = path.join(sourceDir, ".rundown", `${path.basename(canonicalSourcePath)}.memory.md`);

    const resolver = createMemoryResolverAdapter({
      pathOperations,
      fileSystem: {
        exists() {
          throw new Error("filesystem unavailable");
        },
        readText() {
          throw new Error("not implemented");
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
    });

    expect(resolver.resolve(sourcePath)).toEqual({
      available: false,
      filePath: memoryPath,
      summary: undefined,
    });
  });

  it("does not create .rundown directories during read-only lookup", () => {
    const pathOperations = createNodePathOperationsAdapter();
    const sourcePath = "docs/roadmap.md";
    const canonicalSourcePath = path.resolve(sourcePath);
    const sourceDir = path.dirname(canonicalSourcePath);
    const memoryPath = path.join(sourceDir, ".rundown", `${path.basename(canonicalSourcePath)}.memory.md`);
    const memoryIndexPath = path.join(sourceDir, ".rundown", "memory-index.json");

    let mkdirCallCount = 0;

    const resolver = createMemoryResolverAdapter({
      pathOperations,
      fileSystem: {
        exists(candidatePath) {
          return candidatePath === memoryPath || candidatePath === memoryIndexPath;
        },
        readText(filePath) {
          if (filePath !== memoryIndexPath) {
            throw new Error("unexpected file read");
          }
          return JSON.stringify({
            [canonicalSourcePath]: {
              summary: "Tracks active milestones.",
            },
          });
        },
        writeText() {
          throw new Error("not implemented");
        },
        mkdir() {
          mkdirCallCount += 1;
          throw new Error("mkdir should not be called during lookup");
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
    });

    expect(resolver.resolve(sourcePath)).toEqual({
      available: true,
      filePath: memoryPath,
      summary: "Tracks active milestones.",
    });
    expect(mkdirCallCount).toBe(0);
  });
});
