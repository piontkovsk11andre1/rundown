// @ts-nocheck
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createContinueSceneState,
  handleContinueInput,
  primeContinuePreview,
  renderContinueSceneLines,
  updateContinueUiState,
} from "../../../src/presentation/tui/scenes/continue.ts";
import {
  createMainMenuSceneState,
  getMainMenuRows,
  getSelectedMainMenuItem,
  jumpMainMenuSelection,
  moveMainMenuSelection,
  refreshMainMenuStatusProbe,
  refreshVisibleMainMenuStatuses,
} from "../../../src/presentation/tui/scenes/main-menu.ts";
import {
  createNewWorkSceneState,
  generateNewWorkAgentPrompt,
  handleNewWorkSceneInput,
  loadNewWorkSceneState,
  openNewWorkRundownDirectory,
  renderNewWorkSceneLines,
  resetNewWorkWorkerHealth,
  startNewWorkSceneAction,
} from "../../../src/presentation/tui/scenes/new-work.ts";
import {
  createWorkersSceneState,
  handleWorkersInput,
  reloadWorkersSceneState,
  renderWorkersSceneLines,
  runWorkersSceneAction,
} from "../../../src/presentation/tui/scenes/workers.ts";
import {
  createHealthSceneState,
  handleHealthInput,
  reloadHealthSceneState,
  renderHealthSceneLines,
  runHealthSceneAction,
} from "../../../src/presentation/tui/scenes/health.ts";
import {
  createBuiltInsVisibilitySession,
  createToolsSceneState,
  openToolsScene,
  reloadToolsSceneState,
  renderToolsSceneLines,
} from "../../../src/presentation/tui/scenes/tools.ts";
import {
  createProfilesSceneState,
  handleProfilesInput,
  reloadProfilesSceneState,
  renderProfilesSceneLines,
  runProfilesSceneAction,
} from "../../../src/presentation/tui/scenes/profiles.ts";
import {
  createSettingsSceneState,
  handleSettingsInput,
  reloadSettingsSceneState,
  renderSettingsSceneLines,
  runSettingsSceneAction,
} from "../../../src/presentation/tui/scenes/settings.ts";
import {
  createHelpSceneState,
  handleHelpInput,
  renderHelpSceneLines,
  runHelpSceneAction,
} from "../../../src/presentation/tui/scenes/help.ts";
import {
  SPINNER_FRAMES,
  buildFrame,
  getSceneSpacing,
  renderStatusBadge,
} from "../../../src/presentation/tui/layout.ts";
import {
  applyOutputEvent,
  createInitialRunState,
  releaseApp,
} from "../../../src/presentation/tui/output-bridge.ts";
import {
  buildSceneLines as buildRootSceneLines,
  createSceneRouterState,
} from "../../../src/presentation/tui/index.ts";
import {
  ROW_IDS,
  createStatusProbeRegistry,
} from "../../../src/presentation/tui/status-probes.ts";
import type { ApplicationOutputEvent } from "../../../src/domain/ports/output-port.ts";

type SceneId =
  | "mainMenu"
  | "continue"
  | "newWork"
  | "workers"
  | "health"
  | "tools"
  | "profiles"
  | "settings"
  | "help";

export interface HarnessOptions {
  workspaceFiles?: Record<string, string>;
  configJson?: object;
  workerHealthJson?: object;
  initialScene?: SceneId;
  emptyWorkspace?: boolean;
}

export interface HarnessResult {
  press(keys: string | string[]): Promise<void>;
  emit(event: ApplicationOutputEvent): Promise<void>;
  frame(): string;
  rawFrame(): string;
  sceneStack(): SceneId[];
  pendingProbes(): string[];
}

function stripAnsi(value: string): string {
  return String(value).replace(/\u001B\[[0-9;]*m/g, "");
}

function normalizeKeyToken(key: string): string {
  const token = String(key);
  const normalized = token.toLowerCase();
  if (normalized === "enter") {
    return "\n";
  }
  if (normalized === "esc" || normalized === "escape") {
    return "\u001b";
  }
  if (normalized === "up" || normalized === "arrowup") {
    return "\u001b[A";
  }
  if (normalized === "down" || normalized === "arrowdown") {
    return "\u001b[B";
  }
  if (normalized === "backspace") {
    return "\u007f";
  }
  if (normalized === "tab") {
    return "\t";
  }
  if (normalized === "ctrl+c") {
    return "\u0003";
  }
  return token;
}

function toKeySequence(keys: string | string[]): string[] {
  if (Array.isArray(keys)) {
    return keys.map((key) => normalizeKeyToken(key));
  }
  return [normalizeKeyToken(keys)];
}

function writeWorkspaceFile(rootDir: string, relativePath: string, content: string): void {
  const normalizedRelativePath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const absolutePath = path.join(rootDir, normalizedRelativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content, "utf8");
}

function createWorkspace(options: HarnessOptions): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "rundown-tui-harness-"));

  if (!options.emptyWorkspace) {
    fs.mkdirSync(path.join(rootDir, "design"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "specs"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "migrations"), { recursive: true });
    writeWorkspaceFile(rootDir, ".rundown/config.json", `${JSON.stringify({ workspace: {} }, null, 2)}\n`);
    writeWorkspaceFile(rootDir, "README.md", "# Test Workspace\n");
    writeWorkspaceFile(rootDir, "roadmap.md", "- [ ] test task\n");
    writeWorkspaceFile(rootDir, "docs/getting-started.md", "# Getting Started\n");
  }

  const files = options.workspaceFiles ?? {};
  for (const [relativePath, content] of Object.entries(files)) {
    writeWorkspaceFile(rootDir, relativePath, String(content ?? ""));
  }

  if (options.configJson && typeof options.configJson === "object") {
    writeWorkspaceFile(rootDir, ".rundown/config.json", `${JSON.stringify(options.configJson, null, 2)}\n`);
  }
  if (options.workerHealthJson && typeof options.workerHealthJson === "object") {
    writeWorkspaceFile(rootDir, ".rundown/worker-health.json", `${JSON.stringify(options.workerHealthJson, null, 2)}\n`);
  }

  return rootDir;
}

function isArrowUp(rawInput: string): boolean {
  return rawInput === "\u001b[A";
}

function isArrowDown(rawInput: string): boolean {
  return rawInput === "\u001b[B";
}

function isBack(rawInput: string): boolean {
  return rawInput === "\u001b" || rawInput === "\b" || rawInput === "\u007f";
}

export async function createTuiHarness(options: HarnessOptions = {}): Promise<HarnessResult> {
  const currentWorkingDirectory = createWorkspace(options);
  const viewportRows = 42;
  const viewportColumns = 120;

  const pendingProbeSet = new Set<string>();
  const staticProbes = Object.fromEntries(
    ROW_IDS.map((rowId) => [rowId, async () => ({ text: "ready", tone: "ok" })]),
  );
  const baseProbeRegistry = createStatusProbeRegistry({ probes: staticProbes, now: Date.now });
  const probeRegistry = {
    getProbeStatus: (rowId: string) => baseProbeRegistry.getProbeStatus(rowId),
    refreshProbe: async (rowId: string) => {
      pendingProbeSet.add(rowId);
      try {
        return await baseProbeRegistry.refreshProbe(rowId);
      } finally {
        pendingProbeSet.delete(rowId);
      }
    },
    refreshAllProbes: async () => {
      await Promise.all(ROW_IDS.map((rowId) => probeRegistry.refreshProbe(rowId)));
    },
    getTtl: (rowId: string) => baseProbeRegistry.getTtl(rowId),
  };

  const state = createSceneRouterState({ currentWorkingDirectory });

  let frameIndex = 0;
  let lastRawFrame = "";
  const pendingOps = new Set<Promise<unknown>>();

  function track(promise: Promise<unknown>): void {
    pendingOps.add(promise);
    void promise.finally(() => {
      pendingOps.delete(promise);
    });
  }

  async function settle(): Promise<void> {
    let safety = 0;
    while ((pendingOps.size > 0 || pendingProbeSet.size > 0) && safety < 25) {
      safety += 1;
      if (pendingOps.size > 0) {
        await Promise.allSettled(Array.from(pendingOps));
      }
      if (pendingProbeSet.size > 0) {
        await Promise.resolve();
      }
    }
  }

  function pushScene(sceneId: SceneId): void {
    state.sceneStack.push(sceneId);
    state.sceneId = sceneId;
  }

  function popScene(): void {
    if (state.sceneStack.length <= 1) {
      state.sceneStack = ["mainMenu"];
      state.sceneId = "mainMenu";
      return;
    }
    state.sceneStack.pop();
    state.sceneId = state.sceneStack[state.sceneStack.length - 1] ?? "mainMenu";
  }

  function resetToMainMenu(): void {
    state.sceneStack = ["mainMenu"];
    state.sceneId = "mainMenu";
    state.showHelpOverlay = false;
    state.mainMenuState = createMainMenuSceneState();
    state.continueUiState = "previewing";
    state.continueSceneState = createContinueSceneState();
    state.newWorkSceneState = createNewWorkSceneState();
    state.runState = createInitialRunState();
    track(refreshMainMenuStatusProbe("continue", { probeRegistry }));
  }

  function applySharedNavigationGrammar(rawInput: string): boolean {
    const input = String(rawInput).toLowerCase();
    if (isArrowUp(rawInput) || input === "k") {
      state.mainMenuState = moveMainMenuSelection(state.mainMenuState, -1);
      return true;
    }
    if (isArrowDown(rawInput) || input === "j") {
      state.mainMenuState = moveMainMenuSelection(state.mainMenuState, 1);
      return true;
    }
    if (/^[1-9]$/.test(input)) {
      state.mainMenuState = jumpMainMenuSelection(state.mainMenuState, input);
      return true;
    }
    return false;
  }

  function openNewWorkScene(): void {
    state.sceneId = "newWork";
    state.showHelpOverlay = false;
    state.mainMenuHint = "";
    state.newWorkSceneState = createNewWorkSceneState();
    const promise = loadNewWorkSceneState({ currentWorkingDirectory }).then((nextState) => {
      if (state.sceneId === "newWork") {
        state.newWorkSceneState = nextState;
      }
    });
    track(promise);
  }

  function openWorkersScene(): void {
    pushScene("workers");
    state.showHelpOverlay = false;
    state.workersSceneState = {
      ...createWorkersSceneState(),
      loading: true,
      banner: "",
    };
    const promise = reloadWorkersSceneState({
      state: state.workersSceneState,
      currentWorkingDirectory,
    }).then((nextState) => {
      if (state.sceneId === "workers") {
        state.workersSceneState = nextState;
      }
    });
    track(promise);
  }

  function openHealthScene(): void {
    pushScene("health");
    state.showHelpOverlay = false;
    state.healthSceneState = {
      ...createHealthSceneState(),
      loading: true,
      banner: "",
    };
    const promise = reloadHealthSceneState({
      state: state.healthSceneState,
      currentWorkingDirectory,
    }).then((nextState) => {
      if (state.sceneId === "health") {
        state.healthSceneState = nextState;
      }
    });
    track(promise);
  }

  function openToolsSceneFromWorkers(): void {
    pushScene("tools");
    state.showHelpOverlay = false;
    state.toolsSceneState = openToolsScene({
      session: state.toolsBuiltInsVisibilitySession,
      state: {
        ...createToolsSceneState(),
        loading: true,
        banner: "",
      },
    });
    const promise = reloadToolsSceneState({
      state: state.toolsSceneState,
      currentWorkingDirectory,
    }).then((nextState) => {
      if (state.sceneId === "tools") {
        state.toolsSceneState = nextState;
      }
    }).catch((error) => {
      if (state.sceneId === "tools") {
        state.toolsSceneState = {
          ...state.toolsSceneState,
          loading: false,
          banner: error instanceof Error ? error.message : String(error),
        };
      }
    });
    track(promise);
  }

  function openSettingsScene(): void {
    state.sceneId = "settings";
    state.sceneStack = ["mainMenu", "settings"];
    state.showHelpOverlay = false;
    state.settingsSceneState = {
      ...createSettingsSceneState(),
      loading: true,
      banner: "",
    };
    const promise = reloadSettingsSceneState({
      state: state.settingsSceneState,
      currentWorkingDirectory,
    }).then((nextState) => {
      if (state.sceneId === "settings") {
        state.settingsSceneState = nextState;
      }
    });
    track(promise);
  }

  function openProfilesScene(): void {
    pushScene("profiles");
    state.showHelpOverlay = false;
    state.profilesSceneState = {
      ...createProfilesSceneState(),
      loading: true,
      banner: "",
    };
    const promise = reloadProfilesSceneState({
      state: state.profilesSceneState,
      currentWorkingDirectory,
    }).then((nextState) => {
      if (state.sceneId === "profiles") {
        state.profilesSceneState = nextState;
      }
    }).catch((error) => {
      if (state.sceneId === "profiles") {
        state.profilesSceneState = {
          ...state.profilesSceneState,
          loading: false,
          banner: error instanceof Error ? error.message : String(error),
        };
      }
    });
    track(promise);
  }

  function routeFromMainMenu(routeTo: SceneId): void {
    state.showHelpOverlay = false;
    if (routeTo === "continue") {
      state.sceneId = "continue";
      state.sceneStack = ["mainMenu", "continue"];
      state.continueUiState = "previewing";
      state.continueSceneState = {
        ...createContinueSceneState(),
        estimationPending: true,
        uiHint: "Loading task list...",
      };
      state.runState = createInitialRunState();
      track(
        primeContinuePreview(state.continueSceneState, currentWorkingDirectory).then((nextState) => {
          if (state.sceneId === "continue") {
            state.continueSceneState = nextState;
          }
        }),
      );
      return;
    }
    if (routeTo === "newWork") {
      state.sceneStack = ["mainMenu", "newWork"];
      openNewWorkScene();
      return;
    }
    if (routeTo === "workers") {
      openWorkersScene();
      return;
    }
    if (routeTo === "profiles") {
      openProfilesScene();
      return;
    }
    if (routeTo === "settings") {
      openSettingsScene();
      return;
    }
    if (routeTo === "help") {
      state.sceneId = routeTo;
      state.sceneStack = ["mainMenu", routeTo];
    }
  }

  function renderFrameNow(): void {
    const spinner = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    const spacing = getSceneSpacing(viewportRows);
    const statusToken = renderStatusBadge(state.sceneId, state.continueUiState, spinner, state.agentSessionPending);
    const sceneLines = buildRootSceneLines(state, spacing, currentWorkingDirectory, viewportColumns);
    const lines = buildFrame({
      sceneId: state.sceneId,
      statusToken,
      viewportRows,
      viewportColumns,
      mainMenuRows: getMainMenuRows(state.mainMenuState, { probeRegistry }),
      mainMenuHint: state.mainMenuHint,
      showHelpOverlay: state.showHelpOverlay,
      sceneLines,
    });
    lastRawFrame = lines.join("\n");
    frameIndex += 1;
    state.continueUiState = updateContinueUiState(state.continueUiState, state.runState);
  }

  function onInput(rawInput: string): void {
    const input = rawInput.toLowerCase();
    const isEnter = rawInput === "\r" || rawInput === "\n";

    if (rawInput === "\u0003" || input === "q") {
      void releaseApp(state.runState.app).then(() => {
        state.runState.app = null;
      });
      return;
    }

    if (input === "?" || input === "h") {
      state.showHelpOverlay = !state.showHelpOverlay;
      return;
    }

    if (state.showHelpOverlay) {
      if (isBack(rawInput) || input === "?" || input === "h") {
        state.showHelpOverlay = false;
      }
      return;
    }

    const sharedNavigationHandled = applySharedNavigationGrammar(rawInput);

    if (state.sceneId === "mainMenu") {
      state.mainMenuHint = "";
      if (input === "r") {
        track(refreshVisibleMainMenuStatuses(state.mainMenuState, { probeRegistry }));
        return;
      }
      if (isEnter) {
        const selected = getSelectedMainMenuItem(state.mainMenuState);
        if (selected?.sceneId) {
          routeFromMainMenu(selected.sceneId);
        }
        return;
      }
      if (sharedNavigationHandled) {
        return;
      }
    }

    if (state.sceneId === "continue") {
      const promise = handleContinueInput({
        rawInput,
        uiState: state.continueUiState,
        state: state.continueSceneState,
        runState: state.runState,
        currentWorkingDirectory,
      }).then((result) => {
        if (result?.handled) {
          state.continueUiState = result.uiState;
          state.continueSceneState = result.state;
          state.runState = result.runState;
          if (result.backToParent) {
            return releaseApp(state.runState.app).finally(() => {
              state.runState.app = null;
              resetToMainMenu();
            });
          }
          return;
        }
        if (isBack(rawInput)) {
          return releaseApp(state.runState.app).finally(() => {
            state.runState.app = null;
            resetToMainMenu();
          });
        }
      });
      track(promise);
      return;
    }

    if (state.sceneId === "newWork") {
      const result = handleNewWorkSceneInput({ rawInput, state: state.newWorkSceneState });
      state.newWorkSceneState = result.state;

      if (result.backToParent || isBack(rawInput)) {
        state.sceneId = "mainMenu";
        state.sceneStack = ["mainMenu"];
        state.newWorkSceneState = createNewWorkSceneState();
        track(refreshMainMenuStatusProbe("newWork", { probeRegistry }));
        return;
      }

      const action = result.action;
      if (action?.type === "start-agent") {
        state.agentSessionPending = true;
        state.sceneId = "newWork";
        state.showHelpOverlay = false;
        state.mainMenuHint = "";
        state.runState = createInitialRunState();

        const promise = startNewWorkSceneAction({
          actionKey: action.actionKey,
          currentWorkingDirectory,
          runState: state.runState,
          teardownTuiForWorker: () => {},
          restoreTuiAfterWorker: () => {},
          releaseApp,
        }).then((startResult) => {
          state.agentSessionPending = false;
          if (!startResult.started) {
            state.newWorkSceneState = {
              loading: false,
              readiness: startResult.readiness,
              hint: startResult.hint,
            };
            return;
          }
          state.mainMenuHint = state.runState.exitCode === 0
            ? "New Work session ended."
            : `New Work failed (exit ${state.runState.exitCode ?? "?"}).`;
          state.sceneId = "mainMenu";
          state.sceneStack = ["mainMenu"];
          state.newWorkSceneState = createNewWorkSceneState();
          return refreshMainMenuStatusProbe("newWork", { probeRegistry });
        });
        track(promise);
        return;
      }

      if (action?.type === "generate-agent-template") {
        const promise = Promise.resolve()
          .then(() => {
            state.newWorkSceneState = {
              ...state.newWorkSceneState,
              loading: true,
              hint: "Generating .rundown/agent.md from template...",
            };
            return generateNewWorkAgentPrompt({ currentWorkingDirectory });
          })
          .then(() => {
            state.newWorkSceneState = {
              ...state.newWorkSceneState,
              loading: true,
              hint: "Generated .rundown/agent.md. Re-checking...",
            };
            return loadNewWorkSceneState({ currentWorkingDirectory });
          })
          .then((nextState) => {
            state.newWorkSceneState = nextState;
            return refreshMainMenuStatusProbe("newWork", { probeRegistry });
          })
          .catch((error) => {
            state.newWorkSceneState = {
              ...state.newWorkSceneState,
              loading: false,
              hint: `Failed to generate .rundown/agent.md: ${error instanceof Error ? error.message : String(error)}`,
            };
          });
        track(promise);
        return;
      }

      if (action?.type === "open-rundown-directory") {
        try {
          openNewWorkRundownDirectory({ currentWorkingDirectory });
          state.newWorkSceneState = {
            ...state.newWorkSceneState,
            hint: "Opened .rundown/ in your editor.",
          };
        } catch (error) {
          state.newWorkSceneState = {
            ...state.newWorkSceneState,
            hint: `Failed to open .rundown/: ${error instanceof Error ? error.message : String(error)}`,
          };
        }
        return;
      }

      if (action?.type === "reset-worker-health") {
        const promise = resetNewWorkWorkerHealth({ currentWorkingDirectory })
          .then(({ removedEntries }) => {
            state.newWorkSceneState = {
              ...state.newWorkSceneState,
              loading: true,
              hint: `Reset worker health (${removedEntries} entries). Re-checking...`,
            };
            return loadNewWorkSceneState({ currentWorkingDirectory });
          })
          .then((nextState) => {
            state.newWorkSceneState = nextState;
            return refreshMainMenuStatusProbe("newWork", { probeRegistry });
          })
          .catch((error) => {
            state.newWorkSceneState = {
              ...state.newWorkSceneState,
              loading: false,
              hint: `Failed to reset worker health: ${error instanceof Error ? error.message : String(error)}`,
            };
          });
        track(promise);
      }
      return;
    }

    if (state.sceneId === "workers") {
      const result = handleWorkersInput({ rawInput, state: state.workersSceneState });
      state.workersSceneState = result.state;
      if (result.backToParent || isBack(rawInput)) {
        popScene();
        state.workersActionPending = false;
        state.workersSceneState = {
          ...state.workersSceneState,
          pendingGlobalBootstrap: false,
        };
        return;
      }
      if (result.action?.type === "open-health") {
        openHealthScene();
        return;
      }
      if (result.action?.type === "open-tools") {
        openToolsSceneFromWorkers();
        return;
      }
      if (result.action && !state.workersActionPending) {
        state.workersActionPending = true;
        const promise = runWorkersSceneAction({
          action: result.action,
          state: state.workersSceneState,
          currentWorkingDirectory,
          suspendTui: () => {},
          resumeTui: () => {},
        }).then((nextState) => {
          state.workersSceneState = nextState;
        }).catch((error) => {
          state.workersSceneState = {
            ...state.workersSceneState,
            loading: false,
            pendingGlobalBootstrap: false,
            banner: error instanceof Error ? error.message : String(error),
          };
        }).finally(() => {
          state.workersActionPending = false;
        });
        track(promise);
      }
      return;
    }

    if (state.sceneId === "health") {
      const result = handleHealthInput({ rawInput, state: state.healthSceneState });
      state.healthSceneState = result.state;
      if (result.backToParent || isBack(rawInput)) {
        state.healthActionPending = false;
        popScene();
        return;
      }
      if (result.action && !state.healthActionPending) {
        state.healthActionPending = true;
        const promise = runHealthSceneAction({
          action: result.action,
          state: state.healthSceneState,
          currentWorkingDirectory,
          suspendTui: () => {},
          resumeTui: () => {},
        }).then((nextState) => {
          state.healthSceneState = nextState;
        }).catch((error) => {
          state.healthSceneState = {
            ...state.healthSceneState,
            loading: false,
            banner: error instanceof Error ? error.message : String(error),
          };
        }).finally(() => {
          state.healthActionPending = false;
        });
        track(promise);
      }
      return;
    }

    if (state.sceneId === "tools") {
      if (isBack(rawInput)) {
        state.toolsActionPending = false;
        popScene();
      }
      return;
    }

    if (state.sceneId === "profiles") {
      const result = handleProfilesInput({ rawInput, state: state.profilesSceneState });
      state.profilesSceneState = result.state;
      if (result.backToParent || (!result.handled && isBack(rawInput))) {
        state.profilesActionPending = false;
        popScene();
        return;
      }
      if (result.action && !state.profilesActionPending) {
        state.profilesActionPending = true;
        const promise = runProfilesSceneAction({
          action: result.action,
          state: state.profilesSceneState,
          currentWorkingDirectory,
        }).then((nextState) => {
          state.profilesSceneState = nextState;
        }).catch((error) => {
          state.profilesSceneState = {
            ...state.profilesSceneState,
            loading: false,
            banner: error instanceof Error ? error.message : String(error),
          };
        }).finally(() => {
          state.profilesActionPending = false;
        });
        track(promise);
      }
      return;
    }

    if (state.sceneId === "settings") {
      const result = handleSettingsInput({ rawInput, state: state.settingsSceneState });
      state.settingsSceneState = result.state;
      if (result.backToParent || isBack(rawInput)) {
        state.sceneId = "mainMenu";
        state.sceneStack = ["mainMenu"];
      }
      if (result.action && !state.settingsActionPending) {
        state.settingsActionPending = true;
        const promise = runSettingsSceneAction({
          action: result.action,
          state: state.settingsSceneState,
          currentWorkingDirectory,
          suspendTui: () => {},
          resumeTui: () => {},
        }).then((nextState) => {
          state.settingsSceneState = nextState;
        }).catch((error) => {
          state.settingsSceneState = {
            ...state.settingsSceneState,
            loading: false,
            banner: error instanceof Error ? error.message : String(error),
          };
        }).finally(() => {
          state.settingsActionPending = false;
        });
        track(promise);
      }
      return;
    }

    if (state.sceneId === "help") {
      const result = handleHelpInput({ rawInput, state: state.helpSceneState });
      state.helpSceneState = result.state;
      if (result.backToParent || isBack(rawInput)) {
        state.sceneId = "mainMenu";
        state.sceneStack = ["mainMenu"];
      }
      if (result.action && !state.helpActionPending) {
        state.helpActionPending = true;
        const promise = runHelpSceneAction({
          action: result.action,
          state: state.helpSceneState,
          suspendTui: () => {},
          resumeTui: () => {},
        }).then((nextState) => {
          state.helpSceneState = nextState;
        }).finally(() => {
          state.helpActionPending = false;
        });
        track(promise);
      }
    }
  }

  const initialScene = options.initialScene ?? "mainMenu";
  if (initialScene !== "mainMenu") {
    if (initialScene === "workers") {
      openWorkersScene();
    } else if (initialScene === "health") {
      openWorkersScene();
      openHealthScene();
    } else if (initialScene === "tools") {
      openWorkersScene();
      openToolsSceneFromWorkers();
    } else if (initialScene === "newWork") {
      state.sceneStack = ["mainMenu", "newWork"];
      openNewWorkScene();
    } else if (initialScene === "continue") {
      routeFromMainMenu("continue");
    } else if (initialScene === "settings") {
      openSettingsScene();
    } else if (initialScene === "profiles") {
      openProfilesScene();
    } else if (initialScene === "help") {
      state.sceneId = "help";
      state.sceneStack = ["mainMenu", "help"];
    }
  }

  await settle();
  renderFrameNow();
  await settle();
  renderFrameNow();

  return {
    async press(keys: string | string[]) {
      const sequence = toKeySequence(keys);
      for (const key of sequence) {
        onInput(key);
        await settle();
        renderFrameNow();
      }
    },
    async emit(event: ApplicationOutputEvent) {
      applyOutputEvent(state.runState, event);
      state.continueUiState = updateContinueUiState(state.continueUiState, state.runState);
      await settle();
      renderFrameNow();
    },
    frame() {
      return stripAnsi(lastRawFrame);
    },
    rawFrame() {
      return lastRawFrame;
    },
    sceneStack() {
      return [...state.sceneStack];
    },
    pendingProbes() {
      return [...pendingProbeSet].sort();
    },
  };
}
