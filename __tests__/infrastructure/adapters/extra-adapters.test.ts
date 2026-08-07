import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { loadTemplateVarsFileMock, openDirectoryMock } = vi.hoisted(() => ({
  loadTemplateVarsFileMock: vi.fn(() => ({ branch: "main" })),
  openDirectoryMock: vi.fn(),
}));

vi.mock("../../../src/infrastructure/template-vars-io.js", () => ({
  loadTemplateVarsFile: loadTemplateVarsFileMock,
}));

vi.mock("../../../src/infrastructure/open-directory.js", () => ({
  openDirectory: openDirectoryMock,
}));

import { createFsTemplateVarsLoaderAdapter } from "../../../src/infrastructure/adapters/fs-template-vars-loader-adapter.js";
import { createDirectoryOpenerAdapter } from "../../../src/infrastructure/adapters/directory-opener-adapter.js";
import { createWorkerConfigAdapter } from "../../../src/infrastructure/adapters/worker-config-adapter.js";

const tempDirs: string[] = [];

beforeEach(() => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-extra-adapters-home-"));
  tempDirs.push(isolatedHome);
  vi.spyOn(os, "homedir").mockReturnValue(isolatedHome);
});

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  vi.restoreAllMocks();
});

describe("extra infrastructure adapters", () => {
  it("template vars loader adapter delegates to loadTemplateVarsFile", () => {
    const adapter = createFsTemplateVarsLoaderAdapter();
    const result = adapter.load(".rundown/vars.json", "/repo", "/repo/.rundown");

    expect(loadTemplateVarsFileMock).toHaveBeenCalledWith(
      ".rundown/vars.json",
      "/repo",
      "/repo/.rundown",
    );
    expect(result).toEqual({ branch: "main" });
  });

  it("directory opener adapter exposes openDirectory", () => {
    const adapter = createDirectoryOpenerAdapter();
    adapter.openDirectory("/repo");

    expect(openDirectoryMock).toHaveBeenCalledWith("/repo");
  });

  it("worker config adapter returns undefined when config file does not exist", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-config-"));

    try {
      const adapter = createWorkerConfigAdapter();
      expect(adapter.load(tempDir)).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("worker config adapter loads valid config", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-config-"));

    try {
      const config = {
        workers: { default: ["opencode", "run"] },
        commands: {
          plan: ["opencode", "run", "--model", "opus-4.6"],
          research: ["opencode", "run", "--model", "opus-4.6"],
        },
        profiles: {
          fast: ["opencode", "run", "--model", "gpt-5.3-codex"],
        },
        traceStatistics: {
          enabled: false,
          fields: ["total_time", "tokens_estimated"],
        },
      };
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify(config), "utf-8");

      const adapter = createWorkerConfigAdapter();
      expect(adapter.load(tempDir)).toEqual(config);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("worker config adapter throws actionable error on malformed JSON", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-config-"));

    try {
      fs.writeFileSync(path.join(tempDir, "config.json"), "{\n  \"defaults\": ", "utf-8");

      const adapter = createWorkerConfigAdapter();

      expect(() => adapter.load(tempDir)).toThrowError(/Failed to parse worker config/);
      expect(() => adapter.load(tempDir)).toThrowError(/invalid JSON/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("worker config adapter throws actionable error on invalid schema", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-worker-config-"));

    try {
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({ workers: { default: "opencode" } }), "utf-8");

      const adapter = createWorkerConfigAdapter();

      expect(() => adapter.load(tempDir)).toThrowError(/Invalid worker config/);
      expect(() => adapter.load(tempDir)).toThrowError(/workers\.default/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
