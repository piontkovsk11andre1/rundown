import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveWorkspaceRootForPathSensitiveCommand,
  selectWorkspaceRecordByOption,
} from "../../src/application/workspace-selection.js";
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

  it("selects workspace record by exact record id before path matching", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-workspace-selection-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked-invocation");
    const workspaceById = path.join(root, "workspace-by-id");
    const workspaceByPath = path.join(invocationDir, "alpha");

    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(workspaceById, { recursive: true });
    fs.mkdirSync(workspaceByPath, { recursive: true });

    fs.writeFileSync(
      path.join(invocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
        records: [
          { id: "alpha", workspacePath: path.relative(invocationDir, workspaceById).replace(/\\/g, "/") },
          { id: "by-path", workspacePath: "alpha" },
        ],
      }),
      "utf-8",
    );

    const selection = selectWorkspaceRecordByOption({
      fileSystem: createNodeFileSystem(),
      invocationDir,
      workspaceOption: "alpha",
    });

    expect(selection.ok).toBe(true);
    if (!selection.ok) {
      return;
    }

    expect(selection.selectedRecord.id).toBe("alpha");
    expect(selection.selectedRecord.workspaceDir).toBe(path.resolve(workspaceById));
  });

  it("selects workspace record by path when id does not match", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-workspace-selection-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked-invocation");
    const workspaceByPath = path.join(root, "workspace-by-path");

    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(workspaceByPath, { recursive: true });

    fs.writeFileSync(
      path.join(invocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
        records: [
          { id: "source", workspacePath: path.relative(invocationDir, workspaceByPath).replace(/\\/g, "/") },
        ],
      }),
      "utf-8",
    );

    const selection = selectWorkspaceRecordByOption({
      fileSystem: createNodeFileSystem(),
      invocationDir,
      workspaceOption: path.relative(invocationDir, workspaceByPath),
    });

    expect(selection.ok).toBe(true);
    if (!selection.ok) {
      return;
    }

    expect(selection.selectedRecord.id).toBe("source");
    expect(selection.selectedRecord.workspaceDir).toBe(path.resolve(workspaceByPath));
  });

  it("returns candidate guidance when selector does not match any record id or path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-workspace-selection-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked-invocation");
    const workspaceA = path.join(root, "workspace-a");
    const workspaceB = path.join(root, "workspace-b");

    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });

    fs.writeFileSync(
      path.join(invocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
        records: [
          { id: "alpha", workspacePath: path.relative(invocationDir, workspaceA).replace(/\\/g, "/") },
          { id: "beta", workspacePath: path.relative(invocationDir, workspaceB).replace(/\\/g, "/") },
        ],
      }),
      "utf-8",
    );

    const selection = selectWorkspaceRecordByOption({
      fileSystem: createNodeFileSystem(),
      invocationDir,
      workspaceOption: "missing-workspace",
    });

    expect(selection.ok).toBe(false);
    if (selection.ok) {
      return;
    }

    expect(selection.message).toContain("No workspace record matches selector");
    expect(selection.message).toContain("Selection is deterministic: record id is matched first, then workspace path.");
    expect(selection.message).toContain("alpha:");
    expect(selection.message).toContain("beta:");
  });

  it("resolves legacy single-record workspace.link content without explicit --workspace", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-workspace-selection-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked-invocation");
    const sourceWorkspace = path.join(root, "source-workspace");
    const effectiveWorkspace = path.join(root, "effective-workspace");

    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(path.join(sourceWorkspace, ".rundown"), { recursive: true });
    fs.mkdirSync(effectiveWorkspace, { recursive: true });

    fs.writeFileSync(
      path.join(invocationDir, ".rundown", "workspace.link"),
      path.relative(invocationDir, sourceWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sourceWorkspace, ".rundown", "workspace.link"),
      path.relative(sourceWorkspace, effectiveWorkspace).replace(/\\/g, "/"),
      "utf-8",
    );

    const selection = resolveWorkspaceRootForPathSensitiveCommand({
      fileSystem: createNodeFileSystem(),
      invocationDir,
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

  it("lists candidate workspaces and actionable guidance when selection is ambiguous", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-workspace-selection-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked-invocation");
    const workspaceA = path.join(root, "workspace-a");
    const workspaceB = path.join(root, "workspace-b");

    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(workspaceA, { recursive: true });
    fs.mkdirSync(workspaceB, { recursive: true });

    fs.writeFileSync(
      path.join(invocationDir, ".rundown", "workspace.link"),
      JSON.stringify({
        schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
        records: [
          { id: "alpha", workspacePath: path.relative(invocationDir, workspaceA).replace(/\\/g, "/") },
          { id: "beta", workspacePath: path.relative(invocationDir, workspaceB).replace(/\\/g, "/") },
        ],
      }),
      "utf-8",
    );

    const selection = resolveWorkspaceRootForPathSensitiveCommand({
      fileSystem: createNodeFileSystem(),
      invocationDir,
    });

    expect(selection.ok).toBe(false);
    if (selection.ok) {
      return;
    }

    expect(selection.message).toContain("Workspace selection is ambiguous");
    expect(selection.message).toContain("Candidates:");
    expect(selection.message).toContain("alpha:");
    expect(selection.message).toContain("beta:");
    expect(selection.message).toContain("use --workspace ../workspace-a");
    expect(selection.message).toContain("use --workspace ../workspace-b");
    expect(selection.message).toContain("Re-run the command with --workspace <dir>");
  });
});
