import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSources } from "../../src/infrastructure/sources.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-sources-"));
  tempDirs.push(dir);
  return dir;
}

describe("resolveSources", () => {
  it("returns a single file path when source is a file", async () => {
    const dir = makeTempDir();
    const file = path.join(dir, "task.md");
    fs.writeFileSync(file, "- [ ] Example\n", "utf-8");

    const files = await resolveSources(file);

    expect(files).toEqual([path.resolve(file)]);
  });

  it("resolves directory source recursively to markdown files only", async () => {
    const dir = makeTempDir();
    const nested = path.join(dir, "docs", "nested");
    fs.mkdirSync(nested, { recursive: true });

    const mdA = path.join(dir, "README.md");
    const mdB = path.join(nested, "notes.md");
    const txt = path.join(nested, "ignore.txt");

    fs.writeFileSync(mdA, "# Readme\n", "utf-8");
    fs.writeFileSync(mdB, "- [ ] Task\n", "utf-8");
    fs.writeFileSync(txt, "ignore\n", "utf-8");

    const files = await resolveSources(dir);
    const normalized = files.map((file) => path.normalize(file)).sort();

    expect(normalized).toEqual([
      path.normalize(path.resolve(mdA)),
      path.normalize(path.resolve(mdB)),
    ]);
  });

  it("resolves glob source and filters to .md files", async () => {
    const dir = makeTempDir();
    const md = path.join(dir, "one.md");
    const mdx = path.join(dir, "two.mdx");
    const txt = path.join(dir, "three.txt");

    fs.writeFileSync(md, "- [ ] Task\n", "utf-8");
    fs.writeFileSync(mdx, "# mdx\n", "utf-8");
    fs.writeFileSync(txt, "plain\n", "utf-8");

    const pattern = path.join(dir, "*").replace(/\\/g, "/");
    const files = await resolveSources(pattern);

    expect(files.map((file) => path.normalize(file))).toEqual([
      path.normalize(path.resolve(md)),
    ]);
  });

  it("returns empty array when nothing matches", async () => {
    const dir = makeTempDir();
    const files = await resolveSources(path.join(dir, "missing", "*.md"));
    expect(files).toEqual([]);
  });
});
