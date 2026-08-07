import { describe, expect, it, vi } from "vitest";
import { getFileBirthtimeMs } from "../../src/infrastructure/file-birthtime.js";

describe("getFileBirthtimeMs", () => {
  it("returns birthtimeMs when stat returns a value", () => {
    const fileSystem = {
      stat: vi.fn(() => ({
        isFile: true,
        isDirectory: false,
        birthtimeMs: 1234,
        mtimeMs: 4567,
      })),
    };

    expect(getFileBirthtimeMs("tasks.md", fileSystem)).toBe(1234);
    expect(fileSystem.stat).toHaveBeenCalledWith("tasks.md");
  });

  it("returns 0 when stat returns null", () => {
    const fileSystem = {
      stat: vi.fn(() => null),
    };

    expect(getFileBirthtimeMs("tasks.md", fileSystem)).toBe(0);
  });

  it("returns 0 when stat throws", () => {
    const fileSystem = {
      stat: vi.fn(() => {
        throw new Error("boom");
      }),
    };

    expect(getFileBirthtimeMs("tasks.md", fileSystem)).toBe(0);
  });
});
