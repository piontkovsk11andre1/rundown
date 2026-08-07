import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInvocationWorkspaceContext } from "../../src/presentation/invocation-workspace-context.js";

describe("resolveInvocationWorkspaceContext", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("returns linked workspace context when workspace.link resolves", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-invocation-workspace-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked");
    const workspaceDir = path.join(root, "source");
    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(invocationDir, ".rundown", "workspace.link"),
      path.relative(invocationDir, workspaceDir).replace(/\\/g, "/"),
      "utf-8",
    );

    const context = resolveInvocationWorkspaceContext(invocationDir);

    expect(context).toEqual({
      invocationDir: path.resolve(invocationDir),
      workspaceDir: path.resolve(workspaceDir),
      workspaceLinkPath: path.join(path.resolve(invocationDir), ".rundown", "workspace.link"),
      isLinkedWorkspace: true,
    });
  });

  it("normalizes linked workspace context paths to absolute values", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-invocation-workspace-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked", "nested", "..", "nested");
    const invocationDirResolved = path.join(root, "linked", "nested");
    const workspaceDir = path.join(root, "source", "real");
    fs.mkdirSync(path.join(invocationDirResolved, ".rundown"), { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(
      path.join(invocationDirResolved, ".rundown", "workspace.link"),
      "../../source/./real",
      "utf-8",
    );

    const context = resolveInvocationWorkspaceContext(invocationDir);

    expect(context).toEqual({
      invocationDir: path.resolve(invocationDir),
      workspaceDir: path.resolve(workspaceDir),
      workspaceLinkPath: path.resolve(invocationDir, ".rundown", "workspace.link"),
      isLinkedWorkspace: true,
    });
  });

  it("falls back to invocation dir for invalid or absent links", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-invocation-workspace-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "plain");
    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(invocationDir, ".rundown", "workspace.link"), "../missing", "utf-8");

    const context = resolveInvocationWorkspaceContext(invocationDir);

    expect(context).toEqual({
      invocationDir: path.resolve(invocationDir),
      workspaceDir: path.resolve(invocationDir),
      workspaceLinkPath: "",
      isLinkedWorkspace: false,
    });
  });

  it("falls back to invocation dir when workspace.link target is empty", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-invocation-workspace-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked");
    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(invocationDir, ".rundown", "workspace.link"), "   \n", "utf-8");

    const context = resolveInvocationWorkspaceContext(invocationDir);

    expect(context).toEqual({
      invocationDir: path.resolve(invocationDir),
      workspaceDir: path.resolve(invocationDir),
      workspaceLinkPath: "",
      isLinkedWorkspace: false,
    });
  });

  it("falls back to invocation dir when workspace.link target is absolute", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-invocation-workspace-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked");
    const absoluteTarget = path.join(root, "source-workspace");
    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(invocationDir, ".rundown", "workspace.link"), absoluteTarget, "utf-8");

    const context = resolveInvocationWorkspaceContext(invocationDir);

    expect(context).toEqual({
      invocationDir: path.resolve(invocationDir),
      workspaceDir: path.resolve(invocationDir),
      workspaceLinkPath: "",
      isLinkedWorkspace: false,
    });
  });

  it("falls back to invocation dir when workspace.link points to a stale file target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-invocation-workspace-"));
    tempDirs.push(root);

    const invocationDir = path.join(root, "linked");
    const staleWorkspaceFile = path.join(root, "stale-workspace.txt");
    fs.mkdirSync(path.join(invocationDir, ".rundown"), { recursive: true });
    fs.writeFileSync(staleWorkspaceFile, "stale", "utf-8");
    fs.writeFileSync(
      path.join(invocationDir, ".rundown", "workspace.link"),
      path.relative(invocationDir, staleWorkspaceFile).replace(/\\/g, "/"),
      "utf-8",
    );

    const context = resolveInvocationWorkspaceContext(invocationDir);

    expect(context).toEqual({
      invocationDir: path.resolve(invocationDir),
      workspaceDir: path.resolve(invocationDir),
      workspaceLinkPath: "",
      isLinkedWorkspace: false,
    });
  });
});
