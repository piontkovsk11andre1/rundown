import { describe, it, expect } from "vitest";
import { sortFiles } from "../../src/domain/sorting.js";

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

    const sorted = sortFiles(files, "old-first", {
      getBirthtimeMs: (filePath) => statsByFile.get(filePath) ?? 0,
    });
    expect(sorted).toEqual(["/docs/old.md", "/docs/mid.md", "/docs/new.md"]);
  });

  it("should sort new-first by file birthtime", () => {
    const files = ["/docs/new.md", "/docs/mid.md", "/docs/old.md"];
    const statsByFile = new Map<string, number>([
      ["/docs/old.md", 100],
      ["/docs/mid.md", 200],
      ["/docs/new.md", 300],
    ]);

    const sorted = sortFiles(files, "new-first", {
      getBirthtimeMs: (filePath) => statsByFile.get(filePath) ?? 0,
    });
    expect(sorted).toEqual(["/docs/new.md", "/docs/mid.md", "/docs/old.md"]);
  });

  it("falls back to zero birthtime when no timestamp reader is provided", () => {
    const files = ["/docs/b.md", "/docs/a.md"];

    const sorted = sortFiles(files, "old-first");

    expect(sorted).toEqual(files);
  });
});

describe("sortFiles — defensive branches", () => {
  it("sorts case-insensitively when comparing plain text tokens", () => {
    const files = ["/docs/beta.md", "/docs/Alpha.md"];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual(["/docs/Alpha.md", "/docs/beta.md"]);
  });

  it("orders numeric tokens before text tokens in natural sorting", () => {
    const files = ["/docs/alpha.md", "/docs/10-start.md"];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual(["/docs/10-start.md", "/docs/alpha.md"]);
  });

  it("handles comparator calls where a text token is compared against a numeric token", () => {
    const files = ["/docs/10-start.md", "/docs/alpha.md", "/docs/20-z.md"];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual(["/docs/10-start.md", "/docs/20-z.md", "/docs/alpha.md"]);
  });

  it("orders a shorter token sequence before a longer matching prefix", () => {
    const files = ["/docs/part2a.md", "/docs/part2.md", "/docs/part10.md"];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual(["/docs/part2.md", "/docs/part2a.md", "/docs/part10.md"]);
  });

  it("orders a longer matching prefix after the shorter token sequence when reversed", () => {
    const files = ["/docs/task-1.md", "/docs/task-1a.md"];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual(["/docs/task-1.md", "/docs/task-1a.md"]);
  });

  it("returns original order for unsupported sort modes", () => {
    const files = ["/docs/z.md", "/docs/a.md"];

    const sorted = sortFiles(files, "unexpected-mode" as never);

    expect(sorted).toEqual(files);
  });

  it("preserves order when filenames compare as equal", () => {
    const files = ["/docs/a/readme.md", "/notes/readme.md"];

    const sorted = sortFiles(files, "name-sort");

    expect(sorted).toEqual(files);
  });
});
