import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISCUSS_TEMPLATE,
  DEFAULT_PLAN_TEMPLATE,
  DEFAULT_RESEARCH_TEMPLATE,
  DEFAULT_REPAIR_TEMPLATE,
  DEFAULT_TASK_TEMPLATE,
  DEFAULT_TRACE_TEMPLATE,
  DEFAULT_VERIFY_TEMPLATE,
} from "../../../src/domain/defaults.js";
import { CONFIG_DIR_NAME } from "../../../src/domain/ports/config-dir-port.js";
import { createConfigDirAdapter } from "../../../src/infrastructure/adapters/config-dir-adapter.js";
import { loadProjectTemplates } from "../../../src/infrastructure/templates-loader.js";

describe("createConfigDirAdapter", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  it("finds .rundown in cwd immediately", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-config-dir-"));
    tempDirs.push(tempDir);
    const configDir = path.join(tempDir, CONFIG_DIR_NAME);
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "{}");

    const adapter = createConfigDirAdapter();
    const result = adapter.resolve(tempDir);

    expect(result).toEqual({
      configDir,
      isExplicit: false,
    });
  });

  it("finds .rundown two levels up", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-config-dir-"));
    tempDirs.push(tempDir);
    const configDir = path.join(tempDir, CONFIG_DIR_NAME);
    const deepDir = path.join(tempDir, "one", "two");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "{}");
    fs.mkdirSync(deepDir, { recursive: true });

    const adapter = createConfigDirAdapter();
    const result = adapter.resolve(deepDir);

    expect(result).toEqual({
      configDir,
      isExplicit: false,
    });
  });

  it("finds a symlinked .rundown directory", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-config-dir-"));
    tempDirs.push(tempDir);

    const actualConfigDir = path.join(tempDir, "shared-config");
    const symlinkedConfigDir = path.join(tempDir, CONFIG_DIR_NAME);
    const deepDir = path.join(tempDir, "nested", "project");

    fs.mkdirSync(actualConfigDir, { recursive: true });
    fs.writeFileSync(path.join(actualConfigDir, "config.json"), "{}");
    fs.symlinkSync(
      actualConfigDir,
      symlinkedConfigDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    fs.mkdirSync(deepDir, { recursive: true });

    const adapter = createConfigDirAdapter();
    const result = adapter.resolve(deepDir);

    expect(result).toEqual({
      configDir: symlinkedConfigDir,
      isExplicit: false,
    });
  });

  it("skips .rundown without config.json and finds parent with config.json", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-config-dir-"));
    tempDirs.push(tempDir);

    // Root has a proper .rundown with config.json
    const rootConfigDir = path.join(tempDir, CONFIG_DIR_NAME);
    fs.mkdirSync(rootConfigDir, { recursive: true });
    fs.writeFileSync(path.join(rootConfigDir, "config.json"), "{}");

    // Subdirectory has an artifact-only .rundown (no config.json)
    const subDir = path.join(tempDir, "sub");
    const subConfigDir = path.join(subDir, CONFIG_DIR_NAME);
    fs.mkdirSync(subConfigDir, { recursive: true });
    fs.mkdirSync(path.join(subConfigDir, "runs"), { recursive: true });

    const adapter = createConfigDirAdapter();
    const result = adapter.resolve(subDir);

    expect(result).toEqual({
      configDir: rootConfigDir,
      isExplicit: false,
    });
  });

  it("returns undefined when no .rundown exists anywhere and template loading falls back to built-in defaults", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-config-dir-"));
    tempDirs.push(tempDir);
    const deepDir = path.join(tempDir, "nested", "project");
    fs.mkdirSync(deepDir, { recursive: true });

    const adapter = createConfigDirAdapter();
    const result = adapter.resolve(deepDir);

    expect(result).toBeUndefined();

    const templates = loadProjectTemplates(result?.configDir);
    expect(templates.task).toBe(DEFAULT_TASK_TEMPLATE);
    expect(templates.discuss).toBe(DEFAULT_DISCUSS_TEMPLATE);
    expect(templates.verify).toBe(DEFAULT_VERIFY_TEMPLATE);
    expect(templates.repair).toBe(DEFAULT_REPAIR_TEMPLATE);
    expect(templates.plan).toBe(DEFAULT_PLAN_TEMPLATE);
    expect(templates.research).toBe(DEFAULT_RESEARCH_TEMPLATE);
    expect(templates.trace).toBe(DEFAULT_TRACE_TEMPLATE);
  });

  it("stops at filesystem root and does not loop", () => {
    const adapter = createConfigDirAdapter();
    const root = path.parse(process.cwd()).root;
    const startDir = path.join(root, "alpha", "beta");

    const expectedChecks: string[] = [];
    let currentDir = path.resolve(startDir);
    while (true) {
      expectedChecks.push(path.join(currentDir, CONFIG_DIR_NAME));
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }
      currentDir = parentDir;
    }

    let checkCount = 0;
    const existsSyncSpy = vi.spyOn(fs, "existsSync").mockImplementation(() => {
      checkCount += 1;
      if (checkCount > expectedChecks.length) {
        throw new Error("resolve exceeded expected directory checks");
      }
      return false;
    });

    const result = adapter.resolve(startDir);

    expect(result).toBeUndefined();
    expect(checkCount).toBe(expectedChecks.length);
    expect(existsSyncSpy.mock.calls.map(([checkedPath]) => checkedPath)).toEqual(expectedChecks);
  });
});
