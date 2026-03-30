import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

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
        defaults: { worker: ["opencode", "run"] },
        commands: {
          plan: { workerArgs: ["--model", "opus-4.6"] },
        },
        profiles: {
          fast: { workerArgs: ["--model", "gpt-5.3-codex"] },
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
      fs.writeFileSync(path.join(tempDir, "config.json"), JSON.stringify({ defaults: { worker: "opencode" } }), "utf-8");

      const adapter = createWorkerConfigAdapter();

      expect(() => adapter.load(tempDir)).toThrowError(/Invalid worker config/);
      expect(() => adapter.load(tempDir)).toThrowError(/defaults\.worker/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
