// @ts-nocheck
import { Command, InvalidArgumentError } from "commander";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createContinueSceneState,
  handleContinueInput,
  primeContinuePreview,
  renderContinueSceneLines,
  updateContinueUiState,
} from "./scenes/continue.ts";
import {
  createMainMenuSceneState,
  getMainMenuRows,
  getSelectedMainMenuItem,
  jumpMainMenuSelection,
  moveMainMenuSelection,
  refreshMainMenuStatusProbe,
  refreshVisibleMainMenuStatuses,
} from "./scenes/main-menu.ts";
import type { MainMenuSceneId, MainMenuState } from "./scenes/main-menu.ts";
import { detectRootWorkspaceState, type RootWorkspaceState } from "./root-workspace-state.ts";
import {
  createNewWorkSceneState,
  generateNewWorkAgentPrompt,
  handleNewWorkSceneInput,
  loadNewWorkSceneState,
  openNewWorkRundownDirectory,
  renderNewWorkSceneLines,
  resetNewWorkWorkerHealth,
  startNewWorkSceneAction,
} from "./scenes/new-work.ts";
import {
  createWorkersSceneState,
  handleWorkersInput,
  reloadWorkersSceneState,
  renderWorkersSceneLines,
  runWorkersSceneAction,
} from "./scenes/workers.ts";
import {
  createHealthSceneState,
  handleHealthInput,
  reloadHealthSceneState,
  renderHealthSceneLines,
  runHealthSceneAction,
} from "./scenes/health.ts";
import {
  createBuiltInsVisibilitySession,
  createToolsSceneState,
  openToolsScene,
  reloadToolsSceneState,
  renderToolsSceneLines,
} from "./scenes/tools.ts";
import {
  createProfilesSceneState,
  handleProfilesInput,
  reloadProfilesSceneState,
  renderProfilesSceneLines,
  runProfilesSceneAction,
} from "./scenes/profiles.ts";
import {
  createSettingsSceneState,
  handleSettingsInput,
  reloadSettingsSceneState,
  renderSettingsSceneLines,
  runSettingsSceneAction,
} from "./scenes/settings.ts";
import {
  createHelpSceneState,
  handleHelpInput,
  renderHelpSceneLines,
  runHelpSceneAction,
} from "./scenes/help.ts";
import {
  DEFAULT_WORKSPACE_DIRECTORIES,
  DEFAULT_WORKSPACE_PLACEMENT,
} from "../../application/workspace-paths.js";
import { SPINNER_FRAMES, buildFrame, getSceneSpacing, render, renderStatusBadge, withCursorHidden } from "./layout.ts";
import { createInitialRunState, releaseApp, resolveProcessArgv } from "./output-bridge.ts";

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

type ContinueState = ReturnType<typeof createContinueSceneState>;
type ContinueUiState = "previewing" | "running" | "done";
type SceneStack = SceneId[];

type SceneRouterState = {
  sceneId: SceneId;
  sceneStack: SceneStack;
  showHelpOverlay: boolean;
  mainMenuHint: string;
  mainMenuState: MainMenuState;
  continueUiState: ContinueUiState;
  continueSceneState: ContinueState;
  runState: ReturnType<typeof createInitialRunState>;
  workersSceneState: any;
  healthSceneState: any;
  toolsSceneState: any;
  toolsBuiltInsVisibilitySession: ReturnType<typeof createBuiltInsVisibilitySession>;
  profilesSceneState: any;
  settingsSceneState: any;
  helpSceneState: any;
  newWorkSceneState: any;
  agentSessionPending: boolean;
  workersActionPending: boolean;
  healthActionPending: boolean;
  toolsActionPending: boolean;
  settingsActionPending: boolean;
  profilesActionPending: boolean;
  helpActionPending: boolean;
  startActionPending: boolean;
  rootWorkspaceState: RootWorkspaceState;
};

function resolveMainMenuVariantFromWorkspaceState(workspaceState: RootWorkspaceState): "emptyBootstrap" | "initialized" {
  return workspaceState.isEmptyBootstrap ? "emptyBootstrap" : "initialized";
}

function refreshRootWorkspaceState(state: SceneRouterState, cwd: string): RootWorkspaceState {
  const nextState = detectRootWorkspaceState(cwd);
  state.rootWorkspaceState = nextState;
  state.mainMenuState = {
    ...state.mainMenuState,
    variant: resolveMainMenuVariantFromWorkspaceState(nextState),
  };
  return nextState;
}

export async function runMainMenuStartAction({
  state,
  app,
  currentWorkingDirectory,
  refreshStatuses,
}: {
  state: SceneRouterState;
  app: unknown;
  currentWorkingDirectory: string;
  refreshStatuses?: () => Promise<void>;
}): Promise<void> {
  if (!app || typeof app !== "object" || typeof app.startProject !== "function") {
    state.mainMenuHint = "Start unavailable: app.startProject is not configured.";
    return;
  }

  state.mainMenuHint = "Starting workspace...";

  try {
    const exitCode = await app.startProject({
      designDir: DEFAULT_WORKSPACE_DIRECTORIES.design,
      specsDir: DEFAULT_WORKSPACE_DIRECTORIES.specs,
      migrationsDir: DEFAULT_WORKSPACE_DIRECTORIES.migrations,
      designPlacement: DEFAULT_WORKSPACE_PLACEMENT.design,
      specsPlacement: DEFAULT_WORKSPACE_PLACEMENT.specs,
      migrationsPlacement: DEFAULT_WORKSPACE_PLACEMENT.migrations,
    });
    if (exitCode === 0) {
      const workspaceState = refreshRootWorkspaceState(state, currentWorkingDirectory);
      state.mainMenuState = createMainMenuSceneState({
        variant: resolveMainMenuVariantFromWorkspaceState(workspaceState),
      });
      state.sceneStack = ["mainMenu"];
      state.sceneId = "mainMenu";
      state.mainMenuHint = workspaceState.isEmptyBootstrap
        ? "Start completed, but workspace is still not initialized."
        : "Workspace initialized.";
      if (typeof refreshStatuses === "function") {
        await refreshStatuses();
      } else {
        await refreshVisibleMainMenuStatuses(state.mainMenuState);
      }
      return;
    }

    state.mainMenuHint = exitCode === 130
      ? "Start cancelled."
      : `Start failed (exit ${exitCode}).`;
  } catch (error) {
    state.mainMenuHint = `Start failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseFps(value: unknown): number {
  const parsed = parsePositiveInteger(value, "FPS");
  if (parsed > 60) {
    throw new InvalidArgumentError("FPS must be <= 60.");
  }
  return parsed;
}

export function createSceneRouterState({ currentWorkingDirectory = process.cwd() }: { currentWorkingDirectory?: string } = {}): SceneRouterState {
  const rootWorkspaceState = detectRootWorkspaceState(currentWorkingDirectory);
  return {
    sceneId: "mainMenu",
    sceneStack: ["mainMenu"],
    showHelpOverlay: false,
    mainMenuHint: "",
    mainMenuState: createMainMenuSceneState({
      variant: resolveMainMenuVariantFromWorkspaceState(rootWorkspaceState),
    }),
    continueUiState: "previewing",
    continueSceneState: createContinueSceneState(),
    runState: createInitialRunState(),
    workersSceneState: createWorkersSceneState(),
    healthSceneState: createHealthSceneState(),
    toolsSceneState: createToolsSceneState(),
    toolsBuiltInsVisibilitySession: createBuiltInsVisibilitySession(),
    profilesSceneState: createProfilesSceneState(),
    settingsSceneState: createSettingsSceneState(),
    helpSceneState: createHelpSceneState(currentWorkingDirectory),
    newWorkSceneState: createNewWorkSceneState(),
    agentSessionPending: false,
    workersActionPending: false,
    healthActionPending: false,
    toolsActionPending: false,
    settingsActionPending: false,
    profilesActionPending: false,
    helpActionPending: false,
    startActionPending: false,
    rootWorkspaceState,
  };
}

function pushScene(state: SceneRouterState, sceneId: SceneId): void {
  state.sceneStack.push(sceneId);
  state.sceneId = sceneId;
}

function popScene(state: SceneRouterState): void {
  if (state.sceneStack.length <= 1) {
    state.sceneStack = ["mainMenu"];
    state.sceneId = "mainMenu";
    return;
  }
  state.sceneStack.pop();
  state.sceneId = state.sceneStack[state.sceneStack.length - 1] ?? "mainMenu";
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

function resetToMainMenu(state: SceneRouterState, cwd: string): void {
  state.sceneStack = ["mainMenu"];
  state.sceneId = "mainMenu";
  state.showHelpOverlay = false;
  const workspaceState = refreshRootWorkspaceState(state, cwd);
  state.mainMenuState = createMainMenuSceneState({
    variant: resolveMainMenuVariantFromWorkspaceState(workspaceState),
  });
  state.continueUiState = "previewing";
  state.continueSceneState = createContinueSceneState();
  state.newWorkSceneState = createNewWorkSceneState();
  state.runState = createInitialRunState();
  void refreshMainMenuStatusProbe("continue");
}

function routeFromMainMenu(
  state: SceneRouterState,
  routeTo: MainMenuSceneId,
  openNewWorkScene: () => void,
  openWorkersScene: () => void,
  openProfilesScene: () => void,
  openSettingsScene: () => void,
  runStartAction: () => void,
): void {
  state.showHelpOverlay = false;
  if (routeTo === "start") {
    runStartAction();
    return;
  }
  if (routeTo === "continue") {
    state.sceneId = "continue";
    state.continueUiState = "previewing";
    state.continueSceneState = {
      ...createContinueSceneState(),
      estimationPending: true,
      uiHint: "Loading task list...",
    };
    state.runState = createInitialRunState();
    void primeContinuePreview(state.continueSceneState, process.cwd()).then((nextState) => {
      state.continueSceneState = nextState;
    });
    return;
  }
  if (routeTo === "newWork") {
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
  }
}

function applySharedNavigationGrammar(state: SceneRouterState, rawInput: string): boolean {
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

export function buildSceneLines(
  state: SceneRouterState,
  spacing: { sectionGap: number; hintGap: number; errorGap: number },
  currentWorkingDirectory: string,
  viewportColumns: number | undefined,
): string[] {
  if (state.sceneId === "continue") {
    return renderContinueSceneLines({
      uiState: state.continueUiState,
      state: state.continueSceneState,
      runState: state.runState,
      currentWorkingDirectory,
      sectionGap: spacing.sectionGap,
      hintGap: spacing.hintGap,
      errorGap: spacing.errorGap,
    });
  }
  if (state.sceneId === "newWork") {
    return renderNewWorkSceneLines({
      state: state.newWorkSceneState,
      sectionGap: spacing.sectionGap,
    });
  }
  if (state.sceneId === "workers") {
    return renderWorkersSceneLines({ state: state.workersSceneState, sectionGap: spacing.sectionGap });
  }
  if (state.sceneId === "health") {
    return renderHealthSceneLines({ state: state.healthSceneState, sectionGap: spacing.sectionGap });
  }
  if (state.sceneId === "tools") {
    return renderToolsSceneLines({ state: state.toolsSceneState, sectionGap: spacing.sectionGap });
  }
  if (state.sceneId === "profiles") {
    return renderProfilesSceneLines({ state: state.profilesSceneState, sectionGap: spacing.sectionGap });
  }
  if (state.sceneId === "settings") {
    return renderSettingsSceneLines({
      state: state.settingsSceneState,
      sectionGap: spacing.sectionGap,
      viewportColumns,
    });
  }
  if (state.sceneId === "help") {
    return renderHelpSceneLines({ state: state.helpSceneState, sectionGap: spacing.sectionGap });
  }
  return [];
}

export async function runRootTui(
  { app, workerPattern, cliVersion, argv }: { app?: unknown; workerPattern?: unknown; cliVersion?: unknown; argv?: string[] } = {},
) {
  void app;
  void workerPattern;
  void cliVersion;

  const program = new Command();
  program
    .name("tui")
    .description("Interactive TUI bound to the rundown app surface (createApp).")
    .allowUnknownOption(true)
    .option("--fps <n>", "Render frames per second", parseFps, 12);
  try {
    program.exitOverride();
    program.parse(resolveProcessArgv(argv));
  } catch (error) {
    const exitCode = typeof error?.exitCode === "number" ? error.exitCode : 1;
    return exitCode;
  }

  const opts = program.opts();
  const frameMs = Math.max(30, Math.round(1000 / opts.fps));
  const currentWorkingDirectory = process.cwd();

  return await new Promise((resolve) => {
    const state = createSceneRouterState({ currentWorkingDirectory });
    let settled = false;
    let finalized = false;
    let previousLineCount = 0;
    let frameIndex = 0;
    let interval: NodeJS.Timeout | undefined;

    const restoreCursor = withCursorHidden();

    const stopRender = () => {
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    };

    const startRender = () => {
      if (!interval) {
        interval = setInterval(renderFrame, frameMs);
      }
    };

    const teardownTuiForWorker = () => {
      stopRender();
      if (process.stdout.isTTY) {
        process.stdout.write("\u001B[?25h");
      }
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // ignore
        }
        process.stdin.pause();
        process.stdin.off("data", onInput);
      }
      previousLineCount = 0;
    };

    const restoreTuiAfterWorker = () => {
      if (process.stdout.isTTY) {
        process.stdout.write("\u001B[?25l");
      }
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(true);
        } catch {
          // ignore
        }
        process.stdin.resume();
        process.stdin.on("data", onInput);
      }
      startRender();
    };

    const cleanup = () => {
      if (finalized) {
        return;
      }
      finalized = true;
      restoreCursor();
      if (process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // ignore
        }
        process.stdin.pause();
        process.stdin.off("data", onInput);
      }
    };

    const finish = (exitCode: number, { newline = false }: { newline?: boolean } = {}) => {
      if (settled) {
        return;
      }
      settled = true;
      stopRender();
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      process.off("exit", cleanup);
      cleanup();
      if (newline) {
        process.stdout.write("\n");
      }
      resolve(exitCode);
    };

    let newWorkLoadToken = 0;
    let workersLoadToken = 0;
    let healthLoadToken = 0;
    let toolsLoadToken = 0;
    let settingsLoadToken = 0;
    let profilesLoadToken = 0;

    const runStartAction = () => {
      if (state.startActionPending) {
        return;
      }

      state.startActionPending = true;
      void runMainMenuStartAction({
        state,
        app,
        currentWorkingDirectory,
      })
        .finally(() => {
          state.startActionPending = false;
        });
    };

    const openNewWorkScene = () => {
      state.sceneId = "newWork";
      state.showHelpOverlay = false;
      state.mainMenuHint = "";
      state.newWorkSceneState = createNewWorkSceneState();
      const loadToken = ++newWorkLoadToken;
      void loadNewWorkSceneState({
        currentWorkingDirectory,
      }).then((nextState) => {
        if (loadToken !== newWorkLoadToken || state.sceneId !== "newWork") {
          return;
        }
        state.newWorkSceneState = nextState;
      });
    };

    const openWorkersScene = () => {
      pushScene(state, "workers");
      state.showHelpOverlay = false;
      state.workersSceneState = {
        ...createWorkersSceneState(),
        loading: true,
        banner: "",
      };

      const loadToken = ++workersLoadToken;
      void reloadWorkersSceneState({
        state: state.workersSceneState,
        currentWorkingDirectory,
      }).then((nextState) => {
        if (loadToken !== workersLoadToken || state.sceneId !== "workers") {
          return;
        }
        state.workersSceneState = nextState;
      });
    };

    const openHealthScene = () => {
      pushScene(state, "health");
      state.showHelpOverlay = false;
      state.healthSceneState = {
        ...createHealthSceneState(),
        loading: true,
        banner: "",
      };

      const loadToken = ++healthLoadToken;
      void reloadHealthSceneState({
        state: state.healthSceneState,
        currentWorkingDirectory,
      }).then((nextState) => {
        if (loadToken !== healthLoadToken || state.sceneId !== "health") {
          return;
        }
        state.healthSceneState = nextState;
      });
    };

    const openToolsSceneFromWorkers = () => {
      pushScene(state, "tools");
      state.showHelpOverlay = false;
      state.toolsSceneState = openToolsScene({
        session: state.toolsBuiltInsVisibilitySession,
        state: {
          ...createToolsSceneState(),
          loading: true,
          banner: "",
        },
      });

      const loadToken = ++toolsLoadToken;
      void reloadToolsSceneState({
        state: state.toolsSceneState,
        currentWorkingDirectory,
      }).then((nextState) => {
        if (loadToken !== toolsLoadToken || state.sceneId !== "tools") {
          return;
        }
        state.toolsSceneState = nextState;
      }).catch((error) => {
        if (loadToken !== toolsLoadToken || state.sceneId !== "tools") {
          return;
        }
        state.toolsSceneState = {
          ...state.toolsSceneState,
          loading: false,
          banner: error instanceof Error ? error.message : String(error),
        };
      });
    };

    const openSettingsScene = () => {
      state.sceneId = "settings";
      state.showHelpOverlay = false;
      state.settingsSceneState = {
        ...createSettingsSceneState(),
        loading: true,
        banner: "",
      };

      const loadToken = ++settingsLoadToken;
      void reloadSettingsSceneState({
        state: state.settingsSceneState,
        currentWorkingDirectory,
      }).then((nextState) => {
        if (loadToken !== settingsLoadToken || state.sceneId !== "settings") {
          return;
        }
        state.settingsSceneState = nextState;
      });
    };

    const openProfilesScene = () => {
      pushScene(state, "profiles");
      state.showHelpOverlay = false;
      state.profilesSceneState = {
        ...createProfilesSceneState(),
        loading: true,
        banner: "",
      };

      const loadToken = ++profilesLoadToken;
      void reloadProfilesSceneState({
        state: state.profilesSceneState,
        currentWorkingDirectory,
      }).then((nextState) => {
        if (loadToken !== profilesLoadToken || state.sceneId !== "profiles") {
          return;
        }
        state.profilesSceneState = nextState;
      }).catch((error) => {
        if (loadToken !== profilesLoadToken || state.sceneId !== "profiles") {
          return;
        }
        state.profilesSceneState = {
          ...state.profilesSceneState,
          loading: false,
          banner: error instanceof Error ? error.message : String(error),
        };
      });
    };

    const launchNewWork = async (actionKey: string) => {
      if (state.agentSessionPending) {
        return;
      }
      state.agentSessionPending = true;
      state.sceneId = "newWork";
      state.showHelpOverlay = false;
      state.mainMenuHint = "";
      state.runState = createInitialRunState();

      const result = await startNewWorkSceneAction({
        actionKey,
        currentWorkingDirectory,
        runState: state.runState,
        teardownTuiForWorker,
        restoreTuiAfterWorker,
        releaseApp,
      });

      state.agentSessionPending = false;
      if (!result.started) {
        state.newWorkSceneState = {
          loading: false,
          readiness: result.readiness,
          hint: result.hint,
        };
        return;
      }
      state.mainMenuHint = state.runState.exitCode === 0
        ? "New Work session ended."
        : `New Work failed (exit ${state.runState.exitCode ?? "?"}).`;
      state.sceneId = "mainMenu";
      state.newWorkSceneState = createNewWorkSceneState();
      void refreshMainMenuStatusProbe("newWork");
    };

    function onInput(chunk: Buffer | string) {
      const rawInput = String(chunk);
      const input = rawInput.toLowerCase();
      const isEnter = rawInput === "\r" || rawInput === "\n";

      if (rawInput === "\u0003") {
        stopRender();
        void releaseApp(state.runState.app).finally(() => {
          finish(130, { newline: true });
        });
        return;
      }

      if (input === "q") {
        stopRender();
        void releaseApp(state.runState.app).finally(() => {
          finish(0, { newline: true });
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

      const sharedNavigationHandled = applySharedNavigationGrammar(state, rawInput);

      if (state.sceneId === "mainMenu") {
        state.mainMenuHint = "";
        if (input === "r") {
          void refreshVisibleMainMenuStatuses(state.mainMenuState);
          return;
        }
        if (isEnter) {
          const selected = getSelectedMainMenuItem(state.mainMenuState);
          if (selected?.sceneId) {
            routeFromMainMenu(
              state,
              selected.sceneId,
              openNewWorkScene,
              openWorkersScene,
              openProfilesScene,
              openSettingsScene,
              runStartAction,
            );
          }
          return;
        }
        if (sharedNavigationHandled) {
          return;
        }
      }

      if (state.sceneId === "continue") {
        void handleContinueInput({
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
              void releaseApp(state.runState.app).finally(() => {
                state.runState.app = null;
                resetToMainMenu(state, currentWorkingDirectory);
              });
            }
            return;
          }
          if (isBack(rawInput)) {
            void releaseApp(state.runState.app).finally(() => {
              state.runState.app = null;
              resetToMainMenu(state, currentWorkingDirectory);
            });
          }
        });
        return;
      }

      if (state.sceneId === "newWork") {
        const result = handleNewWorkSceneInput({
          rawInput,
          state: state.newWorkSceneState,
        });
        state.newWorkSceneState = result.state;

        if (result.backToParent || isBack(rawInput)) {
          state.sceneId = "mainMenu";
          state.newWorkSceneState = createNewWorkSceneState();
          void refreshMainMenuStatusProbe("newWork");
          return;
        }

        const action = result.action;
        if (action?.type === "start-agent") {
          void launchNewWork(action.actionKey);
          return;
        }

        if (action?.type === "generate-agent-template") {
          state.newWorkSceneState = {
            ...state.newWorkSceneState,
            loading: true,
            hint: "Generating .rundown/agent.md from template...",
          };
          void Promise.resolve()
            .then(() => generateNewWorkAgentPrompt({ currentWorkingDirectory }))
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
              void refreshMainMenuStatusProbe("newWork");
            })
            .catch((error) => {
              state.newWorkSceneState = {
                ...state.newWorkSceneState,
                loading: false,
                hint: `Failed to generate .rundown/agent.md: ${error instanceof Error ? error.message : String(error)}`,
              };
            });
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
          state.newWorkSceneState = {
            ...state.newWorkSceneState,
            loading: true,
            hint: "Resetting worker health...",
          };
          void resetNewWorkWorkerHealth({ currentWorkingDirectory })
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
              void refreshMainMenuStatusProbe("newWork");
            })
            .catch((error) => {
              state.newWorkSceneState = {
                ...state.newWorkSceneState,
                loading: false,
                hint: `Failed to reset worker health: ${error instanceof Error ? error.message : String(error)}`,
              };
            });
        }
        return;
      }

      if (state.sceneId === "workers") {
        const result = handleWorkersInput({ rawInput, state: state.workersSceneState });
        state.workersSceneState = result.state;
        if (result.backToParent || isBack(rawInput)) {
          workersLoadToken += 1;
          popScene(state);
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
          void runWorkersSceneAction({
            action: result.action,
            state: state.workersSceneState,
            currentWorkingDirectory,
            suspendTui: teardownTuiForWorker,
            resumeTui: restoreTuiAfterWorker,
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
        }
        return;
      }

      if (state.sceneId === "health") {
        const result = handleHealthInput({ rawInput, state: state.healthSceneState });
        state.healthSceneState = result.state;
        if (result.backToParent || isBack(rawInput)) {
          healthLoadToken += 1;
          state.healthActionPending = false;
          popScene(state);
          return;
        }

        if (result.action && !state.healthActionPending) {
          state.healthActionPending = true;
          void runHealthSceneAction({
            action: result.action,
            state: state.healthSceneState,
            currentWorkingDirectory,
            suspendTui: teardownTuiForWorker,
            resumeTui: restoreTuiAfterWorker,
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
        }
        return;
      }

      if (state.sceneId === "tools") {
        if (isBack(rawInput)) {
          toolsLoadToken += 1;
          state.toolsActionPending = false;
          popScene(state);
        }
        return;
      }

      if (state.sceneId === "profiles") {
        const result = handleProfilesInput({ rawInput, state: state.profilesSceneState });
        state.profilesSceneState = result.state;
        if (result.backToParent || (!result.handled && isBack(rawInput))) {
          profilesLoadToken += 1;
          state.profilesActionPending = false;
          popScene(state);
          return;
        }

        if (result.action && !state.profilesActionPending) {
          state.profilesActionPending = true;
          void runProfilesSceneAction({
            action: result.action,
            state: state.profilesSceneState,
            currentWorkingDirectory,
            suspendTui: teardownTuiForWorker,
            resumeTui: restoreTuiAfterWorker,
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
        }
        return;
      }

      if (state.sceneId === "settings") {
        const result = handleSettingsInput({ rawInput, state: state.settingsSceneState });
        state.settingsSceneState = result.state;
        if (result.backToParent || isBack(rawInput)) {
          state.sceneId = "mainMenu";
        }

        if (result.action && !state.settingsActionPending) {
          state.settingsActionPending = true;
          void runSettingsSceneAction({
            action: result.action,
            state: state.settingsSceneState,
            currentWorkingDirectory,
            suspendTui: teardownTuiForWorker,
            resumeTui: restoreTuiAfterWorker,
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
        }
        return;
      }

      if (state.sceneId === "help") {
        const result = handleHelpInput({ rawInput, state: state.helpSceneState });
        state.helpSceneState = result.state;
        if (result.backToParent || isBack(rawInput)) {
          state.sceneId = "mainMenu";
        }

        if (result.action && !state.helpActionPending) {
          state.helpActionPending = true;
          void runHelpSceneAction({
            action: result.action,
            state: state.helpSceneState,
            suspendTui: teardownTuiForWorker,
            resumeTui: restoreTuiAfterWorker,
          }).then((nextState) => {
            state.helpSceneState = nextState;
          }).finally(() => {
            state.helpActionPending = false;
          });
        }
      }
    }

    const renderFrame = () => {
      const spinner = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
      const viewportRows = process.stdout.isTTY ? process.stdout.rows : undefined;
      const viewportColumns = process.stdout.isTTY ? process.stdout.columns : undefined;
      const spacing = getSceneSpacing(viewportRows);
      const statusToken = renderStatusBadge(state.sceneId, state.continueUiState, spinner, state.agentSessionPending);
      const sceneLines = buildSceneLines(state, spacing, currentWorkingDirectory, viewportColumns);
      const lines = buildFrame({
        sceneId: state.sceneId,
        statusToken,
        viewportRows,
        viewportColumns,
        mainMenuRows: getMainMenuRows(state.mainMenuState),
        mainMenuHint: state.mainMenuHint,
        showHelpOverlay: state.showHelpOverlay,
        sceneLines,
      });
      previousLineCount = render(lines, previousLineCount);
      frameIndex += 1;
      state.continueUiState = updateContinueUiState(state.continueUiState, state.runState);
    };

    if (process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(true);
      } catch {
        // ignore raw mode errors
      }
      process.stdin.resume();
      process.stdin.on("data", onInput);
    }

    startRender();

    const onSigint = () => {
      stopRender();
      void releaseApp(state.runState.app).finally(() => {
        finish(130, { newline: true });
      });
    };

    const onSigterm = () => {
      stopRender();
      void releaseApp(state.runState.app).finally(() => {
        finish(143);
      });
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    process.on("exit", cleanup);
  });
}

function isStandaloneTuiEntrypoint(entrypointPath: string | undefined): boolean {
  if (!entrypointPath) {
    return false;
  }

  const normalizedPath = path.normalize(entrypointPath).replace(/\\/g, "/").toLowerCase();
  return normalizedPath.endsWith("/presentation/tui/index.js")
    || normalizedPath.endsWith("/src/presentation/tui/index.ts");
}

if (isStandaloneTuiEntrypoint(process.argv[1]) && process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void runRootTui().then((exitCode) => {
    process.exit(exitCode);
  });
}
