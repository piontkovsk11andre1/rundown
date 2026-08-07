import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as tuiModule from "../../../src/presentation/tui/index.ts";
import {
  DEFAULT_WORKSPACE_DIRECTORIES,
  DEFAULT_WORKSPACE_PLACEMENT,
} from "../../../src/application/workspace-paths.ts";

describe("tui index module", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const tempDir = tempDirs.pop();
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("exports runRootTui entry function", () => {
    expect(tuiModule).toHaveProperty("runRootTui");
    expect(typeof tuiModule.runRootTui).toBe("function");
  });

  it("creates scene router state with empty-bootstrap menu in an empty cwd", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-tui-index-"));
    tempDirs.push(cwd);

    const state = tuiModule.createSceneRouterState({ currentWorkingDirectory: cwd });

    expect(state.mainMenuState.variant).toBe("emptyBootstrap");
    expect(state.rootWorkspaceState).toEqual({
      isEmptyBootstrap: true,
      hasWorkersConfigured: false,
    });
  });

  it("keeps initialized menu variant for initialized workspaces", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-tui-index-"));
    tempDirs.push(cwd);

    fs.mkdirSync(path.join(cwd, "design"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "migrations"), { recursive: true });
    fs.mkdirSync(path.join(cwd, ".rundown"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".rundown", "config.json"), JSON.stringify({ workspace: {} }, null, 2));

    const state = tuiModule.createSceneRouterState({ currentWorkingDirectory: cwd });

    expect(state.mainMenuState.variant).toBe("initialized");
    expect(state.rootWorkspaceState.isEmptyBootstrap).toBe(false);
  });

  it("runs Start action, refreshes workspace state, and switches to initialized menu", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-tui-index-"));
    tempDirs.push(cwd);

    const state = tuiModule.createSceneRouterState({ currentWorkingDirectory: cwd });
    const refreshStatuses = vi.fn(async () => {});
    const app = {
      startProject: vi.fn(async () => {
        fs.mkdirSync(path.join(cwd, "design"), { recursive: true });
        fs.mkdirSync(path.join(cwd, "specs"), { recursive: true });
        fs.mkdirSync(path.join(cwd, "migrations"), { recursive: true });
        fs.mkdirSync(path.join(cwd, ".rundown"), { recursive: true });
        fs.writeFileSync(path.join(cwd, ".rundown", "config.json"), JSON.stringify({ workspace: {} }, null, 2));
        return 0;
      }),
    };

    await tuiModule.runMainMenuStartAction({
      state,
      app,
      currentWorkingDirectory: cwd,
      refreshStatuses,
    });

    expect(app.startProject).toHaveBeenCalledWith({
      designDir: DEFAULT_WORKSPACE_DIRECTORIES.design,
      specsDir: DEFAULT_WORKSPACE_DIRECTORIES.specs,
      migrationsDir: DEFAULT_WORKSPACE_DIRECTORIES.migrations,
      designPlacement: DEFAULT_WORKSPACE_PLACEMENT.design,
      specsPlacement: DEFAULT_WORKSPACE_PLACEMENT.specs,
      migrationsPlacement: DEFAULT_WORKSPACE_PLACEMENT.migrations,
    });
    expect(state.mainMenuState.variant).toBe("initialized");
    expect(state.rootWorkspaceState.isEmptyBootstrap).toBe(false);
    expect(state.mainMenuHint).toBe("Workspace initialized.");
    expect(refreshStatuses).toHaveBeenCalledTimes(1);
  });

  it("surfaces Start failures in main-menu hint and keeps bootstrap variant", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-tui-index-"));
    tempDirs.push(cwd);

    const state = tuiModule.createSceneRouterState({ currentWorkingDirectory: cwd });
    const refreshStatuses = vi.fn(async () => {});
    const app = {
      startProject: vi.fn(async () => 2),
    };

    await tuiModule.runMainMenuStartAction({
      state,
      app,
      currentWorkingDirectory: cwd,
      refreshStatuses,
    });

    expect(state.mainMenuState.variant).toBe("emptyBootstrap");
    expect(state.mainMenuHint).toBe("Start failed (exit 2).");
    expect(refreshStatuses).not.toHaveBeenCalled();
  });
});
