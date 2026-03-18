import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import { sortFiles } from "./sorting.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sortFiles — name-sort", () => {
  it("should sort numerically within filenames", () => {
    const files = [
      "/docs/10. Plan.md",
      "/docs/2. Idea.md",
      "/docs/1. Intro.md",
      "/docs/23. Feature.md",
    ];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual([
      "/docs/1. Intro.md",
      "/docs/2. Idea.md",
      "/docs/10. Plan.md",
      "/docs/23. Feature.md",
    ]);
  });

  it("should handle files without numbers", () => {
    const files = [
      "/docs/zebra.md",
      "/docs/alpha.md",
      "/docs/mango.md",
    ];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual([
      "/docs/alpha.md",
      "/docs/mango.md",
      "/docs/zebra.md",
    ]);
  });

  it("should handle mixed numbered and unnumbered", () => {
    const files = [
      "/docs/README.md",
      "/docs/3. Build.md",
      "/docs/1. Start.md",
    ];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual([
      "/docs/1. Start.md",
      "/docs/3. Build.md",
      "/docs/README.md",
    ]);
  });
});

describe("sortFiles — none", () => {
  it("should preserve original order", () => {
    const files = ["/c.md", "/a.md", "/b.md"];
    const sorted = sortFiles(files, "none");

    expect(sorted).toEqual(["/c.md", "/a.md", "/b.md"]);
  });
});

describe("sortFiles — time-based", () => {
  it("should sort old-first by file birthtime", () => {
    const files = ["/docs/new.md", "/docs/mid.md", "/docs/old.md"];
    const statsByFile = new Map<string, number>([
      ["/docs/old.md", 100],
      ["/docs/mid.md", 200],
      ["/docs/new.md", 300],
    ]);

    vi.spyOn(fs, "statSync").mockImplementation((filePath: fs.PathLike) => {
      const file = String(filePath);
      return {
        birthtimeMs: statsByFile.get(file) ?? 0,
      } as fs.Stats;
    });

    const sorted = sortFiles(files, "old-first");
    expect(sorted).toEqual(["/docs/old.md", "/docs/mid.md", "/docs/new.md"]);
  });

  it("should sort new-first by file birthtime", () => {
    const files = ["/docs/new.md", "/docs/mid.md", "/docs/old.md"];
    const statsByFile = new Map<string, number>([
      ["/docs/old.md", 100],
      ["/docs/mid.md", 200],
      ["/docs/new.md", 300],
    ]);

    vi.spyOn(fs, "statSync").mockImplementation((filePath: fs.PathLike) => {
      const file = String(filePath);
      return {
        birthtimeMs: statsByFile.get(file) ?? 0,
      } as fs.Stats;
    });

    const sorted = sortFiles(files, "new-first");
    expect(sorted).toEqual(["/docs/new.md", "/docs/mid.md", "/docs/old.md"]);
  });
});
