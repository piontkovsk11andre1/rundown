import { describe, it, expect } from "vitest";
import { sortFiles } from "./sorting.js";

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
