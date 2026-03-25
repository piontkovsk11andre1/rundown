import { describe, expect, it, vi } from "vitest";
import { createManageArtifacts } from "../../src/application/manage-artifacts.js";
import type {
  ApplicationOutputEvent,
  ArtifactRunMetadata,
  ArtifactStore,
  DirectoryOpenerPort,
  WorkingDirectoryPort,
} from "../../src/domain/ports/index.js";

describe("manage-artifacts", () => {
  it("rejects incompatible clean options", () => {
    const { manageArtifacts, events, directoryOpener, artifactStore } = createDependencies();

    const code = manageArtifacts({ clean: true, json: true, failed: false, open: "" });

    expect(code).toBe(1);
    expect(directoryOpener.openDirectory).not.toHaveBeenCalled();
    expect(artifactStore.removeSaved).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "error",
      message: "--clean cannot be combined with --json or --open.",
    });
  });

  it("opens the latest saved run", () => {
    const run = createRun({ runId: "run-123", relativePath: ".rundown/runs/run-123" });
    const { manageArtifacts, events, directoryOpener, artifactStore } = createDependencies({ latest: run });

    const code = manageArtifacts({ clean: false, json: false, failed: false, open: "latest" });

    expect(code).toBe(0);
    expect(artifactStore.latest).toHaveBeenCalledWith("/workspace");
    expect(directoryOpener.openDirectory).toHaveBeenCalledWith(run.rootDir);
    expect(events).toContainEqual({
      kind: "success",
      message: "Opened runtime artifacts: .rundown/runs/run-123",
    });
  });

  it("returns 3 when opening a missing run id", () => {
    const { manageArtifacts, events, directoryOpener, artifactStore } = createDependencies();

    const code = manageArtifacts({ clean: false, json: false, failed: false, open: "missing-run" });

    expect(code).toBe(3);
    expect(artifactStore.find).toHaveBeenCalledWith("missing-run", "/workspace");
    expect(directoryOpener.openDirectory).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "error",
      message: "No saved runtime artifact run found for: missing-run",
    });
  });

  it("rejects open combined with json or failed filtering", () => {
    const { manageArtifacts, events, directoryOpener } = createDependencies();

    const code = manageArtifacts({ clean: false, json: false, failed: true, open: "run-123" });

    expect(code).toBe(1);
    expect(directoryOpener.openDirectory).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      kind: "error",
      message: "--open cannot be combined with --json or --failed.",
    });
  });

  it("opens a specific run id via find", () => {
    const run = createRun({ runId: "run-123", relativePath: ".rundown/runs/run-123" });
    const { manageArtifacts, events, directoryOpener, artifactStore } = createDependencies({ foundRun: run });

    const code = manageArtifacts({ clean: false, json: false, failed: false, open: "run-123" });

    expect(code).toBe(0);
    expect(artifactStore.find).toHaveBeenCalledWith("run-123", "/workspace");
    expect(directoryOpener.openDirectory).toHaveBeenCalledWith(run.rootDir);
    expect(events).toContainEqual({
      kind: "success",
      message: "Opened runtime artifacts: .rundown/runs/run-123",
    });
  });

  it("cleans failed runs and reports when nothing was removed", () => {
    const { manageArtifacts, events, artifactStore } = createDependencies();

    const code = manageArtifacts({ clean: true, json: false, failed: true, open: "" });

    expect(code).toBe(0);
    expect(artifactStore.removeFailed).toHaveBeenCalledWith("/workspace");
    expect(events).toContainEqual({
      kind: "info",
      message: "No failed runtime artifacts found.",
    });
  });

  it("cleans saved runs and reports the removed count", () => {
    const { manageArtifacts, events, artifactStore } = createDependencies({ removedSaved: 2 });

    const code = manageArtifacts({ clean: true, json: false, failed: false, open: "" });

    expect(code).toBe(0);
    expect(artifactStore.removeSaved).toHaveBeenCalledWith("/workspace");
    expect(events).toContainEqual({
      kind: "success",
      message: "Removed 2 runtime artifact runs.",
    });
  });

  it("prints saved runs as JSON", () => {
    const runs = [createRun({ runId: "run-json" })];
    const { manageArtifacts, events, artifactStore } = createDependencies({ savedRuns: runs });

    const code = manageArtifacts({ clean: false, json: true, failed: false, open: "" });

    expect(code).toBe(0);
    expect(artifactStore.listSaved).toHaveBeenCalledWith("/workspace");
    expect(events).toContainEqual({
      kind: "text",
      text: JSON.stringify(runs, null, 2),
    });
  });

  it("reports when no saved runs exist", () => {
    const { manageArtifacts, events, artifactStore } = createDependencies({ savedRuns: [] });

    const code = manageArtifacts({ clean: false, json: false, failed: false, open: "" });

    expect(code).toBe(0);
    expect(artifactStore.listSaved).toHaveBeenCalledWith("/workspace");
    expect(events).toContainEqual({
      kind: "info",
      message: "No saved runtime artifacts found.",
    });
  });

  it("prints a human-readable failed run summary", () => {
    const runs = [createRun({
      runId: "run-failed",
      relativePath: ".rundown/runs/run-failed",
      status: "verification-failed",
      commandName: "run",
      workerCommand: ["opencode", "run"],
      mode: "wait",
      transport: "file",
      task: {
        text: "Fix docs",
        file: "docs/tasks.md",
        line: 12,
        index: 3,
        source: "docs/tasks.md",
      },
    })];
    const { manageArtifacts, events, artifactStore } = createDependencies({ failedRuns: runs });

    const code = manageArtifacts({ clean: false, json: false, failed: true, open: "" });

    expect(code).toBe(0);
    expect(artifactStore.listFailed).toHaveBeenCalledWith("/workspace");
    expect(events).toEqual([
      {
        kind: "text",
        text: "run-failed [status=verification-failed] [command=run] [mode=wait] [transport=file] .rundown/runs/run-failed",
      },
      {
        kind: "text",
        text: "  task: Fix docs — docs/tasks.md:12",
      },
      {
        kind: "text",
        text: "  worker: opencode run",
      },
      {
        kind: "text",
        text: "  started: 2026-03-20T12:00:00.000Z",
      },
    ]);
  });

  it("prints default status, mode, transport, and worker when optional fields are missing", () => {
    const runs = [{
      runId: "run-defaults",
      rootDir: "/workspace/.rundown/runs/run-defaults",
      relativePath: ".rundown/runs/run-defaults",
      commandName: "plan",
      startedAt: "2026-03-20T12:00:00.000Z",
    }];
    const { manageArtifacts, events } = createDependencies({ savedRuns: runs });

    const code = manageArtifacts({ clean: false, json: false, failed: false, open: "" });

    expect(code).toBe(0);
    expect(events).toEqual([
      {
        kind: "text",
        text: "run-defaults [status=unknown] [command=plan] [mode=n/a] [transport=n/a] .rundown/runs/run-defaults",
      },
      {
        kind: "text",
        text: "  worker: plan",
      },
      {
        kind: "text",
        text: "  started: 2026-03-20T12:00:00.000Z",
      },
    ]);
  });
});

function createDependencies(overrides: {
  latest?: ArtifactRunMetadata | null;
  foundRun?: ArtifactRunMetadata | null;
  savedRuns?: ArtifactRunMetadata[];
  failedRuns?: ArtifactRunMetadata[];
  removedSaved?: number;
} = {}) {
  const events: ApplicationOutputEvent[] = [];
  const artifactStore: ArtifactStore = {
    createContext: vi.fn(),
    beginPhase: vi.fn(),
    completePhase: vi.fn(),
    finalize: vi.fn(),
    displayPath: vi.fn(),
    rootDir: vi.fn(() => "/workspace/.rundown/runs"),
    listSaved: vi.fn((cwd?: string) => {
      void cwd;
      return overrides.savedRuns ?? [];
    }),
    listFailed: vi.fn((cwd?: string) => {
      void cwd;
      return overrides.failedRuns ?? [];
    }),
    latest: vi.fn((cwd?: string) => {
      void cwd;
      return overrides.latest ?? null;
    }),
    find: vi.fn(() => overrides.foundRun ?? null),
    removeSaved: vi.fn(() => overrides.removedSaved ?? 1),
    removeFailed: vi.fn(() => 0),
    isFailedStatus: vi.fn(() => false),
  };
  const directoryOpener: DirectoryOpenerPort = {
    openDirectory: vi.fn(),
  };
  const workingDirectory: WorkingDirectoryPort = {
    cwd: vi.fn(() => "/workspace"),
  };

  const manageArtifacts = createManageArtifacts({
    artifactStore,
    directoryOpener,
    workingDirectory,
    output: {
      emit(event) {
        events.push(event);
      },
    },
  });

  return { manageArtifacts, events, artifactStore, directoryOpener, workingDirectory };
}

function createRun(overrides: Partial<ArtifactRunMetadata> = {}): ArtifactRunMetadata {
  return {
    runId: overrides.runId ?? "run-1",
    rootDir: overrides.rootDir ?? "/workspace/.rundown/runs/run-1",
    relativePath: overrides.relativePath ?? ".rundown/runs/run-1",
    commandName: overrides.commandName ?? "run",
    workerCommand: overrides.workerCommand,
    mode: overrides.mode,
    transport: overrides.transport,
    source: overrides.source ?? "tasks.md",
    keepArtifacts: overrides.keepArtifacts ?? true,
    completedAt: overrides.completedAt,
    task: overrides.task,
    startedAt: overrides.startedAt ?? "2026-03-20T12:00:00.000Z",
    status: overrides.status ?? "completed",
  };
}