import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeFileSystem } from "../../../src/infrastructure/adapters/fs-file-system.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createNodeFileSystem", () => {
  it("reads, writes, stats, and removes files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-fs-"));
    tempDirs.push(root);

    const fileSystem = createNodeFileSystem();
    const file = path.join(root, "tasks.md");

    expect(fileSystem.exists(file)).toBe(false);

    fileSystem.writeText(file, "- [ ] Ship\n");
    expect(fileSystem.exists(file)).toBe(true);
    expect(fileSystem.readText(file)).toContain("Ship");

    const stats = fileSystem.stat(file);
    expect(stats?.isFile).toBe(true);
    expect(stats?.isDirectory).toBe(false);
    expect(Number.isFinite(stats?.birthtimeMs ?? Number.NaN)).toBe(true);

    fileSystem.unlink(file);
    expect(fileSystem.exists(file)).toBe(false);
  });

  it("creates directories, lists entries, and rm removes recursively", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-fs-"));
    tempDirs.push(root);

    const fileSystem = createNodeFileSystem();
    const nested = path.join(root, "docs");
    const nestedFile = path.join(nested, "roadmap.md");

    fileSystem.mkdir(nested, { recursive: true });
    fileSystem.writeText(nestedFile, "- [ ] Plan\n");

    const entries = fileSystem.readdir(root);
    expect(entries.some((entry) => entry.name === "docs" && entry.isDirectory)).toBe(true);

    const dirStats = fileSystem.stat(nested);
    expect(dirStats?.isDirectory).toBe(true);

    fileSystem.rm(nested, { recursive: true, force: true });
    expect(fileSystem.exists(nested)).toBe(false);
  });

  it("returns null from stat when the file does not exist", () => {
    const fileSystem = createNodeFileSystem();
    const missing = path.join(os.tmpdir(), "rundown-missing-file.md");

    expect(fileSystem.stat(missing)).toBeNull();
  });
});
