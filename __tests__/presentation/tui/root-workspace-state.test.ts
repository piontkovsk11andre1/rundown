import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRootWorkspaceState } from "../../../src/presentation/tui/root-workspace-state.ts";

function createTempWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(rootDir: string, relativePath: string, content: string): void {
  const absolutePath = path.join(rootDir, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

describe("detectRootWorkspaceState", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("treats an empty directory as bootstrap", () => {
    const rootDir = createTempWorkspace("rundown-root-workspace-state-");
    tempDirs.push(rootDir);

    expect(detectRootWorkspaceState(rootDir)).toEqual({
      isEmptyBootstrap: true,
      hasWorkersConfigured: false,
    });
  });

  it("treats a non-initialized directory as bootstrap", () => {
    const rootDir = createTempWorkspace("rundown-root-workspace-state-");
    tempDirs.push(rootDir);
    writeFile(rootDir, "README.md", "hello\n");

    expect(detectRootWorkspaceState(rootDir)).toEqual({
      isEmptyBootstrap: true,
      hasWorkersConfigured: false,
    });
  });

  it("recognizes initialized default workspace directories", () => {
    const rootDir = createTempWorkspace("rundown-root-workspace-state-");
    tempDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, "design"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "implementation"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "specs"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "migrations"), { recursive: true });
    writeFile(rootDir, ".rundown/config.json", JSON.stringify({ workspace: {} }, null, 2));

    expect(detectRootWorkspaceState(rootDir)).toEqual({
      isEmptyBootstrap: false,
      hasWorkersConfigured: false,
    });
  });

  it("honors configured custom workspace directory names", () => {
    const rootDir = createTempWorkspace("rundown-root-workspace-state-");
    tempDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "source"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "acceptance"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "tasks"), { recursive: true });
    writeFile(rootDir, ".rundown/config.json", JSON.stringify({
      workspace: {
        directories: {
          design: "docs",
          implementation: "source",
          specs: "acceptance",
          migrations: "tasks",
        },
      },
    }, null, 2));

    expect(detectRootWorkspaceState(rootDir)).toEqual({
      isEmptyBootstrap: false,
      hasWorkersConfigured: false,
    });
  });

  it("exposes worker configuration status from local config", () => {
    const rootDir = createTempWorkspace("rundown-root-workspace-state-");
    tempDirs.push(rootDir);

    fs.mkdirSync(path.join(rootDir, "design"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "implementation"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "specs"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "migrations"), { recursive: true });
    writeFile(rootDir, ".rundown/config.json", JSON.stringify({
      workspace: {},
      workers: {
        default: ["mock-worker"],
      },
    }, null, 2));

    expect(detectRootWorkspaceState(rootDir)).toEqual({
      isEmptyBootstrap: false,
      hasWorkersConfigured: true,
    });
  });
});
