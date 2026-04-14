import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkspaceRootForPathSensitiveCommand } from "../../src/application/workspace-selection.js";
import { createNodeFileSystem } from "../../src/infrastructure/adapters/fs-file-system.js";
import { WORKSPACE_LINK_SCHEMA_VERSION } from "../../src/domain/workspace-link.js";

describe("resolveWorkspaceRootForPathSensitiveCommand", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("returns selected effective workspace and execution context for --workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-workspace-selection-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked-invocation");
    const selectedWorkspace = path.join(root, "selected-workspace");
    const effectiveWorkspace = path.join(root, "effective-workspace");
    const alternateWorkspace = path.join(root, "alternate-workspace");

    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(path.join(selectedWorkspace, ".rundown"), { recursive: true });
    fs.mkdirSync(effectiveWorkspace, { recursive: true });
    fs.mkdirSync(alternateWorkspace, { recursive: true });

    fs.writeFileSync(
      path.join(invocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
        records: [
          { id: "selected", workspacePath: path.relative(invocationDir, selectedWorkspace).replace(/\\/g, "/") },
          { id: "alternate", workspacePath: path.relative(invocationDir, alternateWorkspace).replace(/\\/g, "/") },
        ],
      }),
      "utf-8",
    );

    fs.writeFileSync(
      path.join(selectedWorkspace, ".rundown", "workspace.link"),
      path.relative(selectedWorkspace, effectiveWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );

    const selection = resolveWorkspaceRootForPathSensitiveCommand({
      fileSystem: createNodeFileSystem(),
      invocationDir,
      workspaceOption: path.relative(invocationDir, selectedWorkspace),
    });

    expect(selection.ok).toBe(true);
    if (!selection.ok) {
      return;
    }

    expect(selection.workspaceRoot).toBe(path.resolve(effectiveWorkspace));
    expect(selection.executionContext).toEqual({
      invocationDir: path.resolve(invocationDir),
      workspaceDir: path.resolve(effectiveWorkspace),
      workspaceLinkPath: path.resolve(path.join(invocationDir, ".rundown", "workspace.link")),
      isLinkedWorkspace: true,
    });
  });
});
