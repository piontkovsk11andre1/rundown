import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  createWorkspaceRemoveTask,
  createWorkspaceUnlinkTask,
  type WorkspaceRemoveOptions,
  type WorkspaceUnlinkOptions,
} from "../../src/application/workspace-lifecycle.js";
import type {
  ApplicationOutputEvent,
  FileSystem,
  InteractiveInputPort,
  PathOperationsPort,
  WorkingDirectoryPort,
} from "../../src/domain/ports/index.js";
import { WORKSPACE_LINK_SCHEMA_VERSION } from "../../src/domain/workspace-link.js";

describe("workspace-lifecycle unlink", () => {
  it("returns no-work when workspace.link is missing", async () => {
    const invocationDir = path.resolve("/repo/project");
    const { unlinkTask } = createHarness(invocationDir);

    const code = await unlinkTask({ all: false, dryRun: false });

    expect(code).toBe(3);
  });

  it("fails safely with candidate guidance when multi-record selection is ambiguous", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { unlinkTask, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "alpha", workspacePath: "../workspace-a" },
            { id: "beta", workspacePath: "../workspace-b" },
          ],
        }),
      },
    });

    const code = await unlinkTask({ all: false, dryRun: false });

    expect(code).toBe(1);
    const errorEvent = events.find((event) => event.kind === "error");
    expect(errorEvent?.kind).toBe("error");
    if (errorEvent?.kind === "error") {
      expect(errorEvent.message).toContain("ambiguous");
      expect(errorEvent.message).toContain("Candidates:");
      expect(errorEvent.message).toContain("alpha");
      expect(errorEvent.message).toContain("beta");
    }
  });

  it("includes stale/orphan guidance in ambiguous selection output", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const healthyWorkspace = path.resolve(invocationDir, "../workspace-a");
    const { unlinkTask, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "alpha", workspacePath: "../workspace-a" },
            { id: "beta", workspacePath: "../workspace-missing" },
          ],
        }),
      },
      directories: [healthyWorkspace],
    });

    const code = await unlinkTask({ all: false, dryRun: false });

    expect(code).toBe(1);
    const errorEvent = events.find((event) => event.kind === "error");
    expect(errorEvent?.kind).toBe("error");
    if (errorEvent?.kind === "error") {
      expect(errorEvent.message).toContain("stale/orphan workspace record");
      expect(errorEvent.message).toContain("workspace unlink/remove");
    }
  });

  it("supports dry-run unlink without mutating workspace.link", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { unlinkTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../source-workspace\n",
      },
    });

    const code = await unlinkTask({ all: false, dryRun: true });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.rm)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "info" && event.message.includes("Dry run"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("Dry-run metadata impact"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("workspace.link: remove"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("File/directory deletions: none"))).toBe(true);
  });

  it("unlinks selected record and preserves remaining records", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { unlinkTask, fileSystem } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "alpha", workspacePath: "../workspace-a", default: true },
            { id: "beta", workspacePath: "../workspace-b" },
          ],
        }),
      },
    });

    const code = await unlinkTask({ workspace: "alpha", all: false, dryRun: false });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    const serialized = vi.mocked(fileSystem.writeText).mock.calls[0]?.[1] ?? "";
    expect(serialized).toContain('"id": "beta"');
    expect(serialized).not.toContain('"id": "alpha"');
    expect(vi.mocked(fileSystem.rm)).not.toHaveBeenCalled();
  });

  it("removes workspace.link when last record is unlinked", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { unlinkTask, fileSystem } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../source-workspace\n",
      },
    });

    const code = await unlinkTask({ all: false, dryRun: false });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.rm)).toHaveBeenCalledWith(workspaceLinkPath, { force: true });
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
  });

  it("fails with clear permission error when removing workspace.link metadata fails", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { unlinkTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../source-workspace\n",
      },
    });

    vi.mocked(fileSystem.rm).mockImplementation(() => {
      const error = new Error("operation not permitted");
      (error as Error & { code?: string }).code = "EPERM";
      throw error;
    });

    const code = await unlinkTask({ all: false, dryRun: false });

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("permission denied"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes(workspaceLinkPath))).toBe(true);
  });

  it("fails with clear missing-path error when rewriting workspace.link during unlink fails", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { unlinkTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "alpha", workspacePath: "../workspace-a", default: true },
            { id: "beta", workspacePath: "../workspace-b" },
          ],
        }),
      },
    });

    vi.mocked(fileSystem.writeText).mockImplementation(() => {
      const error = new Error("ENOENT: no such file or directory");
      (error as Error & { code?: string }).code = "ENOENT";
      throw error;
    });

    const code = await unlinkTask({ workspace: "alpha", all: false, dryRun: false });

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("path does not exist"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes(workspaceLinkPath))).toBe(true);
  });

  it("cleans stale workspace metadata and warns when selected target is missing", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { unlinkTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "stale", workspacePath: "../workspace-missing", default: true },
            { id: "active", workspacePath: "../workspace-b" },
          ],
        }),
      },
      directories: [path.resolve(invocationDir, "../workspace-b")],
    });

    const code = await unlinkTask({ workspace: "stale", all: false, dryRun: false });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    const serialized = vi.mocked(fileSystem.writeText).mock.calls[0]?.[1] ?? "";
    expect(serialized).toContain('"id": "active"');
    expect(serialized).not.toContain('"id": "stale"');
    expect(events.some((event) => event.kind === "warn" && event.message.includes("stale/orphan workspace record"))).toBe(true);
  });
});

describe("workspace-lifecycle remove", () => {
  it("returns no-work when workspace.link is missing", async () => {
    const invocationDir = path.resolve("/repo/project");
    const { removeTask } = createHarness(invocationDir);

    const code = await removeTask({ all: false, deleteFiles: false, dryRun: false, force: false });

    expect(code).toBe(3);
  });

  it("fails when --workspace and --all are combined", async () => {
    const invocationDir = path.resolve("/repo/project");
    const { removeTask } = createHarness(invocationDir);

    const code = await removeTask({ workspace: "alpha", all: true, deleteFiles: false, dryRun: false, force: false });

    expect(code).toBe(1);
  });

  it("removes single-record legacy workspace.link metadata without requiring --workspace", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const workspaceTarget = path.resolve(invocationDir, "../workspace-a");
    const { removeTask, fileSystem, interactiveInput } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [workspaceTarget],
    });

    const code = await removeTask({ all: false, deleteFiles: false, dryRun: false, force: false });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.rm)).toHaveBeenCalledWith(workspaceLinkPath, { force: true });
    expect(vi.mocked(fileSystem.rm).mock.calls.some((call) => call[0] === workspaceTarget)).toBe(false);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(interactiveInput.prompt)).not.toHaveBeenCalled();
  });

  it("fails safely with candidate guidance when multi-record selection is ambiguous", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { removeTask, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "alpha", workspacePath: "../workspace-a" },
            { id: "beta", workspacePath: "../workspace-b" },
          ],
        }),
      },
    });

    const code = await removeTask({ all: false, deleteFiles: false, dryRun: false, force: false });

    expect(code).toBe(1);
    const errorEvent = events.find((event) => event.kind === "error");
    expect(errorEvent?.kind).toBe("error");
    if (errorEvent?.kind === "error") {
      expect(errorEvent.message).toContain("ambiguous");
      expect(errorEvent.message).toContain("Candidates:");
      expect(errorEvent.message).toContain("alpha");
      expect(errorEvent.message).toContain("beta");
      expect(errorEvent.message).toContain("--workspace <dir|id>");
    }
  });

  it("supports metadata-only remove without deleting workspace targets", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const workspaceTarget = path.resolve(invocationDir, "../workspace-a");
    const { removeTask, fileSystem } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "alpha", workspacePath: "../workspace-a", default: true },
            { id: "beta", workspacePath: "../workspace-b" },
          ],
        }),
      },
      directories: [workspaceTarget],
    });

    const code = await removeTask({ workspace: "alpha", all: false, deleteFiles: false, dryRun: false, force: false });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fileSystem.rm).mock.calls.some((call) => call[0] === workspaceTarget)).toBe(false);
  });

  it("supports dry-run remove with delete-files without mutating metadata or files", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { removeTask, fileSystem, interactiveInput, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [path.resolve(invocationDir, "../workspace-a")],
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: true, force: false });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.rm)).not.toHaveBeenCalled();
    expect(vi.mocked(interactiveInput.prompt)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "text" && event.text.includes("Dry-run impact preview"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("workspace.link: remove"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("(directory)"))).toBe(true);
  });

  it("requires --force when delete-files is requested without interactive confirmation support", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const workspaceTarget = path.resolve(invocationDir, "../workspace-a");
    const { removeTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [workspaceTarget],
      includeInteractiveInput: false,
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: false, force: false });

    expect(code).toBe(1);
    expect(vi.mocked(fileSystem.rm)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "error" && event.message.includes("Re-run with --force"))).toBe(true);
  });

  it("supports dry-run remove in metadata-only mode with explicit file impact listing", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { removeTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [path.resolve(invocationDir, "../workspace-a")],
    });

    const code = await removeTask({ all: false, deleteFiles: false, dryRun: true, force: false });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.rm)).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind === "text" && event.text.includes("Dry-run impact preview"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes("File/directory deletions: none"))).toBe(true);
  });

  it("requires confirmation before destructive cleanup when --force is not set", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const workspaceTarget = path.resolve(invocationDir, "../workspace-a");
    const { removeTask, fileSystem, interactiveInput } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [workspaceTarget],
    });
    vi.mocked(interactiveInput.prompt).mockResolvedValueOnce({
      value: "false",
      usedDefault: false,
      interactive: true,
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: false, force: false });

    expect(code).toBe(3);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fileSystem.rm)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
  });

  it("deletes selected workspace targets after confirmation", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const workspaceTarget = path.resolve(invocationDir, "../workspace-a");
    const { removeTask, fileSystem, interactiveInput } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [workspaceTarget],
    });
    vi.mocked(interactiveInput.prompt).mockResolvedValueOnce({
      value: "true",
      usedDefault: false,
      interactive: true,
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: false, force: false });

    expect(code).toBe(0);
    expect(vi.mocked(interactiveInput.prompt)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fileSystem.rm)).toHaveBeenCalledWith(workspaceTarget, { recursive: true, force: true });
    expect(vi.mocked(fileSystem.rm)).toHaveBeenCalledWith(workspaceLinkPath, { force: true });
  });

  it("warns clearly when cleanup targets are missing and still removes metadata", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const missingTarget = path.resolve(invocationDir, "../workspace-missing");
    const { removeTask, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-missing\n",
      },
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: false, force: true });

    expect(code).toBe(0);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("path is missing"))).toBe(true);
    expect(events.some((event) => event.kind === "warn" && event.message.includes("Skipped 1 workspace cleanup target"))).toBe(true);
    expect(events.some((event) => event.kind === "success" && event.message.includes("removed empty workspace.link"))).toBe(true);
    expect(events.some((event) => event.kind === "text" && event.text.includes(missingTarget))).toBe(true);
  });

  it("fails with permission-denied error and preserves metadata when cleanup fails", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const lockedTarget = path.resolve(invocationDir, "../workspace-a");
    const { removeTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [lockedTarget],
    });

    vi.mocked(fileSystem.rm).mockImplementation((targetPath: string) => {
      if (path.resolve(targetPath) === lockedTarget) {
        const error = new Error("permission denied");
        (error as Error & { code?: string }).code = "EACCES";
        throw error;
      }
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: false, force: true });

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("permission denied"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Workspace cleanup completed partially"))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("metadata was preserved"))).toBe(true);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.rm).mock.calls.some((call) => call[0] === workspaceLinkPath)).toBe(false);
  });

  it("reports partial cleanup outcomes when one target fails and another succeeds", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const successTarget = path.resolve(invocationDir, "../workspace-a");
    const failingTarget = path.resolve(invocationDir, "../workspace-b");
    const { removeTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "alpha", workspacePath: "../workspace-a" },
            { id: "beta", workspacePath: "../workspace-b" },
          ],
        }),
      },
      directories: [successTarget, failingTarget],
    });

    vi.mocked(fileSystem.rm).mockImplementation((targetPath: string) => {
      if (path.resolve(targetPath) === failingTarget) {
        const error = new Error("operation not permitted");
        (error as Error & { code?: string }).code = "EPERM";
        throw error;
      }
    });

    const code = await removeTask({ all: true, deleteFiles: true, dryRun: false, force: true });

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("Workspace cleanup completed partially"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes("deleted 1, missing 0, failed 1"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes(failingTarget))).toBe(true);
    expect(events.some((event) => event.kind === "info" && event.message.includes("metadata was preserved"))).toBe(true);
    expect(vi.mocked(fileSystem.writeText)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.rm).mock.calls.some((call) => call[0] === workspaceLinkPath)).toBe(false);
  });

  it("skips confirmation when --force is set", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const workspaceTarget = path.resolve(invocationDir, "../workspace-a");
    const { removeTask, fileSystem, interactiveInput } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [workspaceTarget],
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: false, force: true });

    expect(code).toBe(0);
    expect(vi.mocked(interactiveInput.prompt)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.rm)).toHaveBeenCalledWith(workspaceTarget, { recursive: true, force: true });
  });

  it("allows forced delete-files cleanup even without interactive confirmation support", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const workspaceTarget = path.resolve(invocationDir, "../workspace-a");
    const { removeTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../workspace-a\n",
      },
      directories: [workspaceTarget],
      includeInteractiveInput: false,
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: false, force: true });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.rm)).toHaveBeenCalledWith(workspaceTarget, { recursive: true, force: true });
    expect(vi.mocked(fileSystem.rm)).toHaveBeenCalledWith(workspaceLinkPath, { force: true });
    expect(events.some((event) => event.kind === "success" && event.message.includes("removed empty workspace.link"))).toBe(true);
  });

  it("fails with clear missing-path message when rewriting workspace.link fails", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { removeTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "alpha", workspacePath: "../workspace-a", default: true },
            { id: "beta", workspacePath: "../workspace-b" },
          ],
        }),
      },
    });

    vi.mocked(fileSystem.writeText).mockImplementation(() => {
      const error = new Error("ENOENT: no such file or directory");
      (error as Error & { code?: string }).code = "ENOENT";
      throw error;
    });

    const code = await removeTask({ workspace: "alpha", all: false, deleteFiles: false, dryRun: false, force: false });

    expect(code).toBe(1);
    expect(events.some((event) => event.kind === "error" && event.message.includes("path does not exist"))).toBe(true);
    expect(events.some((event) => event.kind === "error" && event.message.includes(workspaceLinkPath))).toBe(true);
  });

  it("blocks destructive cleanup when a selected target resolves to filesystem root", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { removeTask, fileSystem, events, interactiveInput } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: "../../..\n",
      },
      directories: [path.parse(invocationDir).root],
    });

    const code = await removeTask({ all: false, deleteFiles: true, dryRun: false, force: true });

    expect(code).toBe(1);
    expect(vi.mocked(interactiveInput.prompt)).not.toHaveBeenCalled();
    expect(vi.mocked(fileSystem.rm)).not.toHaveBeenCalled();
    const errorEvent = events.find((event) => event.kind === "error");
    expect(errorEvent?.kind).toBe("error");
    if (errorEvent?.kind === "error") {
      expect(errorEvent.message).toContain("Refusing to delete filesystem root paths");
    }
  });

  it("warns about stale/orphan records and removes metadata when delete-files is not set", async () => {
    const invocationDir = path.resolve("/repo/project");
    const workspaceLinkPath = path.join(invocationDir, ".rundown", "workspace.link");
    const { removeTask, fileSystem, events } = createHarness(invocationDir, {
      files: {
        [workspaceLinkPath]: JSON.stringify({
          schemaVersion: WORKSPACE_LINK_SCHEMA_VERSION,
          records: [
            { id: "stale", workspacePath: "../workspace-missing", default: true },
            { id: "active", workspacePath: "../workspace-b" },
          ],
        }),
      },
      directories: [path.resolve(invocationDir, "../workspace-b")],
    });

    const code = await removeTask({ workspace: "stale", all: false, deleteFiles: false, dryRun: false, force: false });

    expect(code).toBe(0);
    expect(vi.mocked(fileSystem.writeText)).toHaveBeenCalledTimes(1);
    const serialized = vi.mocked(fileSystem.writeText).mock.calls[0]?.[1] ?? "";
    expect(serialized).toContain('"id": "active"');
    expect(serialized).not.toContain('"id": "stale"');
    expect(events.some((event) => event.kind === "warn" && event.message.includes("stale/orphan workspace record"))).toBe(true);
  });
});

function createHarness(
  invocationDir: string,
  initialState: {
    files?: Record<string, string>;
    directories?: string[];
    includeInteractiveInput?: boolean;
  } = {},
): {
  unlinkTask: (options: WorkspaceUnlinkOptions) => Promise<number>;
  removeTask: (options: WorkspaceRemoveOptions) => Promise<number>;
  fileSystem: FileSystem;
  interactiveInput: InteractiveInputPort;
  events: ApplicationOutputEvent[];
} {
  const events: ApplicationOutputEvent[] = [];
  const files = new Map<string, string>(Object.entries(initialState.files ?? {}).map(([filePath, content]) => [
    path.resolve(filePath),
    content,
  ]));
  const directories = new Set<string>((initialState.directories ?? []).map((dirPath) => path.resolve(dirPath)));

  directories.add(path.resolve(invocationDir));
  directories.add(path.resolve(invocationDir, ".rundown"));

  const fileSystem: FileSystem = {
    exists: vi.fn((filePath: string) => {
      const normalizedPath = path.resolve(filePath);
      return files.has(normalizedPath) || directories.has(normalizedPath);
    }),
    readText: vi.fn((filePath: string) => {
      const content = files.get(path.resolve(filePath));
      if (content === undefined) {
        throw new Error("ENOENT: " + filePath);
      }
      return content;
    }),
    writeText: vi.fn((filePath: string, content: string) => {
      const normalizedPath = path.resolve(filePath);
      files.set(normalizedPath, content);
      directories.add(path.dirname(normalizedPath));
    }),
    mkdir: vi.fn((dirPath: string) => {
      directories.add(path.resolve(dirPath));
    }),
    readdir: vi.fn(() => []),
    stat: vi.fn((filePath: string) => {
      const normalizedPath = path.resolve(filePath);
      if (files.has(normalizedPath)) {
        return {
          isFile: true,
          isDirectory: false,
        };
      }
      if (directories.has(normalizedPath)) {
        return {
          isFile: false,
          isDirectory: true,
        };
      }
      return null;
    }),
    unlink: vi.fn((filePath: string) => {
      files.delete(path.resolve(filePath));
    }),
    rm: vi.fn((filePath: string) => {
      const normalizedPath = path.resolve(filePath);
      files.delete(normalizedPath);
      directories.delete(normalizedPath);
      for (const existingFilePath of Array.from(files.keys())) {
        if (existingFilePath.startsWith(normalizedPath + path.sep)) {
          files.delete(existingFilePath);
        }
      }
      for (const existingDirPath of Array.from(directories)) {
        if (existingDirPath.startsWith(normalizedPath + path.sep)) {
          directories.delete(existingDirPath);
        }
      }
    }),
  };

  const interactiveInput: InteractiveInputPort = {
    isTTY: vi.fn(() => true),
    prepareForPrompt: vi.fn(),
    prompt: vi.fn(async () => ({
      value: "false",
      usedDefault: false,
      interactive: true,
    })),
  };

  const pathOperations: PathOperationsPort = {
    join: (...parts) => path.join(...parts),
    resolve: (...parts) => path.resolve(...parts),
    dirname: (filePath) => path.dirname(filePath),
    relative: (from, to) => path.relative(from, to),
    isAbsolute: (filePath) => path.isAbsolute(filePath),
  };

  const workingDirectory: WorkingDirectoryPort = {
    cwd: () => invocationDir,
  };

  const dependencies = {
    output: {
      emit: (event: ApplicationOutputEvent) => {
        events.push(event);
      },
    },
    fileSystem,
    interactiveInput: initialState.includeInteractiveInput === false ? undefined : interactiveInput,
    pathOperations,
    workingDirectory,
  };

  return {
    unlinkTask: createWorkspaceUnlinkTask(dependencies),
    removeTask: createWorkspaceRemoveTask(dependencies),
    fileSystem,
    interactiveInput,
    events,
  };
}
