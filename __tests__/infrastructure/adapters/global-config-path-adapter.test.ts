import { describe, expect, it } from "vitest";
import { resolveGlobalConfigPath } from "../../../src/infrastructure/adapters/global-config-path-adapter.js";

describe("resolveGlobalConfigPath", () => {
  it("uses a single homedir-derived canonical path on win32", () => {
    const homeDir = "C:\\Users\\alice";

    const result = resolveGlobalConfigPath({
      platform: "win32",
      homedir: homeDir,
      fileExists: (filePath) => filePath === `${homeDir}\\AppData\\Roaming\\rundown\\config.json`,
    });

    expect(result.canonicalPath).toBe(`${homeDir}\\AppData\\Roaming\\rundown\\config.json`);
    expect(result.discoveredPath).toBe(`${homeDir}\\AppData\\Roaming\\rundown\\config.json`);
    expect(result.candidates).toEqual([
      `${homeDir}\\AppData\\Roaming\\rundown\\config.json`,
    ]);
  });

  it("uses macOS Library/Application Support as canonical location", () => {
    const result = resolveGlobalConfigPath({
      platform: "darwin",
      homedir: "/Users/alice",
      fileExists: (filePath) => filePath === "/Users/alice/Library/Application Support/rundown/config.json",
    });

    expect(result.canonicalPath).toBe("/Users/alice/Library/Application Support/rundown/config.json");
    expect(result.discoveredPath).toBe("/Users/alice/Library/Application Support/rundown/config.json");
    expect(result.candidates).toEqual([
      "/Users/alice/Library/Application Support/rundown/config.json",
    ]);
  });

  it("uses homedir .config canonical location on linux", () => {
    const result = resolveGlobalConfigPath({
      platform: "linux",
      homedir: "/home/alice",
      fileExists: (filePath) => filePath === "/home/alice/.config/rundown/config.json",
    });

    expect(result.canonicalPath).toBe("/home/alice/.config/rundown/config.json");
    expect(result.discoveredPath).toBe("/home/alice/.config/rundown/config.json");
    expect(result.candidates).toEqual([
      "/home/alice/.config/rundown/config.json",
    ]);
  });

  it("returns undefined paths when homedir is unavailable", () => {
    const result = resolveGlobalConfigPath({
      platform: "linux",
      homedir: "   ",
      fileExists: () => false,
    });

    expect(result.canonicalPath).toBeUndefined();
    expect(result.discoveredPath).toBeUndefined();
    expect(result.candidates).toEqual([]);
  });
});
