import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createRuntimeArtifactsContext,
  finalizeRuntimeArtifacts,
} from "./runtime-artifacts.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeTempWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "md-todo-runtime-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

describe("runtime artifacts finalization", () => {
  it("does not throw when run directory is missing and preserve is false", () => {
    const cwd = makeTempWorkspace();
    const context = createRuntimeArtifactsContext({
      cwd,
      commandName: "run",
      workerCommand: ["opencode", "run"],
      mode: "wait",
      transport: "file",
      keepArtifacts: false,
    });

    fs.rmSync(context.rootDir, { recursive: true, force: true });

    expect(() => {
      finalizeRuntimeArtifacts(context, {
        status: "completed",
        preserve: false,
      });
    }).not.toThrow();
  });

  it("recreates missing run directory and writes run.json when preserve is true", () => {
    const cwd = makeTempWorkspace();
    const context = createRuntimeArtifactsContext({
      cwd,
      commandName: "run",
      workerCommand: ["opencode", "run"],
      mode: "wait",
      transport: "file",
      keepArtifacts: false,
    });

    fs.rmSync(context.rootDir, { recursive: true, force: true });

    expect(() => {
      finalizeRuntimeArtifacts(context, {
        status: "failed",
        preserve: true,
      });
    }).not.toThrow();

    const metadataFile = path.join(context.rootDir, "run.json");
    expect(fs.existsSync(metadataFile)).toBe(true);

    const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf-8")) as { status?: string };
    expect(metadata.status).toBe("failed");
  });
});